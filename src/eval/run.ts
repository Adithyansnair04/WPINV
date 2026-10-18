import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createExtractor } from '../app.js';
import { loadConfig } from '../config.js';
import type { Extractor } from '../extraction/extract.js';
import { Extraction } from '../extraction/schema.js';
import { silentLogger } from '../logger.js';
import { InvoiceProcessor, type ProcessResult } from '../pipeline/processor.js';
import { StateStore } from '../pipeline/state.js';
import { sleep } from '../http.js';
import { MockBooks } from '../zoho/mock.js';
import { computeMetrics, type CaseResult, type EvalCase, type TurnResult, toEvalAction } from './metrics.js';
import { renderSummary } from './report.js';

/**
 * Runs the labeled cases through each model against mocked Zoho data (no network to Zoho, no WhatsApp).
 * Usage: npm run eval -- [--models rules,gemini:gemini-3.1-flash-lite] [--cases S01,B01] [--set main|holdout] [--retry-errors]
 *   --set holdout   runs eval/holdout.json (written before tuning; no gold, so no oracle) into eval/results/holdout/
 *   --retry-errors  keeps earlier results and re-runs only cases that were blocked by provider quota/rate limits
 */
const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    cases: { type: 'string' },
    set: { type: 'string', default: 'main' },
    'retry-errors': { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
  },
});
const cfg = loadConfig();
const SET = values.set === 'holdout' ? 'holdout' : 'main';
const RESULTS = SET === 'holdout' ? 'eval/results/holdout' : 'eval/results';
const DEFAULT_MODELS = ['oracle', 'rules', 'gemini:gemini-3.1-flash-lite', 'gemini:gemini-3-flash-preview'];
const models = values.models?.split(',').map((s) => s.trim()).filter(Boolean) ?? (cfg.EVAL_MODELS.length ? cfg.EVAL_MODELS : DEFAULT_MODELS);
const filter = values.cases?.split(',');
const cases = (JSON.parse(readFileSync(SET === 'holdout' ? 'eval/holdout.json' : 'eval/cases.json', 'utf8')) as EvalCase[]).filter(
  (c) => !filter || filter.includes(c.id),
);
mkdirSync(RESULTS, { recursive: true });

type GoldTurn = [string, string | null, [string, number | null, number | null][], { currency?: string; prev?: boolean }?];
const gold = SET === 'main' ? (JSON.parse(readFileSync('eval/gold.json', 'utf8')) as Record<string, GoldTurn[]>) : null;

/** Returns the labeled ideal extraction for each turn: isolates matching/decision quality from the LLM. */
function oracleFor(c: EvalCase): Extractor {
  const byText = new Map(
    c.turns.map((t, i) => {
      const [intent, customer, items, o = {}] = gold![c.id]![i]!;
      const extraction = Extraction.parse({
        intent,
        customer,
        currency: o.currency ?? null,
        refers_to_previous_invoice: Boolean(o.prev),
        items: items.map(([description, quantity, rate]) => ({ description, quantity, rate, rate_from_previous: Boolean(o.prev) })),
      });
      return [typeof t === 'string' ? t : t.text, extraction] as const;
    }),
  );
  return {
    id: 'oracle',
    async extract(text) {
      const extraction = byText.get(text);
      if (!extraction) throw new Error(`no gold extraction for ${c.id}`);
      return { ok: true, extraction: structuredClone(extraction), meta: { model: 'oracle', latencyMs: 0, attempts: 1, retries: 0, rateLimited: 0, invalidOutputs: 0 } };
    },
  };
}

