import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadClients, pickClient, saveClientSetting } from '../src/clients/registry.js';
import { startClients } from '../src/clients/runtime.js';
import { silentLogger } from '../src/logger.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'wpinv-clients-'));
const baseEnv = (dataDir: string): NodeJS.ProcessEnv => ({
  LLM_MODEL: 'rules',
  DATA_DIR: dataDir,
  TELEGRAM_BOT_TOKEN: 'shared-bot-token',
  // Per-client values in .env must never leak into clients defined in clients.json:
  ZOHO_MODE: 'live',
  ZOHO_REFRESH_TOKEN: 'DEFAULT-ORG-TOKEN',
  ZOHO_ORG_ID: '111',
  TELEGRAM_ALLOWED_CHATS: '-100999',
});

function writeClients(dir: string, clients: unknown[]) {
  const file = join(dir, 'clients.json');
  writeFileSync(file, JSON.stringify({ clients }));
  return file;
}

test('clients: without clients.json, .env describes a single default client with the demo profile', () => {
  const dir = tmp();
  const [c, ...rest] = loadClients({ ...baseEnv(dir), ZOHO_MODE: 'mock' }, join(dir, 'missing.json'));
  assert.equal(rest.length, 0);
  assert.equal(c!.id, 'default');
  assert.deepEqual(c!.chats, ['-100999']);
  assert.deepEqual(c!.profile.normalizer.packs, ['auto_parts']);
});

test('clients: each client gets only its own Zoho settings; shared settings come from .env', () => {
  const dir = tmp();
  const profile = join(dir, 'acme.json');
  writeFileSync(profile, JSON.stringify({ business: 'an Indian stationery wholesaler', aliases: { 'Mehta Traders': ['mt'] } }));
  const file = writeClients(dir, [
    { id: 'demo', name: 'Demo Wheels', telegramChats: ['-1001'], profile: 'data/profile.json', settings: { ZOHO_MODE: 'mock' } },
    { id: 'acme', name: 'Acme Stationery', telegramChats: [-1002, '-1003'], profile, settings: { ZOHO_MODE: 'live', ZOHO_ORG_ID: '222', INVOICE_ALLOW_LIVE_CREATE: false, DEFAULT_TAX_PERCENT: 18 } },
  ]);
  const [demo, acme] = loadClients(baseEnv(dir), file);
  assert.equal(demo!.cfg.ZOHO_MODE, 'mock');
  assert.equal(demo!.cfg.ZOHO_REFRESH_TOKEN, undefined, 'the .env Zoho token is not inherited');
  assert.equal(acme!.cfg.ZOHO_ORG_ID, '222');
  assert.equal(acme!.cfg.ZOHO_REFRESH_TOKEN, undefined);
  assert.equal(acme!.cfg.DEFAULT_TAX_PERCENT, 18);
  assert.deepEqual(acme!.chats, ['-1002', '-1003']);
  assert.equal(acme!.cfg.TELEGRAM_BOT_TOKEN, 'shared-bot-token');
  assert.equal(acme!.profile.business, 'an Indian stationery wholesaler');
  assert.deepEqual(acme!.profile.normalizer.packs, []);
});

test('clients: a chat cannot belong to two clients; duplicate ids are rejected', () => {
  const dir = tmp();
  assert.throws(
    () => loadClients(baseEnv(dir), writeClients(dir, [{ id: 'a', name: 'A', telegramChats: ['-1'] }, { id: 'b', name: 'B', telegramChats: ['-1'] }])),
    /chat -1 is assigned to both "a" and "b"/,
  );
  assert.throws(() => loadClients(baseEnv(dir), writeClients(dir, [{ id: 'a', name: 'A', telegramChats: ['-1'] }, { id: 'a', name: 'A2', telegramChats: ['-2'] }])), /duplicate client id/);
});

test('clients: routing by chat, separate state per client, and a broken client is skipped without stopping the rest', async () => {
  const dir = tmp();
  const file = writeClients(dir, [
    { id: 'demo', name: 'Demo Wheels', telegramChats: ['-1001'], profile: 'data/profile.json', settings: { ZOHO_MODE: 'mock' } },
    { id: 'shop', name: 'Shop Two', telegramChats: ['-2001'], settings: { ZOHO_MODE: 'mock' } },
    { id: 'acme', name: 'Acme', telegramChats: ['-3001'], settings: { ZOHO_MODE: 'live' } },
    { id: 'typo', name: 'Typo', telegramChats: ['-4001'], settings: { RATE_POLICY: 'sometimes' } },
  ]);
  const sent: string[] = [];
  const { runtimes, byChat, skipped } = startClients(loadClients(baseEnv(dir), file), silentLogger, async (chat, out) => {
    sent.push(`${chat}: ${out.text.split('\n')[0]}`);
    return `bot-${sent.length}`;
  });
  assert.deepEqual(runtimes.map((r) => r.client.id), ['demo', 'shop']);
  assert.deepEqual(skipped.map((s) => s.id), ['acme', 'typo']);
  assert.match(skipped[0]!.error, /Missing Zoho configuration/);
  assert.match(skipped[1]!.error, /RATE_POLICY/);

  const msg = (chatId: string, id: string) => ({ id, chatId, senderId: 'u1', text: 'VK\nred lenzo alloy 18 inch x 4\nrate 5200', timestamp: Date.now(), fromMe: false });
  const demo = byChat.get('-1001')!.processor;
  assert.equal((await demo.handle(msg('-1001', 'm1'))).reason, 'confirm_invoice');
  assert.ok(sent[0]!.startsWith('-1001: Create this draft invoice'));
  assert.equal((await demo.handle({ ...msg('-1001', 'm2'), text: '1', quotedId: 'bot-1' })).action, 'created');
  assert.ok(sent[1]!.startsWith('-1001: Draft invoice created'));
  assert.equal(byChat.get('-3001'), undefined, 'a skipped client gets no messages');
  assert.ok(existsSync(join(dir, 'clients', 'demo', 'state.json')));
  assert.ok(!existsSync(join(dir, 'clients', 'shop', 'state.json')), 'shop has not processed anything');
});

test('clients: CLI helpers pick a client and save one setting without touching the others', () => {
  const dir = tmp();
  const file = writeClients(dir, [
    { id: 'demo', name: 'Demo', telegramChats: ['-1001'], settings: { ZOHO_MODE: 'mock' } },
    { id: 'acme', name: 'Acme', telegramChats: ['-1002'], settings: { ZOHO_MODE: 'live', ZOHO_ORG_ID: '' } },
  ]);
  saveClientSetting('acme', 'ZOHO_ORG_ID', '222', file);
  const clients = loadClients(baseEnv(dir), file);
  assert.equal(pickClient('acme', clients).cfg.ZOHO_ORG_ID, '222');
  assert.equal(pickClient('demo', clients).cfg.ZOHO_ORG_ID, undefined);
  assert.throws(() => pickClient(undefined, clients), /Pick a client with --client \(demo, acme\)/);
  assert.throws(() => saveClientSetting('nope', 'ZOHO_ORG_ID', '1', file), /not in/);
});
