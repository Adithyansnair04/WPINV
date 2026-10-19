import type { ExtractMeta } from '../extraction/extract.js';
import type { Action } from '../pipeline/processor.js';

export type EvalAction = 'create' | 'clarify' | 'respond' | 'ignore' | 'error';

export interface EvalCase {
  id: string;
  category: string;
  turns: (string | { text: string; quote?: boolean; sender?: string })[];
  expected_first?: EvalAction;
  expected: {
    action: EvalAction;
    acceptable?: EvalAction[];
    customer?: string | null;
    items?: { sku: string | null; quantity?: number | null; rate?: number | null }[];
  };
  note?: string;
}

export interface TurnResult {
  action: EvalAction;
  reason?: string;
  latencyMs: number;
  usedModel: boolean;
  meta?: ExtractMeta;
  error?: string;
}

export interface CaseResult {
  id: string;
  category: string;
  turns: TurnResult[];
  intent?: string;
  extractedItems: { description: string | null; quantity: number | null; rate: number | null }[];
  resolvedCustomer: string | null;
  resolvedLines: { status: string; sku: string | null }[];
  problems: string[];
  invoice?: { customer: string; lines: { sku: string; quantity: number; rate: number }[] };
}

export const toEvalAction = (a: Action): EvalAction =>
  a === 'created' || a === 'existing' || a === 'edited' || a === 'dry_run' ? 'create' : a === 'duplicate' ? 'ignore' : a;

const INTENT_FOR: Record<string, string> = { create: 'invoice_request', clarify: 'invoice_request', ignore: 'non_invoice', respond: 'unsupported_followup' };

const ratio = (num: number, den: number) => ({ num, den, pct: den ? Math.round((num / den) * 1000) / 10 : null });

