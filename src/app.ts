import { join } from 'node:path';
import { requireZohoCredentials, type Config } from './config.js';
import { llmExtractor, type Extractor } from './extraction/extract.js';
import { rulesExtractor } from './extraction/rules.js';
import { createProvider } from './llm/provider.js';
import type { Logger } from './logger.js';
import { InvoiceProcessor } from './pipeline/processor.js';
import { StateStore } from './pipeline/state.js';
import type { BooksApi, SendFn } from './types.js';
import { CachedBooks } from './zoho/cached.js';
import { ZohoBooks } from './zoho/client.js';
import { loadAliases, MockBooks } from './zoho/mock.js';

export function createExtractor(spec: string, cfg: Config): Extractor {
  return spec === 'rules' || spec === 'rules:baseline' ? rulesExtractor : llmExtractor(createProvider(spec, cfg));
}

export function createBooks(cfg: Config, log: Logger): BooksApi {
  if (cfg.ZOHO_MODE === 'mock') return new MockBooks();
  return new CachedBooks(new ZohoBooks(requireZohoCredentials(cfg), { log: log.child({ component: 'zoho' }), aliases: loadAliases() }));
}

/** Live Zoho creation needs ZOHO_MODE=live AND INVOICE_ALLOW_LIVE_CREATE=true; otherwise dry run. Mock mode always "creates" in memory. */
export const isDryRun = (cfg: Config) => cfg.ZOHO_MODE === 'live' && !cfg.INVOICE_ALLOW_LIVE_CREATE;

export function createProcessor(cfg: Config, log: Logger, send: SendFn, opts: { persistState?: boolean; store?: StateStore } = {}) {
  return new InvoiceProcessor({
    extractor: createExtractor(cfg.LLM_MODEL, cfg),
    books: createBooks(cfg, log),
    store: opts.store ?? new StateStore(opts.persistState === false ? undefined : join(cfg.DATA_DIR, 'state.json')),
    send,
    log: log.child({ component: 'processor' }),
    options: {
      ratePolicy: cfg.RATE_POLICY,
      baseCurrency: cfg.BASE_CURRENCY,
      clarifyTtlMs: cfg.CLARIFY_TTL_MINUTES * 60_000,
      dryRun: isDryRun(cfg),
      logMessageText: cfg.LOG_MESSAGE_TEXT,
      customerCreate: cfg.CUSTOMER_CREATE,
      customerCreators: cfg.CUSTOMER_CREATORS,
    },
  });
}
