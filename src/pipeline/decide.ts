import type { Extraction } from '../extraction/schema.js';
import { CustomerMatcher, ItemMatcher, type MatchResult } from '../matching/matcher.js';
import type { Customer, Item, PreviousRate } from '../types.js';
import { checkGrounding } from './grounding.js';

export interface ResolvedLine {
  description: string;
  item: Item;
  quantity: number;
  rate: number;
  rateSource: 'message' | 'item_default' | 'previous_invoice';
}

export interface LineTrace {
  description: string | null;
  match: MatchResult<Item>['status'];
  itemId?: string;
  itemName?: string;
  score?: number;
  candidates: { name: string; score: number }[];
  quantity: number | null;
  rate: number | null;
}

export interface DecisionTrace {
  customer?: { query: string; status: MatchResult<Customer>['status']; id?: string; name?: string; candidates: { name: string; score: number }[] };
  lines: LineTrace[];
  problems: string[];
  repairs?: string[];
}

export interface ClarifyOption {
  lineIndex: number;
  itemId: string;
  name: string;
  /** Set when choosing this option confirms a rate taken from a previous invoice. */
  rate?: number;
}

export type Decision =
  | { kind: 'create'; customer: Customer; lines: ResolvedLine[]; notes?: string; trace: DecisionTrace }
  | { kind: 'clarify'; question: string; options: ClarifyOption[]; trace: DecisionTrace }
  | { kind: 'respond'; text: string; reason: string; trace: DecisionTrace }
  | { kind: 'ignore'; reason: string; trace: DecisionTrace };

export interface DecideOptions {
  ratePolicy: 'ask' | 'item_default';
  baseCurrency: string;
  /** Original message text (plus clarification answers); numbers in the extraction must appear in it. */
  sourceText?: string;
  /** Previous-invoice rates looked up for lines that asked for "rate same as last time" (by line index). Present = lookup was done. */
  previousRates?: Map<number, PreviousRate | null>;
}

const MAX_QTY = 10000;
const MAX_RATE = 10_000_000;
const CURRENCY_ALIASES = new Set(['inr', 'rs', 'rs.', 'rupees', 'rupee', '₹']);

export const EDIT_HELP = 'To change an invoice, reply to my invoice message with the change, e.g. "make it 6 pcs" or "rate 5000". Only drafts can be changed.';

export const fmtMoney = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const shortList = <T extends { name: string }>(r: MatchResult<T>) =>
  r.candidates.map((c) => ({ name: c.record.name, score: Math.round(c.score * 100) / 100 }));

/**
 * When the customer did not resolve, the model may have put the customer/product boundary in the wrong place
 * ("royl" + "alloys vortx 18", "gwc ku" + "apex ..."). Retry with up to 3 leading description words added (longest first),
 * then with trailing customer words dropped. Only a confident, unique match is accepted; otherwise nothing changes.
 */
function repairCustomer(ex: Extraction, matcher: CustomerMatcher): { customer: Customer; query: string; description?: string } | null {
  const words = ex.items[0]?.description?.trim().split(/\s+/) ?? [];
  const base = ex.customer?.trim() ?? '';
  for (let k = Math.min(3, words.length - 1); k >= 1; k--) {
    const query = `${base} ${words.slice(0, k).join(' ')}`.trim();
    const r = matcher.match(query);
    if (r.status === 'matched') return { customer: r.record, query, description: words.slice(k).join(' ') };
  }
  // Only filler words may be dropped ("gwc ku"); a word that exists in customer names ("VK Auto") carries meaning.
  const own = base.split(/\s+/);
  for (let k = own.length - 1; k >= 1; k--) {
    if (own.slice(k).some((w) => matcher.knowsWord(w))) break;
    const query = own.slice(0, k).join(' ');
    const r = matcher.match(query);
    if (r.status === 'matched') return { customer: r.record, query };
  }
  return null;
}

