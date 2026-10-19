import type { Extractor } from './extract.js';
import { Extraction, type ExtractedItem } from './schema.js';

/**
 * Regex baseline with no LLM. Used for offline demos and as an evaluation baseline; it is
 * intentionally simple so the comparison with real models is honest.
 */
const PREVIOUS = /\b(last time|yesterday|previous|same as|where is|make it|cancel|resend|reissue|last invoice|last bill)\b/i;
const QTY = /\bx\s*(\d+)\b|\b(\d+)\s*(?:pcs|pc|nos|no|sets?|pieces|units)\b|\bqty\.?\s*(\d+)\b|^\s*(\d{1,3})\s+(?=[a-z])/i;
const RATE = /(?:rate|@|rs\.?|₹|inr)\s*:?\s*(-?[\d,]+(?:\.\d+)?)\s*(k)?\b|\b([\d,]{3,}(?:\.\d+)?)\s*(?:each|per\s*(?:pc|piece|unit)|rs|\/-)/i;
const CUSTOMER = /\b(?:customer|party|bill to|invoice to|for)\s*:?\s+([a-z][a-z .&]+?)(?=\s*(?:[,:\-\n]|$|\d))/i;

const num = (s: string | undefined) => (s === undefined ? null : Number(s.replace(/,/g, '')));

function rulesExtract(text: string): Extraction {
  const base = { customer: null, items: [], currency: null, refers_to_previous_invoice: false, notes: null, missing: [], ambiguity: null };
  if (PREVIOUS.test(text)) return Extraction.parse({ ...base, intent: 'unsupported_followup', refers_to_previous_invoice: true });
  if (!/\d/.test(text)) return Extraction.parse({ ...base, intent: 'non_invoice' });

  let body = text;
  let customer: string | null = null;
  const c = text.match(CUSTOMER);
  if (c) {
    customer = c[1]!.trim();
    body = body.replace(c[0], ' ');
  } else {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const sep = text.match(/^([a-z][a-z .&]+?)\s*[-:–]\s+/i);
    if (lines.length > 1 && !/\d/.test(lines[0]!)) {
      customer = lines[0]!;
      body = lines.slice(1).join('\n');
    } else if (sep) {
      customer = sep[1]!.trim();
      body = text.slice(sep[0].length);
    }
  }

  let sharedRate: number | null = null;
  const items: ExtractedItem[] = [];
  for (const seg of body.split(/\n|,|;/).map((s) => s.trim()).filter(Boolean)) {
    const q = seg.match(QTY);
    const r = seg.match(RATE);
    const rate = r ? (num(r[1] ?? r[3]) ?? 0) * (r[2] ? 1000 : 1) : null;
    let desc = seg;
    if (q) desc = desc.replace(q[0], ' ');
    if (r) desc = desc.replace(r[0], ' ');
    desc = desc.replace(/\b(rate|qty|pls|please|bill|make)\b/gi, ' ').replace(/[^\w"/ .&-]/g, ' ').replace(/\s+/g, ' ').trim();
    const quantity = q ? num(q[1] ?? q[2] ?? q[3] ?? q[4]) : null;
    if (desc.length < 2 || /^\d+$/.test(desc)) {
      if (rate !== null) sharedRate = rate;
      if (quantity !== null && items.length) items[items.length - 1]!.quantity ??= quantity;
      continue;
    }
    items.push({ description: desc, quantity, rate, rate_from_previous: false });
  }
  if (sharedRate !== null && items.length === 1 && items[0]!.rate === null) items[0]!.rate = sharedRate;

  const missing = [!customer && 'customer', !items.length && 'item', items.some((i) => i.quantity === null) && 'quantity', items.some((i) => i.rate === null) && 'rate'].filter(
    Boolean,
  ) as string[];
  return Extraction.parse({ ...base, intent: items.length || customer ? 'invoice_request' : 'non_invoice', customer, items, missing });
}

export const rulesExtractor: Extractor = {
  id: 'rules:baseline',
  async extract(text, pending) {
    const started = performance.now();
    // The baseline merges a clarification answer by re-reading the original text plus the answer.
    const alone = rulesExtract(text);
    const extraction =
      pending && alone.intent !== 'unsupported_followup' && !alone.customer && /\d/.test(text)
        ? rulesExtract(`${pending.originalText.replace(/\n\[answer\] /g, '\n')}\n${text}`)
        : alone;
    if (pending && extraction !== alone && extraction.intent === 'invoice_request') extraction.intent = 'clarification_response';
    return { ok: true, extraction, meta: { model: 'rules:baseline', latencyMs: performance.now() - started, attempts: 1, retries: 0, rateLimited: 0, invalidOutputs: 0 } };
  },
};
