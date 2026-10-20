import { join } from 'node:path';
import { GENERIC_PROFILE, normalizerFor, type ClientProfile } from './clients/profile.js';
import { requireZohoCredentials, type Config } from './config.js';
import { llmExtractor, withFallback, type Extractor } from './extraction/extract.js';
import { buildSystemPrompt } from './extraction/prompt.js';
import { rulesExtractor } from './extraction/rules.js';
import { createProvider } from './llm/provider.js';
import type { Logger } from './logger.js';
import { InvoiceProcessor } from './pipeline/processor.js';
import { StateStore } from './pipeline/state.js';
import type { BooksApi, SendFn } from './types.js';
import { CachedBooks } from './zoho/cached.js';
import { ZohoBooks } from './zoho/client.js';
import { MockBooks } from './zoho/mock.js';

/** The client's profile decides the prompt; evaluation passes the demo profile explicitly. */
export function createExtractor(spec: string, cfg: Config, opts: { withFallback?: boolean; profile?: ClientProfile } = {}): Extractor {
  if (spec === 'rules' || spec === 'rules:baseline') return rulesExtractor;
  const prompt = buildSystemPrompt(opts.profile ?? GENERIC_PROFILE);
  const fallbackSpec = opts.withFallback ? cfg.LLM_FALLBACK_MODEL?.trim() : undefined;
  if (!fallbackSpec || fallbackSpec === spec) return llmExtractor(createProvider(spec, cfg), 2, prompt);
  // With a fallback available, the primary gets one retry and at most 15 s before the fallback answers.
  const primary = llmExtractor(createProvider(spec, cfg, { maxRetries: 1, timeoutMs: Math.min(cfg.LLM_TIMEOUT_MS, 15000) }), 2, prompt);
  return withFallback(primary, createExtractor(fallbackSpec, cfg, { profile: opts.profile }));
}

/** Mock mode serves the demo seed data; live mode is the client's own Zoho organization with the client's aliases. */
export function createBooks(cfg: Config, log: Logger, profile: ClientProfile = GENERIC_PROFILE): BooksApi {
  if (cfg.ZOHO_MODE === 'mock') return new MockBooks();
  return new CachedBooks(new ZohoBooks(requireZohoCredentials(cfg), { log: log.child({ component: 'zoho' }), aliases: profile.aliases }));
}

/** Live Zoho creation needs ZOHO_MODE=live AND INVOICE_ALLOW_LIVE_CREATE=true; otherwise dry run. Mock mode always "creates" in memory. */
export const isDryRun = (cfg: Config) => cfg.ZOHO_MODE === 'live' && !cfg.INVOICE_ALLOW_LIVE_CREATE;

export function createProcessor(
  cfg: Config,
  log: Logger,
  send: SendFn,
  opts: { persistState?: boolean; store?: StateStore; profile?: ClientProfile } = {},
) {
  const profile = opts.profile ?? GENERIC_PROFILE;
  return new InvoiceProcessor({
    extractor: createExtractor(cfg.LLM_MODEL, cfg, { withFallback: true, profile }),
    books: createBooks(cfg, log, profile),
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
      defaultTaxPercent: cfg.DEFAULT_TAX_PERCENT,
      invoiceConfirm: cfg.INVOICE_CONFIRM === 'always',
      invoiceApprovers: cfg.INVOICE_APPROVERS,
      customerCreators: cfg.CUSTOMER_CREATORS,
      normalizer: normalizerFor(profile),
    },
  });
}