function percentile(xs: number[], p: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

function invoiceMatches(c: EvalCase, r: CaseResult): boolean {
  const exp = c.expected;
  if (!r.invoice || exp.action !== 'create' || !exp.items) return false;
  if (r.invoice.customer !== exp.customer || r.invoice.lines.length !== exp.items.length) return false;
  return exp.items.every((e, i) => {
    const l = r.invoice!.lines[i]!;
    return l.sku === e.sku && l.quantity === e.quantity && l.rate === e.rate;
  });
}

export function computeMetrics(cases: EvalCase[], results: CaseResult[]) {
  const byId = new Map(results.map((r) => [r.id, r]));
  let custOk = 0, custN = 0, itemOk = 0, itemN = 0, qtyOk = 0, qtyN = 0, rateOk = 0, rateN = 0, lineCountOk = 0, lineCountN = 0;
  let intentOk = 0, intentN = 0, actionOk = 0;
  let clarifyNeed = 0, clarifyAsked = 0, createExpected = 0, unnecessaryClarify = 0;
  let confidentlyWrong = 0, nonInvoice = 0, nonInvoiceFP = 0, invoiceExact = 0;
  const wrongIds: string[] = [];
  const perCategory: Record<string, { ok: number; n: number }> = {};

  for (const c of cases) {
    const r = byId.get(c.id);
    if (!r) continue;
    const exp = c.expected;
    const final = r.turns[r.turns.length - 1]!;
    const allowed = [exp.action, ...(exp.acceptable ?? [])];
    const firstOk = !c.expected_first || r.turns[0]?.action === c.expected_first;
    const ok = allowed.includes(final.action) && firstOk;
    if (ok) actionOk++;
    (perCategory[c.category] ??= { ok: 0, n: 0 }).n++;
    if (ok) perCategory[c.category]!.ok++;

    // Extraction stage
    const multi = c.turns.length > 1;
    if (r.intent && !(multi && exp.action !== 'create')) {
      intentN++;
      const want = multi ? ['clarification_response'] : allowed.map((a) => INTENT_FOR[a]);
      if (want.includes(r.intent)) intentOk++;
    }
    if (exp.items) {
      lineCountN++;
      if (r.extractedItems.length === exp.items.length) lineCountOk++;
      exp.items.forEach((e, i) => {
        const x = r.extractedItems[i];
        if (e.quantity !== undefined) {
          qtyN++;
          if (x && x.quantity === e.quantity) qtyOk++;
        }
        if (e.rate !== undefined) {
          rateN++;
          if (x && x.rate === e.rate) rateOk++;
        }
      });
    }

    // Record-matching stage
    if (exp.customer !== undefined) {
      custN++;
      if (r.resolvedCustomer === exp.customer) custOk++;
    }
    if (exp.items) {
      if (!exp.items.length) {
        itemN++;
        if (!r.resolvedLines.some((l) => l.status === 'matched')) itemOk++;
      }
      exp.items.forEach((e, i) => {
        itemN++;
        const l = r.resolvedLines[i];
        const correct = e.sku === null ? !l || l.status !== 'matched' : l?.status === 'matched' && l.sku === e.sku;
        if (correct && r.resolvedLines.length <= exp.items!.length) itemOk++;
      });
    }

    // Decision stage
    const clarifyTurns = [
      ...(c.expected_first === 'clarify' ? [r.turns[0]!] : []),
      ...(exp.action === 'clarify' && !exp.acceptable ? [final] : []),
    ];
    clarifyNeed += clarifyTurns.length;
    clarifyAsked += clarifyTurns.filter((t) => t.action === 'clarify').length;
    if (exp.action === 'create') {
      createExpected++;
      if (final.action === 'clarify') unnecessaryClarify++;
      if (invoiceMatches(c, r)) invoiceExact++;
    }
    if (r.invoice && !invoiceMatches(c, r)) {
      confidentlyWrong++;
      wrongIds.push(c.id);
    }
    if (exp.action === 'ignore' || exp.action === 'respond') {
      nonInvoice++;
      if (r.turns.some((t) => (t.action === 'create' || t.action === 'clarify') && !allowed.includes(t.action))) nonInvoiceFP++;
    }
  }

  const modelTurns = results.flatMap((r) => r.turns.filter((t) => t.usedModel));
  const lat = modelTurns.map((t) => t.latencyMs);
  const metas = modelTurns.map((t) => t.meta!).filter(Boolean);
  const headline = {
    action_accuracy: ratio(actionOk, results.length),
    customer_match_accuracy: ratio(custOk, custN),
    item_match_accuracy: ratio(itemOk, itemN),
    quantity_accuracy: ratio(qtyOk, qtyN),
    rate_accuracy: ratio(rateOk, rateN),
    clarification_recall: ratio(clarifyAsked, clarifyNeed),
    unnecessary_clarification_rate: ratio(unnecessaryClarify, createExpected),
    confidently_wrong_invoices: confidentlyWrong,
    non_invoice_false_positives: ratio(nonInvoiceFP, nonInvoice),
    exact_invoice_rate: ratio(invoiceExact, createExpected),
  };
  return {
    headline,
    extraction: { intent_accuracy: ratio(intentOk, intentN), line_count_accuracy: ratio(lineCountOk, lineCountN), quantity_accuracy: headline.quantity_accuracy, rate_accuracy: headline.rate_accuracy },
    matching: { customer_match_accuracy: headline.customer_match_accuracy, item_match_accuracy: headline.item_match_accuracy },
    latency_ms: {
      model_turns: lat.length,
      mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      max: lat.length ? Math.max(...lat) : null,
      total: lat.reduce((a, b) => a + b, 0),
    },
    reliability: {
      model_failures: modelTurns.filter((t) => t.action === 'error').length,
      invalid_outputs: metas.reduce((s, m) => s + m.invalidOutputs, 0),
      http_retries: metas.reduce((s, m) => s + m.retries, 0),
      rate_limit_events: metas.reduce((s, m) => s + m.rateLimited, 0),
    },
    confidently_wrong_case_ids: wrongIds,
    per_category: perCategory,
  };
}
