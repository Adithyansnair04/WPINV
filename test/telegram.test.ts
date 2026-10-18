import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentLogger } from '../src/logger.js';
import { createTelegramApi, parseUpdate, startTelegramPolling } from '../src/telegram/bot.js';
import type { IncomingMessage } from '../src/types.js';

const BOT_ID = 999;
const now = () => Math.floor(Date.now() / 1000);
const update = (id: number, m: Record<string, unknown>) => ({
  update_id: id,
  message: { message_id: 10 + id, date: now(), chat: { id: -100123, type: 'supergroup', title: 'Sales' }, from: { id: 42, is_bot: false }, ...m },
});

type Call = { method: string; body: unknown };
function fakeTelegram(responder: (method: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const method = String(url).split('/').pop()!;
    const body = init.body instanceof FormData ? init.body : JSON.parse(String(init.body ?? '{}'));
    calls.push({ method, body });
    await new Promise((r) => setTimeout(r, 1)); // behave like real I/O so the polling loop yields
    const r = responder(method, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('telegram: parses group text, captions and replies with per-chat ids; drops bots', () => {
  const m = parseUpdate(update(1, { text: 'VK red wheel 4', reply_to_message: { message_id: 5 } }) as never, BOT_ID)!;
  assert.deepEqual({ ...m, timestamp: 0 }, { id: '-100123:11', chatId: '-100123', senderId: '42', text: 'VK red wheel 4', timestamp: 0, fromMe: false, quotedId: '-100123:5' });
  assert.equal(parseUpdate(update(2, { caption: 'from photo' }) as never, BOT_ID)!.text, 'from photo');
  assert.equal(parseUpdate(update(3, { text: 'x', from: { id: 7, is_bot: true } }) as never, BOT_ID), null);
  assert.equal(parseUpdate(update(4, {}) as never, BOT_ID), null);
});

test('telegram: send replies to the quoted message and returns a namespaced id', async () => {
  const { calls, fetchImpl } = fakeTelegram(() => ({ json: { ok: true, result: { message_id: 77 } } }));
  const api = createTelegramApi({ token: 'T', fetchImpl });
  assert.equal(await api.send('-100123', { text: 'hello' }, '-100123:11'), '-100123:77');
  assert.deepEqual(calls[0], {
    method: 'sendMessage',
    body: { chat_id: '-100123', text: 'hello', reply_parameters: { message_id: 11, allow_sending_without_reply: true } },
  });
  await api.send('-100123', { text: '', document: { data: Buffer.from('%PDF'), fileName: 'INV-1.pdf', mimetype: 'application/pdf' } });
  assert.equal(calls[1]!.method, 'sendDocument');
  assert.ok(calls[1]!.body instanceof FormData);
});

test('telegram: honours 429 retry_after once, errors never include the token', async () => {
  let n = 0;
  const waits: number[] = [];
  const { fetchImpl } = fakeTelegram(() =>
    ++n === 1 ? { status: 429, json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } } } : { json: { ok: true, result: { message_id: 1 } } },
  );
  const api = createTelegramApi({ token: 'SECRET-TOKEN', fetchImpl, sleep: async (ms) => void waits.push(ms) });
  await api.send('1', { text: 'x' });
  assert.deepEqual(waits, [2000]);

  const bad = createTelegramApi({ token: 'SECRET-TOKEN', fetchImpl: fakeTelegram(() => ({ status: 401, json: { ok: false, description: 'Unauthorized' } })).fetchImpl });
  await assert.rejects(bad.call('getMe'), (e: Error) => e.message.includes('401') && !e.message.includes('SECRET'));
});

test('telegram: polling filters chats, skips stale messages, advances offset', async () => {
  const received: IncomingMessage[] = [];
  let polls = 0;
  const { calls, fetchImpl } = fakeTelegram((method) => {
    if (method === 'getMe') return { json: { ok: true, result: { id: BOT_ID, username: 'wpinv_bot' } } };
    if (method === 'deleteWebhook') return { json: { ok: true, result: true } };
    polls++;
    if (polls === 1) {
      return {
        json: {
          ok: true,
          result: [
            update(1, { text: 'VK lenzo 18 red x 4 rate 5200' }),
            update(2, { text: 'other chat', chat: { id: 555, type: 'group' } }),
            update(3, { text: 'old', date: now() - 3600 }),
          ],
        },
      };
    }
    return { json: { ok: true, result: [] } };
  });
  const api = createTelegramApi({ token: 'T', fetchImpl });
  const bot = await startTelegramPolling({ api, allowedChats: ['-100123'], maxMessageAgeSec: 600, log: silentLogger, onMessage: (m) => received.push(m), pollTimeoutSec: 0 });
  while (polls < 2) await new Promise((r) => setTimeout(r, 5));
  await bot.stop();
  assert.deepEqual(received.map((m) => m.text), ['VK lenzo 18 red x 4 rate 5200']);
  const second = calls.filter((c) => c.method === 'getUpdates')[1]!.body as { offset: number };
  assert.equal(second.offset, 4);
});
