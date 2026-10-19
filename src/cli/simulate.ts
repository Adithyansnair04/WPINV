import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createProcessor, isDryRun } from '../app.js';
import { loadConfig } from '../config.js';
import { ActivityLog, toActivity } from '../dashboard/activity.js';
import { startDashboard } from '../dashboard/server.js';
import { createLogger } from '../logger.js';
import { StateStore } from '../pipeline/state.js';
import type { IncomingMessage } from '../types.js';

/**
 * Local chat simulator: same processor as the bot, but messages come from the terminal.
 * Uses ZOHO_MODE (mock by default) and LLM_MODEL (override with --model, e.g. --model rules).
 * --dashboard also serves the dashboard (DASHBOARD_PORT) and keeps running after -m messages.
 */
const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    message: { type: 'string', multiple: true, short: 'm' },
    verbose: { type: 'boolean', short: 'v' },
    dashboard: { type: 'boolean' },
  },
});

const cfg = loadConfig();
if (values.model) cfg.LLM_MODEL = values.model;
const log = createLogger(values.verbose ? 'debug' : 'warn', { app: 'simulate' });
const chatId = 'simulated-group@g.us';
let sender = 'alice';
let seq = 0;
let lastQuestionId: string | undefined;
const store = new StateStore();
const activity = new ActivityLog();

const processor = createProcessor(
  cfg,
  log,
  async (_chat, out) => {
    const id = `bot-${++seq}`;
    if (out.document) {
      const dir = join(cfg.DATA_DIR, 'out');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, out.document.fileName);
      writeFileSync(file, out.document.data);
      console.log(`\n[bot] 📎 ${out.document.fileName} saved to ${file}`);
    } else {
      console.log(`\n[bot]\n${out.text}\n`);
      // ">" in the simulator replies to the latest question, preview or confirmation.
      if (out.buttons?.length || /^(Before I create the invoice|Create this draft invoice|Add new customer)/.test(out.text)) lastQuestionId = id;
    }
    return id;
  },
  { store },
);

async function send(text: string, quote: boolean) {
  const msg: IncomingMessage = {
    id: `sim-${Date.now()}-${++seq}`,
    chatId,
    senderId: `${sender}@s.whatsapp.net`,
    text,
    timestamp: Date.now(),
    fromMe: false,
    quotedId: quote ? lastQuestionId : undefined,
  };
  const r = await processor.handle(msg);
  activity.add(toActivity(msg, r, true));
  console.log(`  ↳ action=${r.action}${r.reason ? ` reason=${r.reason}` : ''} latency=${r.timings.total}ms${r.extractMeta ? ` model=${r.extractMeta.model}` : ''}`);
  if (values.verbose && r.decision) console.log(JSON.stringify(r.decision.trace, null, 2));
}

console.log(`WPINV simulator | model=${cfg.LLM_MODEL} | zoho=${cfg.ZOHO_MODE}${isDryRun(cfg) ? ' (dry run)' : ''}`);
if (values.dashboard) {
  const info = { transport: 'simulator', model: cfg.LLM_MODEL, fallback: cfg.LLM_FALLBACK_MODEL || 'none', zoho: cfg.ZOHO_MODE, dryRun: isDryRun(cfg) };
  await startDashboard({ port: cfg.DASHBOARD_PORT || 3001, host: cfg.DASHBOARD_HOST, activity, store, info, log });
  console.log(`Dashboard: http://${cfg.DASHBOARD_HOST}:${cfg.DASHBOARD_PORT || 3001}`);
}

if (values.message?.length) {
  for (const m of values.message) {
    const quote = m.startsWith('>');
    console.log(`\n[${sender}] ${m}`);
    await send(quote ? m.slice(1).trim() : m.replace(/\\n/g, '\n'), quote);
  }
  if (values.dashboard) console.log('\nDashboard still running; press Ctrl+C to stop.');
} else {
  console.log('Type a message; finish with an empty line. Start with ">" to reply to the last question. /as <name> switches sender, /quit exits.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let buffer: string[] = [];
  for await (const line of rl) {
    if (line.startsWith('/quit')) break;
    if (line.startsWith('/as ')) {
      sender = line.slice(4).trim() || sender;
      console.log(`(sender: ${sender})`);
      continue;
    }
    if (line.trim()) {
      buffer.push(line);
      continue;
    }
    if (!buffer.length) continue;
    const text = buffer.join('\n');
    buffer = [];
    const quote = text.startsWith('>');
    await send(quote ? text.slice(1).trim() : text, quote);
  }
  rl.close();
}
