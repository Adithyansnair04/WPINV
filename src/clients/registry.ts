import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig, type Config } from '../config.js';
import { GENERIC_PROFILE, loadProfile, type ClientProfile } from './profile.js';

/** Git-ignored: holds each client's Zoho credentials. */
export const CLIENTS_FILE = 'clients.json';
/** The demo (wheels-and-tyres) client's profile, used in single-client mode. */
export const DEMO_PROFILE = 'data/profile.json';

/** Settings that belong to one client. Everything else (bot token, LLM keys, dashboard, data dir) is shared from .env. */
export const PER_CLIENT_KEY = /^(ZOHO_|INVOICE_|CUSTOMER_|DEFAULT_TAX_PERCENT$|RATE_POLICY$|BASE_CURRENCY$|TELEGRAM_ALLOWED_CHATS$)/;

const ClientEntry = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1),
  /** Telegram chat ids routed to this client (groups are negative numbers). */
  telegramChats: z.array(z.coerce.string()).min(1),
  /** Path to the client's profile JSON; omitted = generic profile. */
  profile: z.string().optional(),
  /** Per-client settings with the same names as .env, e.g. ZOHO_REFRESH_TOKEN, INVOICE_ALLOW_LIVE_CREATE. */
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export const ClientsFile = z.object({ clients: z.array(ClientEntry).min(1) });
export type ClientEntry = z.infer<typeof ClientEntry>;

export interface ResolvedClient {
  id: string;
  name: string;
  chats: string[];
  cfg: Config;
  profile: ClientProfile;
  /** Set when the client's configuration is invalid; such a client is not started. */
  error?: string;
}

export function readClientsFile(file = CLIENTS_FILE): { clients: ClientEntry[] } | null {
  if (!existsSync(file)) return null;
  const parsed = ClientsFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Sets one per-client setting in the clients file, leaving everything else as it is. */
export function saveClientSetting(id: string, key: string, value: string, file = CLIENTS_FILE) {
  const registry = readClientsFile(file);
  const client = registry?.clients.find((c) => c.id === id);
  if (!registry || !client) throw new Error(`Client "${id}" is not in ${file}`);
  client.settings[key] = value;
  writeFileSync(file, JSON.stringify(registry, null, 2) + '\n');
}

/** The client a CLI command works on: --client <id>, or the only client there is. */
export function pickClient(id: string | undefined, clients = loadClients()): ResolvedClient {
  const client = id ? clients.find((c) => c.id === id) : clients.length === 1 ? clients[0] : undefined;
  if (!client) throw new Error(id ? `Unknown client "${id}" (${clients.map((c) => c.id).join(', ')})` : `Pick a client with --client (${clients.map((c) => c.id).join(', ')})`);
  return client;
}

/**
 * Resolves every client into its own Config. Per-client keys are never inherited from .env, so one client can
 * never use another client's Zoho organization by accident. Without a clients file, .env describes one client.
 */
export function loadClients(baseEnv: NodeJS.ProcessEnv = process.env, file = CLIENTS_FILE): ResolvedClient[] {
  const registry = readClientsFile(file);
  if (!registry) {
    const cfg = loadConfig(baseEnv);
    return [{ id: 'default', name: 'Default client', chats: cfg.TELEGRAM_ALLOWED_CHATS, cfg, profile: existsSync(DEMO_PROFILE) ? loadProfile(DEMO_PROFILE) : GENERIC_PROFILE }];
  }

  const seenIds = new Set<string>();
  const chatOwner = new Map<string, string>();
  for (const c of registry.clients) {
    if (seenIds.has(c.id)) throw new Error(`${file}: duplicate client id "${c.id}"`);
    seenIds.add(c.id);
    for (const chat of c.telegramChats) {
      if (chatOwner.has(chat)) throw new Error(`${file}: chat ${chat} is assigned to both "${chatOwner.get(chat)}" and "${c.id}"`);
      chatOwner.set(chat, c.id);
    }
  }

  const shared = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !PER_CLIENT_KEY.test(k)));
  return registry.clients.map((c) => {
    const env = { ...shared, ...Object.fromEntries(Object.entries(c.settings).map(([k, v]) => [k, String(v)])), TELEGRAM_ALLOWED_CHATS: c.telegramChats.join(',') };
    try {
      return { id: c.id, name: c.name, chats: c.telegramChats, cfg: loadConfig(env), profile: loadProfile(c.profile) };
    } catch (e) {
      return { id: c.id, name: c.name, chats: c.telegramChats, cfg: loadConfig(shared), profile: GENERIC_PROFILE, error: (e as Error).message };
    }
  });
}
