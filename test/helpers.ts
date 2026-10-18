import type { Extractor } from '../src/extraction/extract.js';
import { llmExtractor } from '../src/extraction/extract.js';
import { fixture } from '../src/llm/provider.js';
import { silentLogger } from '../src/logger.js';
import { InvoiceProcessor } from '../src/pipeline/processor.js';
import { StateStore } from '../src/pipeline/state.js';
import type { IncomingMessage, Outgoing } from '../src/types.js';
import { MockBooks } from '../src/zoho/mock.js';

export const ex = (o: Record<string, unknown>) => ({
  intent: 'invoice_request',
  customer: null,
  items: [],
  currency: null,
  refers_to_previous_invoice: false,
  notes: null,
  missing: [],
  ambiguity: null,
  ...o,
});

/** Extractor whose response is chosen by the newest message text in the prompt. */
export function scripted(responses: Record<string, Record<string, unknown>>): Extractor {
  return llmExtractor(
    fixture((user) => {
      const parts = user.split('"""');
      const latest = (parts[parts.length - 2] ?? '').trim();
      const r = responses[latest];
      if (!r) throw new Error(`no scripted response for: ${latest}`);
      return r;
    }),
  );
}

let seq = 0;
export const msg = (text: string, o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `m${++seq}`,
  chatId: 'group@g.us',
  senderId: 'alice@s.whatsapp.net',
  text,
  timestamp: Date.now(),
  fromMe: false,
  ...o,
});

export function setup(extractor: Extractor, opts: { dryRun?: boolean; now?: () => number; books?: MockBooks } = {}) {
  const books = opts.books ?? new MockBooks();
  const sent: { chatId: string; out: Outgoing; quoteId?: string; id: string }[] = [];
  const store = new StateStore(undefined, opts.now);
  const processor = new InvoiceProcessor({
    extractor,
    books,
    store,
    log: silentLogger,
    now: opts.now,
    send: async (chatId, out, quoteId) => {
      const id = `bot${sent.length + 1}`;
      sent.push({ chatId, out, quoteId, id });
      return id;
    },
    options: { ratePolicy: 'ask', baseCurrency: 'INR', clarifyTtlMs: 15 * 60_000, dryRun: opts.dryRun ?? false },
  });
  return { books, sent, store, processor };
}
