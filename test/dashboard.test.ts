import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ActivityLog, toActivity } from '../src/dashboard/activity.js';
import { startDashboard } from '../src/dashboard/server.js';
import { silentLogger } from '../src/logger.js';
import { ex, msg, scripted, setup } from './helpers.js';

test('dashboard: serves activity, pending clarifications and info; hides message text by default; read-only', async () => {
  const { processor, store } = setup(scripted({ 'VK red wheel 4': ex({ customer: 'VK', items: [{ description: 'red wheel', quantity: 4, rate: null }] }) }));
  const m = msg('VK red wheel 4');
  const r = await processor.handle(m);
  const activity = new ActivityLog();
  activity.add(toActivity(m, r, false));

  const server = await startDashboard({ port: 0, host: '127.0.0.1', activity, stores: [store], info: { transport: 'test' }, log: silentLogger, evalDir: 'eval/results' });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const acts = (await (await fetch(`${base}/api/activity`)).json()) as { action: string; text?: string; customer: { name: string }; sender: string }[];
    assert.equal(acts[0]!.action, 'clarify');
    assert.equal(acts[0]!.customer.name, 'VK Enterprises');
    assert.equal(acts[0]!.text, undefined);
    assert.notEqual(acts[0]!.sender, m.senderId);

    const pending = (await (await fetch(`${base}/api/pending`)).json()) as { options: string[] }[];
    assert.equal(pending.length, 1);
    assert.ok(pending[0]!.options.length >= 2);

    assert.deepEqual(await (await fetch(`${base}/api/info`)).json(), { transport: 'test' });
    assert.match(await (await fetch(base)).text(), /<title>WPINV Dashboard<\/title>/);
    assert.equal((await fetch(`${base}/api/activity`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
  assert.equal(toActivity(m, r, true).text, 'VK red wheel 4');
});

test('dashboard: each activity row records which LLM read the message, and why the backup was used', () => {
  const base = { messageId: 'm', associatedPending: false, timings: { total: 5 } };
  const meta = { latencyMs: 1, attempts: 1, retries: 0, rateLimited: 0, invalidOutputs: 0 };
  const m = msg('VK lenzo 18 red x 4 rate 5200');
  const primary = toActivity(m, { ...base, action: 'clarify', extractMeta: { ...meta, model: 'gemini:gemini-3.1-flash-lite' } }, false);
  assert.equal(primary.model, 'gemini:gemini-3.1-flash-lite');
  assert.equal(primary.fallbackFrom, undefined);

  const backup = toActivity(
    m,
    { ...base, action: 'clarify', extractMeta: { ...meta, model: 'groq:openai/gpt-oss-20b', fallbackFrom: 'gemini:gemini-3.1-flash-lite', primaryError: 'transient: LLM HTTP 503' } },
    false,
  );
  assert.equal(backup.model, 'groq:openai/gpt-oss-20b');
  assert.equal(backup.fallbackFrom, 'gemini:gemini-3.1-flash-lite');
  assert.match(backup.primaryError!, /503/);

  assert.equal(toActivity(m, { ...base, action: 'created' }, false).model, undefined, 'button taps / confirmations use no LLM');
});