async function runCase(extractor: Extractor, c: EvalCase, delayMs: number): Promise<CaseResult> {
  const books = new MockBooks();
  const skuById = new Map(books.items.map((i) => [i.id, i.sku!]));
  let lastQuestion: string | undefined;
  let n = 0;
  const processor = new InvoiceProcessor({
    extractor,
    books,
    store: new StateStore(),
    log: silentLogger,
    send: async (_chat, out) => {
      const id = `${c.id}-bot-${++n}`;
      if (out.text.startsWith('Before I create the invoice')) lastQuestion = id;
      return id;
    },
    options: { ratePolicy: 'ask', baseCurrency: cfg.BASE_CURRENCY, clarifyTtlMs: 15 * 60_000, dryRun: false },
  });

  const turns: TurnResult[] = [];
  let last: ProcessResult | undefined;
  for (const [i, t] of c.turns.entries()) {
    const turn = typeof t === 'string' ? { text: t } : t;
    const started = performance.now();
    last = await processor.handle({
      id: `${c.id}-${i}`,
      chatId: 'eval@g.us',
      senderId: `${turn.sender ?? 'alice'}@s.whatsapp.net`,
      text: turn.text,
      timestamp: Date.now(),
      fromMe: false,
      quotedId: turn.quote ? lastQuestion : undefined,
    });
    const usedModel = Boolean(last.extractMeta);
    turns.push({
      action: toEvalAction(last.action),
      reason: last.reason,
      latencyMs: Math.round(performance.now() - started),
      usedModel,
      meta: last.extractMeta,
      error: last.error,
    });
    if (usedModel && delayMs) await sleep(delayMs);
  }

  const trace = last?.decision?.trace;
  const inv = books.created[0];
  return {
    id: c.id,
    category: c.category,
    turns,
    intent: last?.extraction?.intent,
    extractedItems: last?.extraction?.items.map((i) => ({ description: i.description, quantity: i.quantity, rate: i.rate })) ?? [],
    resolvedCustomer: trace?.customer?.status === 'matched' ? trace.customer.name! : null,
    resolvedLines: trace?.lines.map((l) => ({ status: l.match, sku: l.itemId ? skuById.get(l.itemId) ?? null : null })) ?? [],
    problems: trace?.problems ?? [],
    invoice: inv && {
      customer: inv.customerName,
      lines: inv.lines.map((l) => ({ sku: books.items.find((i) => i.name === l.name)?.sku ?? l.name, quantity: l.quantity, rate: l.rate })),
    },
  };
}

for (const spec of models) {
  const file = join(RESULTS, `${spec.replace(/[^a-z0-9.-]+/gi, '_')}.json`);
  let extractor: Extractor | undefined;
  try {
    if (spec !== 'oracle') extractor = createExtractor(spec, cfg);
  } catch (e) {
    const reason = (e as Error).message;
    console.log(`\n[${spec}] NOT RUN: ${reason}`);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ model: spec, status: 'not_run', reason, timestamp: new Date().toISOString() }, null, 2));
    continue;
  }
  if (!extractor && !gold) {
    console.log(`\n[${spec}] NOT RUN: this case set has no gold extractions`);
    continue;
  }
  const quotaBlocked = (r: CaseResult) => r.turns.some((t) => t.reason === 'extract_rate_limit');
  const previous = new Map<string, CaseResult>();
  if (values['retry-errors'] && existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, 'utf8')) as { results?: CaseResult[] };
    for (const r of prev.results ?? []) if (!quotaBlocked(r)) previous.set(r.id, r);
  }
  const todo = cases.filter((c) => !previous.has(c.id));
  console.log(`\n[${spec}] running ${todo.length} cases${previous.size ? ` (reusing ${previous.size} earlier cases)` : ''}...`);
  const results: CaseResult[] = cases.filter((c) => previous.has(c.id)).map((c) => previous.get(c.id)!);
  const blocked: string[] = [];
  let streak = 0;
  for (const c of todo) {
    if (streak >= 3) {
      blocked.push(c.id);
      continue;
    }
    const r = await runCase(extractor ?? oracleFor(c), c, extractor && extractor.id !== 'rules:baseline' ? cfg.EVAL_DELAY_MS : 0);
    if (quotaBlocked(r)) {
      streak++;
      blocked.push(c.id);
      if (streak === 3) console.log(`  stopping ${spec}: 3 consecutive quota/rate-limit failures; re-run later with --retry-errors`);
    } else {
      streak = 0;
    }
    results.push(r);
    if (values.verbose) console.log(`  ${c.id} ${r.turns.map((t) => t.action).join('>')} (expected ${c.expected_first ? `${c.expected_first}>` : ''}${c.expected.action}) ${r.turns.map((t) => `${t.latencyMs}ms`).join('/')}`);
  }
  // Quota-blocked cases say nothing about model quality: they are excluded from metrics and reported as coverage.
  const scored = results.filter((r) => !quotaBlocked(r));
  const metrics = computeMetrics(cases, scored);
  const partial = Boolean(filter) || blocked.length > 0;
  writeFileSync(file, JSON.stringify({ model: spec, status: 'ok', timestamp: new Date().toISOString(), caseCount: cases.length, casesScored: scored.length, blocked, partial, metrics, results }, null, 2));
  if (blocked.length) console.log(`  ${blocked.length} case(s) blocked by quota/rate limits: ${blocked.join(' ')}`);
  console.log(JSON.stringify(metrics.headline, null, 2));
}

const all = readdirSync(RESULTS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(RESULTS, f), 'utf8')));
writeFileSync(join(RESULTS, 'summary.md'), renderSummary(all, cases, SET));
console.log(`\nWrote ${RESULTS}/summary.md`);
