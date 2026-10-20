import type { Customer, Item } from '../types.js';
import { GENERIC_NORMALIZER, levenshtein, type Normalizer, typoBudget } from './normalize.js';

export interface Candidate<T> {
  record: T;
  score: number;
  why: string[];
}

export type MatchResult<T> =
  | { status: 'matched'; record: T; score: number; why: string[]; candidates: Candidate<T>[] }
  | { status: 'ambiguous'; candidates: Candidate<T>[] }
  | { status: 'not_found'; candidates: Candidate<T>[] };

const THRESHOLDS = { accept: 0.9, margin: 0.15, candidate: 0.5 } as const;

/**
 * Scores query tokens against a record's tokens. A query token that exactly exists somewhere in the
 * catalogue vocabulary is never typo-matched to a different word (so "lenzo" never matches "lenza").
 */
function tokenScore(query: string[], recordTokens: Set<string>, vocab: Set<string>, why: string[]): number {
  if (!query.length) return 0;
  let total = 0;
  for (const q of query) {
    if (recordTokens.has(q)) {
      total += 1;
      continue;
    }
    let best = 0;
    const budget = vocab.has(q) ? 0 : typoBudget(q);
    if (budget > 0) {
      for (const t of recordTokens) {
        if (levenshtein(q, t, budget) <= budget) {
          best = 0.85;
          why.push(`typo ${q}~${t}`);
          break;
        }
      }
    }
    if (!best) why.push(`unmatched ${q}`);
    total += best;
  }
  return total / query.length;
}

function decide<T>(candidates: Candidate<T>[]): MatchResult<T> {
  candidates.sort((a, b) => b.score - a.score);
  const shortlist = candidates.filter((c) => c.score >= THRESHOLDS.candidate).slice(0, 5);
  const [top, second] = shortlist;
  if (!top) return { status: 'not_found', candidates: [] };
  if (top.score >= THRESHOLDS.accept && (!second || top.score - second.score >= THRESHOLDS.margin)) {
    return { status: 'matched', record: top.record, score: top.score, why: top.why, candidates: shortlist };
  }
  return top.score >= THRESHOLDS.accept || shortlist.length > 1
    ? { status: 'ambiguous', candidates: shortlist }
    : { status: 'not_found', candidates: shortlist };
}

const initials = (words: string[]) => words.map((w) => w[0]).join('');

export class CustomerMatcher {
  private readonly vocab: Set<string>;
  private readonly entries: { record: Customer; names: string[]; tokens: Set<string>; initials: string }[];

  constructor(
    customers: Customer[],
    private readonly norm: Normalizer = GENERIC_NORMALIZER,
  ) {
    this.entries = customers
      .filter((c) => c.active)
      .map((c) => {
        const words = this.norm.tokenize(c.name).filter((t) => t !== 'and');
        return {
          record: c,
          names: [c.name, c.companyName ?? '', ...c.aliases].filter(Boolean).map((n) => this.norm.normalizeText(n)),
          tokens: new Set(words),
          initials: initials(words),
        };
      });
    this.vocab = new Set(this.entries.flatMap((e) => [...e.tokens]));
  }

  /** True if the word means something in the customer list (exactly or as a typo of a name word). */
  knowsWord(word: string): boolean {
    return this.norm.significantTokens(word).some((t) => this.vocab.has(t) || [...this.vocab].some((v) => typoBudget(t) > 0 && levenshtein(t, v, typoBudget(t)) <= typoBudget(t)));
  }

  match(query: string): MatchResult<Customer> {
    const q = this.norm.normalizeText(query);
    const qTokens = this.norm.significantTokens(query);
    if (!q) return { status: 'not_found', candidates: [] };
    const candidates = this.entries.map(({ record, names, tokens, initials: ini }): Candidate<Customer> => {
      if (names.includes(q)) return { record, score: 1, why: ['exact name/alias'] };
      if (q.replace(/\s/g, '') === ini && ini.length >= 2) return { record, score: 0.92, why: ['initials'] };
      const why: string[] = [];
      return { record, score: tokenScore(qTokens, tokens, this.vocab, why), why };
    });
    return decide(candidates);
  }
}

export class ItemMatcher {
  private readonly vocab: Set<string>;
  private readonly entries: { record: Item; tokens: Set<string>; sku?: string }[];

  constructor(
    items: Item[],
    private readonly norm: Normalizer = GENERIC_NORMALIZER,
  ) {
    this.entries = items
      .filter((i) => i.active)
      .map((i) => ({ record: i, tokens: new Set(this.norm.tokenize(i.name)), sku: i.sku?.toLowerCase() }));
    this.vocab = new Set(this.entries.flatMap((e) => [...e.tokens]));
  }

  match(description: string): MatchResult<Item> {
    const raw = description.trim().toLowerCase();
    if (raw.startsWith('id:')) {
      const byId = this.entries.find((e) => e.record.id.toLowerCase() === raw.slice(3));
      return byId
        ? { status: 'matched', record: byId.record, score: 1, why: ['selected option'], candidates: [] }
        : { status: 'not_found', candidates: [] };
    }
    const bySku = this.entries.find((e) => e.sku && e.sku === raw);
    if (bySku) return { status: 'matched', record: bySku.record, score: 1, why: ['sku'], candidates: [] };
    const qTokens = this.norm.significantTokens(description);
    if (!qTokens.length) return { status: 'not_found', candidates: [] };
    return decide(
      this.entries.map(({ record, tokens }) => {
        const why: string[] = [];
        return { record, score: tokenScore(qTokens, tokens, this.vocab, why), why };
      }),
    );
  }
}
