import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { silentLogger } from '../src/logger.js';
import type { IncomingMessage } from '../src/types.js';
import { createCloudSender, parseWebhook, startCloudWebhook, verifySignature } from '../src/whatsapp/cloud.js';

const cfg = { phoneNumberId: 'PNID', accessToken: 'TOKEN', appSecret: 'app-secret', verifyToken: 'verify-me', graphVersion: 'v25.0' };
const sign = (raw: string) => `sha256=${createHmac('sha256', cfg.appSecret).update(raw).digest('hex')}`;

const event = (messages: object[], phoneNumberId = 'PNID') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, messages } }] }],
});
const textMsg = (o: object = {}) => ({ id: 'wamid.1', from: '919800000001', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'VK red wheel 4' }, ...o });

test('cloud: signature verification', () => {
  const raw = '{"a":1}';
  assert.ok(verifySignature(Buffer.from(raw), sign(raw), cfg.appSecret));
  assert.equal(verifySignature(Buffer.from(raw), sign('{"a":2}'), cfg.appSecret), false);
  assert.equal(verifySignature(Buffer.from(raw), undefined, cfg.appSecret), false);
  assert.equal(verifySignature(Buffer.from(raw), 'sha256=zz', cfg.appSecret), false);
});

test('cloud: parses text messages with reply context, ignores statuses/other numbers/media', () => {
  const msgs = parseWebhook(event([textMsg({ context: { id: 'wamid.q' } }), { id: 'wamid.2', from: '91', type: 'image' }]), 'PNID');
  assert.equal(msgs.length, 1);
  assert.deepEqual({ ...msgs[0], timestamp: 0 }, { id: 'wamid.1', chatId: '919800000001', senderId: '919800000001', text: 'VK red wheel 4', timestamp: 0, fromMe: false, quotedId: 'wamid.q' });
  assert.equal(parseWebhook(event([textMsg()], 'OTHER'), 'PNID').length, 0);
  assert.equal(parseWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }] }, 'PNID').length, 0);
  assert.equal(parseWebhook({ junk: true }, 'PNID').length, 0);
});

test('cloud: webhook handshake, signature gate, allowlist', async () => {
  const received: IncomingMessage[] = [];
  const server = await startCloudWebhook({ cfg, port: 0, allowedSenders: ['919800000001'], maxMessageAgeSec: 600, log: silentLogger, onMessage: (m) => received.push(m) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
  try {
    const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');
    assert.equal((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);

    const body = JSON.stringify(event([textMsg(), textMsg({ id: 'wamid.3', from: '919999999999' })]));
    assert.equal((await fetch(base, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=00' } })).status, 401);
    assert.equal((await fetch(base, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } })).status, 200);
    assert.deepEqual(received.map((m) => m.id), ['wamid.1']);
  } finally {
    server.close();
  }
});

test('cloud: sends quoted text and uploads PDF documents', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = String(url).endsWith('/media') ? { id: 'MEDIA1' } : { messaging_product: 'whatsapp', messages: [{ id: `wamid.out${calls.length}` }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const send = createCloudSender({ ...cfg, fetchImpl });

  assert.equal(await send('919800000001', { text: 'hello' }, 'wamid.in'), 'wamid.out1');
  assert.equal(calls[0]!.url, 'https://graph.facebook.com/v25.0/PNID/messages');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer TOKEN');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '919800000001', type: 'text', text: { body: 'hello', preview_url: false }, context: { message_id: 'wamid.in' },
  });

  await send('919800000001', { text: '', document: { data: Buffer.from('%PDF'), fileName: 'INV-1.pdf', mimetype: 'application/pdf' } });
  assert.equal(calls[1]!.url, 'https://graph.facebook.com/v25.0/PNID/media');
  assert.ok(calls[1]!.init.body instanceof FormData);
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)).document, { id: 'MEDIA1', filename: 'INV-1.pdf' });
});

test('cloud: API errors surface with category', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'Recipient phone number not in allowed list' } }), { status: 400 })) as unknown as typeof fetch;
  const send = createCloudSender({ ...cfg, fetchImpl });
  await assert.rejects(send('91', { text: 'x' }), /not in allowed list/);
});
