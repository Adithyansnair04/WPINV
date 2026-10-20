import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { CLIENTS_FILE, ClientsFile, DEMO_PROFILE, PER_CLIENT_KEY, readClientsFile, type ClientEntry } from '../clients/registry.js';

/**
 * Registers a new client (one Telegram group -> one Zoho organization).
 * Usage: npm run client:add -- --id acme --name "Acme Stationery" --chat -1001234567890 [--chat ...]
 * The first time, the current single-client setup from .env is moved into clients.json as client "default".
 */
// Group chat ids are negative; join "--chat -100…" into "--chat=-100…" so parseArgs doesn't read it as an option.
const args = process.argv.slice(2).flatMap((a, i, all) => (a === '--chat' && /^-\d+$/.test(all[i + 1] ?? '') ? [] : all[i - 1] === '--chat' && /^-\d+$/.test(a) ? [`--chat=${a}`] : [a]));
const { values } = parseArgs({ args, options: { id: { type: 'string' }, name: { type: 'string' }, chat: { type: 'string', multiple: true } } });
const id = values.id?.trim() ?? '';
const chats = (values.chat ?? []).map((c) => c.trim()).filter(Boolean);
if (!id || !values.name || !chats.length) {
  console.error('Usage: npm run client:add -- --id acme --name "Acme Stationery" --chat -1001234567890   (send /whoami in the group to get its chat id)');
  process.exit(1);
}

let registry = readClientsFile();
if (!registry) {
  const cfg = loadConfig();
  if (!cfg.TELEGRAM_ALLOWED_CHATS.length) {
    console.error('Cannot move the current setup into clients.json: TELEGRAM_ALLOWED_CHATS in .env is empty.');
    process.exit(1);
  }
  const settings = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => PER_CLIENT_KEY.test(k) && k !== 'TELEGRAM_ALLOWED_CHATS' && v !== undefined)) as Record<string, string>;
  registry = { clients: [{ id: 'default', name: 'Default client', telegramChats: cfg.TELEGRAM_ALLOWED_CHATS, profile: DEMO_PROFILE, settings }] };
  console.log('Moved the current .env client into clients.json as "default". From now on its Zoho settings live in clients.json.');
}

const entry: ClientEntry = {
  id,
  name: values.name,
  telegramChats: chats,
  profile: `clients/${id}/profile.json`,
  settings: {
    ZOHO_MODE: 'live',
    ZOHO_CLIENT_ID: '',
    ZOHO_CLIENT_SECRET: '',
    ZOHO_REFRESH_TOKEN: '',
    ZOHO_ORG_ID: '',
    ZOHO_API_BASE: 'https://www.zohoapis.in/books/v3',
    ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.in',
    // Start in preview mode: the bot replies with previews until the client's setup is verified.
    INVOICE_ALLOW_LIVE_CREATE: 'false',
    INVOICE_CONFIRM: 'always',
    CUSTOMER_CREATE: 'confirm',
    RATE_POLICY: 'ask',
  },
};
const next = ClientsFile.safeParse({ clients: [...registry.clients, entry] });
if (!next.success) {
  console.error(`Invalid client: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  process.exit(1);
}
if (registry.clients.some((c) => c.id === id)) {
  console.error(`Client "${id}" already exists in ${CLIENTS_FILE}.`);
  process.exit(1);
}
const taken = registry.clients.flatMap((c) => c.telegramChats.filter((ch) => chats.includes(ch)).map((ch) => `${ch} (${c.id})`));
if (taken.length) {
  console.error(`Chat already assigned: ${taken.join(', ')}`);
  process.exit(1);
}

if (!existsSync(entry.profile!)) {
  mkdirSync(dirname(entry.profile!), { recursive: true });
  writeFileSync(entry.profile!, JSON.stringify({ business: 'TODO: describe the business, e.g. "an Indian stationery wholesaler"', keepWords: [], normalizer: { packs: [], synonyms: {}, stopwords: [] }, aliases: {} }, null, 2) + '\n');
}
writeFileSync(CLIENTS_FILE, JSON.stringify({ clients: next.data.clients }, null, 2) + '\n');
console.log(`Added client "${id}" (${values.name}) for chat(s) ${chats.join(', ')}.

Next:
  1. Put this client's Zoho Self Client id/secret into ${CLIENTS_FILE} (clients[].settings.ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET)
  2. npm run zoho:token -- --client ${id} <grant_code>      saves the refresh token and org id into ${CLIENTS_FILE}
  3. npm run zoho:check -- --client ${id}
  4. npm run client:profile -- --client ${id} --write        onboarding report + draft profile
  5. Review ${entry.profile}, restart the bot. It starts in preview mode (INVOICE_ALLOW_LIVE_CREATE=false).`);