export function decide(input: Extraction, customers: Customer[], items: Item[], opts: DecideOptions): Decision {
  const ex = structuredClone(input);
  const trace: DecisionTrace = { lines: [], problems: [] };

  if (ex.intent === 'non_invoice') return { kind: 'ignore', reason: 'non_invoice', trace };
  if (ex.intent === 'edit_request') return { kind: 'respond', reason: 'edit_without_target', text: EDIT_HELP, trace };
  if (ex.intent === 'unsupported_followup' || (ex.refers_to_previous_invoice && !ex.items.length)) {
    return {
      kind: 'respond',
      reason: 'unsupported_followup',
      text: 'I can only create new invoices right now, so I can’t look up, change or reuse previous invoices. Please send a new request with customer, item, quantity and rate.',
      trace,
    };
  }

  const questions: string[] = [];
  const options: ClarifyOption[] = [];

  let customer: Customer | undefined;
  const customerMatcher = new CustomerMatcher(customers);
  if (ex.intent === 'invoice_request' || ex.intent === 'clarification_response') {
    const first = ex.customer ? customerMatcher.match(ex.customer) : null;
    // Ambiguous means real alternatives exist: never repair, always ask.
    if (first?.status !== 'matched' && first?.status !== 'ambiguous') {
      const fixed = repairCustomer(ex, customerMatcher);
      if (fixed) {
        trace.repairs = [`customer "${ex.customer ?? ''}" -> "${fixed.query}"`];
        ex.customer = fixed.query;
        if (fixed.description !== undefined && ex.items[0]) ex.items[0].description = fixed.description;
      }
    }
  }
  if (!ex.customer) {
    questions.push('Which customer is this for?');
    trace.problems.push('missing_customer');
  } else {
    const r = customerMatcher.match(ex.customer);
    trace.customer = { query: ex.customer, status: r.status, candidates: shortList(r) };
    if (r.status === 'matched') {
      customer = r.record;
      Object.assign(trace.customer, { id: r.record.id, name: r.record.name });
    } else if (r.status === 'ambiguous') {
      questions.push(`Which customer is "${ex.customer}"? ${r.candidates.slice(0, 4).map((c) => c.record.name).join(' / ')}`);
      trace.problems.push('ambiguous_customer');
    } else {
      questions.push(`I couldn't find a customer matching "${ex.customer}". Please send the full customer name.`);
      trace.problems.push('unknown_customer');
    }
  }

  if (ex.currency && !CURRENCY_ALIASES.has(ex.currency.trim().toLowerCase()) && ex.currency.toUpperCase() !== opts.baseCurrency) {
    questions.push(`Invoices are raised in ${opts.baseCurrency}; please confirm the rate in ${opts.baseCurrency} (message says ${ex.currency}).`);
    trace.problems.push('currency_mismatch');
  }

  if (!ex.items.length) {
    questions.push('Which item(s) and quantity?');
    trace.problems.push('missing_item');
  }

  const itemMatcher = new ItemMatcher(items);
  const lines: ResolvedLine[] = [];
  ex.items.forEach((li, idx) => {
    const r: MatchResult<Item> = li.description ? itemMatcher.match(li.description) : { status: 'not_found', candidates: [] };
    const lt: LineTrace = { description: li.description, match: r.status, candidates: shortList(r), quantity: li.quantity, rate: li.rate };
    trace.lines.push(lt);
    const label = r.status === 'matched' ? r.record.name : li.description ? `"${li.description}"` : 'the item';

    if (r.status === 'matched') {
      Object.assign(lt, { itemId: r.record.id, itemName: r.record.name, score: Math.round(r.score * 100) / 100 });
    } else if (r.status === 'ambiguous') {
      const topScore = r.candidates[0]?.score ?? 0;
      const opts = r.candidates.filter((c) => c.score >= topScore - 0.25).slice(0, 5);
      const start = options.length;
      opts.forEach((c) => options.push({ lineIndex: idx, itemId: c.record.id, name: c.record.name }));
      questions.push(`Which item for "${li.description}"?\n${opts.map((c, i) => `  ${start + i + 1}) ${c.record.name}`).join('\n')}`);
      trace.problems.push('ambiguous_item');
    } else if (!li.description) {
      questions.push('Which item?');
      trace.problems.push('missing_item');
    } else {
      questions.push(`I couldn't find an item matching "${li.description}". Please send the exact item name or SKU.`);
      trace.problems.push('unknown_item');
    }

    if (li.quantity === null) {
      questions.push(`Quantity for ${label}?`);
      trace.problems.push('missing_quantity');
    } else if (!Number.isInteger(li.quantity) || li.quantity <= 0 || li.quantity > MAX_QTY) {
      questions.push(`Quantity ${li.quantity} for ${label} looks invalid. Please send a whole number above 0.`);
      trace.problems.push('invalid_quantity');
    }

    let rate = li.rate;
    let rateSource: ResolvedLine['rateSource'] = li.rate_from_previous ? 'previous_invoice' : 'message';
    if (rate === null && opts.ratePolicy === 'item_default' && r.status === 'matched' && r.record.rate > 0 && !li.rate_from_previous) {
      rate = r.record.rate;
      rateSource = 'item_default';
    }
    const prev = opts.previousRates?.get(idx);
    if (rate === null && li.rate_from_previous && prev && r.status === 'matched') {
      // Never applied silently: the user confirms the exact rate and its source invoice.
      options.push({ lineIndex: idx, itemId: r.record.id, name: `Yes, ${fmtMoney(prev.rate)} (${prev.invoiceNumber})`, rate: prev.rate });
      questions.push(`Use the last rate for ${label}: ${fmtMoney(prev.rate)} (invoice ${prev.invoiceNumber}${prev.date ? `, ${prev.date}` : ''})?
  ${options.length}) Yes, use ${fmtMoney(prev.rate)}
Or reply with a different rate.`);
      trace.problems.push('confirm_previous_rate');
    } else if (rate === null) {
      questions.push(
        li.rate_from_previous
          ? opts.previousRates
            ? `I couldn't find an earlier invoice of ${label} for this customer. What rate should I use?`
            : `What rate for ${label}? (I need the customer and exact item first to look up the last rate.)`
          : `Rate for ${label}?${r.status === 'matched' && r.record.rate > 0 ? ` (list rate ${fmtMoney(r.record.rate)})` : ''}`,
      );
      trace.problems.push(li.rate_from_previous ? 'rate_from_previous' : 'missing_rate');
    } else if (rate <= 0 || rate > MAX_RATE) {
      questions.push(`Rate ${rate} for ${label} looks invalid.`);
      trace.problems.push('invalid_rate');
    }

    if (r.status === 'matched' && li.quantity !== null && rate !== null && !trace.problems.length) {
      lines.push({ description: li.description ?? r.record.name, item: r.record, quantity: li.quantity, rate, rateSource });
    }
  });

  if (opts.sourceText !== undefined) {
    for (const g of checkGrounding(ex.items, opts.sourceText, (f, v) => (f === 'rate' ? fmtMoney(v) : String(v)))) {
      questions.push(g.question);
      trace.problems.push(g.problem);
    }
  }

  if (questions.length || !customer || lines.length !== ex.items.length) {
    const header = 'Before I create the invoice, I need:';
    const unique = [...new Set(questions)];
    const body = unique.length === 1 ? unique[0]! : unique.map((q) => `• ${q}`).join('\n');
    const footer = options.length ? '\n\nReply to this message with the option number or details.' : '\n\nReply to this message with the details.';
    return { kind: 'clarify', question: `${header}\n${body}${footer}`, options, trace };
  }

  return { kind: 'create', customer, lines, notes: ex.notes ?? undefined, trace };
}
