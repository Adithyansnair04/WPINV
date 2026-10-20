import { join } from 'node:path';
import { createProcessor, isDryRun } from '../app.js';
import type { Logger } from '../logger.js';
import type { InvoiceProcessor } from '../pipeline/processor.js';
import { StateStore } from '../pipeline/state.js';
import type { SendFn } from '../types.js';
import type { ResolvedClient } from './registry.js';

export interface ClientRuntime {
  client: ResolvedClient;
  processor: InvoiceProcessor;
  store: StateStore;
}

/** One processor and one state file per client; a client with broken configuration is skipped, not fatal. */
export function startClients(clients: ResolvedClient[], log: Logger, send: SendFn) {
  const runtimes: ClientRuntime[] = [];
  const skipped: { id: string; error: string }[] = [];
  for (const client of clients) {
    if (client.error) {
      skipped.push({ id: client.id, error: client.error });
      continue;
    }
    try {
      // The single-client setup keeps its original state file.
      const file = client.id === 'default' ? join(client.cfg.DATA_DIR, 'state.json') : join(client.cfg.DATA_DIR, 'clients', client.id, 'state.json');
      const store = new StateStore(file);
      const processor = createProcessor(client.cfg, log.child({ client: client.id }), send, { store, profile: client.profile });
      runtimes.push({ client, processor, store });
    } catch (e) {
      skipped.push({ id: client.id, error: (e as Error).message });
    }
  }
  const byChat = new Map(runtimes.flatMap((r) => r.client.chats.map((chat) => [chat, r] as const)));
  return { runtimes, byChat, skipped };
}

/** One line per client for logs and the dashboard header. */
export const describeClient = (c: ResolvedClient) =>
  `${c.name} (${c.cfg.ZOHO_MODE === 'mock' ? 'mock Zoho' : isDryRun(c.cfg) ? 'live Zoho, preview only' : 'live Zoho'})`;
