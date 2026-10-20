import { join } from 'node:path';
import { createProcessor, isDryRun } from './app.js';
import { loadConfig, type Config } from './config.js';
import { ActivityLog, toActivity } from './dashboard/activity.js';
import { startDashboard } from './dashboard/server.js';
import { createLogger } from './logger.js';
import { StateStore } from './pipeline/state.js';
import { createTelegramApi, startTelegramPolling } from './telegram/bot.js';
import type { IncomingMessage, SendFn } from './types.js';

let send: SendFn = async () => undefined;
let cfg: Config;
let processor: ReturnType<typeof createProcessor>;
let store: StateStore;
let activity: ActivityLog;
const log = createLogger((process.env.LOG_LEVEL as 'info') ?? 'info', { app: 'wpinv' });

function fail(message: string): never {
  console.error(`\nStartup failed: ${message}\nFix .env (see .env.example), or set LLM_MODEL=rules to run without an LLM key.\n`);
  process.exit(1);
}

try {
  cfg = loadConfig();
  store = new StateStore(join(cfg.DATA_DIR, 'state.json'));
  activity = new ActivityLog(join(cfg.DATA_DIR, 'activity.json'));
  processor = createProcessor(cfg, log, (...args) => send(...args), { store });
} catch (e) {
  fail((e as Error).message);
}

// One message at a time per chat so clarification state stays consistent.
const queues = new Map<string, Promise<void>>();
const enqueue = (msg: IncomingMessage) => {
  const next = (queues.get(msg.chatId) ?? Promise.resolve())
    .then(() => processor.handle(msg))
    .then((r) => activity.add(toActivity(msg, r, cfg.LOG_MESSAGE_TEXT)))
    .catch((e) => log.error('message.unhandled', { error: e }));
  queues.set(msg.chatId, next);
};

const info = { transport: 'telegram', model: cfg.LLM_MODEL, fallback: cfg.LLM_FALLBACK_MODEL || 'none', zoho: cfg.ZOHO_MODE, dryRun: isDryRun(cfg) };
log.info('startup', info);

if (cfg.DASHBOARD_PORT > 0) {
  await startDashboard({ port: cfg.DASHBOARD_PORT, host: cfg.DASHBOARD_HOST, activity, store, info, log: log.child({ component: 'dashboard' }) })
    .then(() => log.info('dashboard.listening', { url: `http://${cfg.DASHBOARD_HOST}:${cfg.DASHBOARD_PORT}` }))
    .catch((e) => log.warn('dashboard.failed', { error: e }));
}

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
