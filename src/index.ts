import { join } from 'node:path';
import { loadClients, type ResolvedClient } from './clients/registry.js';
import { describeClient, startClients, type ClientRuntime } from './clients/runtime.js';
import { ActivityLog, toActivity } from './dashboard/activity.js';
import { startDashboard } from './dashboard/server.js';
import { createLogger } from './logger.js';
import { createTelegramApi, startTelegramPolling } from './telegram/bot.js';
import type { IncomingMessage, SendFn } from './types.js';

const log = createLogger((process.env.LOG_LEVEL as 'info') ?? 'info', { app: 'wpinv' });

function fail(message: string): never {
  console.error(`\nStartup failed: ${message}\nFix .env / clients.json (see .env.example, clients.example.json), or set LLM_MODEL=rules to run without an LLM key.\n`);
  process.exit(1);
}

let send: SendFn = async () => undefined;
let clients: ResolvedClient[] = [];
let started: ReturnType<typeof startClients>;
try {
  clients = loadClients();
  started = startClients(clients, log, (...args) => send(...args));
} catch (e) {
  fail((e as Error).message);
}
for (const s of started.skipped) log.error('client.skipped', { client: s.id, error: s.error });
if (!started.runtimes.length) fail('No client could be started (see client.skipped errors above).');

// Shared settings (bot token, LLM, dashboard, data dir) are identical for every client.
const shared = started.runtimes[0]!.client.cfg;
const multi = clients.length > 1;
const activity = new ActivityLog(join(shared.DATA_DIR, 'activity.json'));

// One message at a time per chat so clarification state stays consistent.
const queues = new Map<string, Promise<void>>();
const enqueue = (msg: IncomingMessage) => {
  const runtime: ClientRuntime | undefined = started.byChat.get(msg.chatId);
  if (!runtime) return;
  const next = (queues.get(msg.chatId) ?? Promise.resolve())
    .then(() => runtime.processor.handle(msg))
    .then((r) => activity.add(toActivity(msg, r, shared.LOG_MESSAGE_TEXT, multi ? runtime.client.name : undefined)))
    .catch((e) => log.error('message.unhandled', { client: runtime.client.id, error: e }));
  queues.set(msg.chatId, next);
};

const info = {
  transport: 'telegram',
  model: shared.LLM_MODEL,
  fallback: shared.LLM_FALLBACK_MODEL || 'none',
  clients: started.runtimes.map((r) => describeClient(r.client)).join(' · '),
};
log.info('startup', { ...info, skipped: started.skipped.map((s) => s.id) });

if (shared.DASHBOARD_PORT > 0) {
  await startDashboard({ port: shared.DASHBOARD_PORT, host: shared.DASHBOARD_HOST, activity, stores: started.runtimes.map((r) => r.store), info, log: log.child({ component: 'dashboard' }) })
    .then(() => log.info('dashboard.listening', { url: `http://${shared.DASHBOARD_HOST}:${shared.DASHBOARD_PORT}` }))
    .catch((e) => log.warn('dashboard.failed', { error: e }));
}

if (!shared.TELEGRAM_BOT_TOKEN) fail('TELEGRAM_BOT_TOKEN is not set (create a bot with @BotFather)');
const api = createTelegramApi({ token: shared.TELEGRAM_BOT_TOKEN });
send = api.send;
const allowedChats = [...started.byChat.keys()];
if (!allowedChats.length) log.warn('startup.no_chats', { hint: 'Assign Telegram chat ids to clients; unknown chat ids are logged as messages arrive' });
try {
  const bot = await startTelegramPolling({
    api,
    allowedChats,
    maxMessageAgeSec: shared.MAX_MESSAGE_AGE_SEC,
    log: log.child({ component: 'telegram' }),
    onMessage: enqueue,
  });
  const shutdown = () => void bot.stop().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (e) {
  fail(`Could not connect to Telegram: ${(e as Error).message}`);
}
