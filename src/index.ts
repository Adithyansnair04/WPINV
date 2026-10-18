import { createProcessor, isDryRun } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
import { createTelegramApi, startTelegramPolling } from './telegram/bot.js';
import type { IncomingMessage, SendFn } from './types.js';

let send: SendFn = async () => undefined;
let cfg: Config;
let processor: ReturnType<typeof createProcessor>;
const log = createLogger((process.env.LOG_LEVEL as 'info') ?? 'info', { app: 'wpinv' });

function fail(message: string): never {
  console.error(`\nStartup failed: ${message}\nFix .env (see .env.example), or set LLM_MODEL=rules to run without an LLM key.\n`);
  process.exit(1);
}

try {
  cfg = loadConfig();
  processor = createProcessor(cfg, log, (...args) => send(...args));
} catch (e) {
  fail((e as Error).message);
}

// One message at a time per chat so clarification state stays consistent.
const queues = new Map<string, Promise<void>>();
const enqueue = (msg: IncomingMessage) => {
  const next = (queues.get(msg.chatId) ?? Promise.resolve())
    .then(() => processor.handle(msg))
    .then(() => undefined)
    .catch((e) => log.error('message.unhandled', { error: e }));
  queues.set(msg.chatId, next);
};

log.info('startup', { transport: cfg.CHAT_TRANSPORT, zoho: cfg.ZOHO_MODE, dryRun: isDryRun(cfg), model: cfg.LLM_MODEL });

if (cfg.CHAT_TRANSPORT === 'telegram') {
  if (!cfg.TELEGRAM_BOT_TOKEN) fail('TELEGRAM_BOT_TOKEN is not set (create a bot with @BotFather)');
  const api = createTelegramApi({ token: cfg.TELEGRAM_BOT_TOKEN });
  send = api.send;
  if (!cfg.TELEGRAM_ALLOWED_CHATS.length) log.warn('startup.no_chats', { hint: 'Set TELEGRAM_ALLOWED_CHATS; chat ids are logged as messages arrive' });
  try {
    const bot = await startTelegramPolling({
      api,
      allowedChats: cfg.TELEGRAM_ALLOWED_CHATS,
      maxMessageAgeSec: cfg.MAX_MESSAGE_AGE_SEC,
      log: log.child({ component: 'telegram' }),
      onMessage: enqueue,
    });
    const shutdown = () => void bot.stop().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (e) {
    fail(`Could not connect to Telegram: ${(e as Error).message}`);
  }
} else if (cfg.CHAT_TRANSPORT === 'whatsapp_cloud') {
  const { createCloudSender, startCloudWebhook } = await import('./whatsapp/cloud.js');
  const missing = (['WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN'] as const).filter((k) => !cfg[k]);
  if (missing.length) fail(`Missing WhatsApp Cloud API settings: ${missing.join(', ')}`);
  const cloud = {
    phoneNumberId: cfg.WA_PHONE_NUMBER_ID!,
    accessToken: cfg.WA_ACCESS_TOKEN!,
    appSecret: cfg.WA_APP_SECRET!,
    verifyToken: cfg.WA_VERIFY_TOKEN!,
    graphVersion: cfg.WA_GRAPH_VERSION,
  };
  send = createCloudSender(cloud);
  await startCloudWebhook({
    cfg: cloud,
    port: cfg.PORT,
    allowedSenders: cfg.WA_ALLOWED_SENDERS,
    maxMessageAgeSec: cfg.MAX_MESSAGE_AGE_SEC,
    log: log.child({ component: 'cloud' }),
    onMessage: enqueue,
  });
  log.info('cloud.listening', { port: cfg.PORT, webhook: `http://localhost:${cfg.PORT}/webhook` });
} else {
  // Unofficial WhatsApp group transport (ban risk). Loaded lazily so other transports never touch Baileys.
  const { startWhatsApp } = await import('./whatsapp/baileys.js');
  const wa = await startWhatsApp({
    authDir: cfg.WA_AUTH_DIR,
    allowedGroups: cfg.WA_ALLOWED_GROUPS,
    maxMessageAgeSec: cfg.MAX_MESSAGE_AGE_SEC,
    log: log.child({ component: 'whatsapp' }),
    onMessage: async (msg) => enqueue(msg),
  });
  send = wa.send;
}
