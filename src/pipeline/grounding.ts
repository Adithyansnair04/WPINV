import type { ExtractedItem } from '../extraction/schema.js';

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, dozen: 12 };
const SHARED = /\b(both|all|same (?:rate|price)|each of them|for all)\b/i;

/** Every number written in the message, e.g. "x4 @ ₹5,200, 5.6k" -> [4, 5200, 5600]. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(/\d[\d,]*(?:\.\d+)?(?:\s*k(?![a-z]))?/g)) {
    const raw = m[0].replace(/\s/g, '');
    const n = Number(raw.replace(/,/g, '').replace(/k$/, ''));
    if (Number.isFinite(n)) out.push(raw.endsWith('k') ? n * 1000 : n);
  }
  for (const w of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) if (WORDS[w] !== undefined) out.push(WORDS[w]);
  return out;
}

export interface GroundingIssue {
  problem: 'ungrounded_quantity' | 'ungrounded_rate' | 'shared_quantity' | 'shared_rate';
  question: string;
}

/**
 * The LLM may only copy numbers, not invent or spread them: each quantity/rate must appear in the message,
 * and a value written once cannot silently apply to several different items.
 */
export function checkGrounding(items: ExtractedItem[], text: string, fmt: (field: 'quantity' | 'rate', v: number) => string): GroundingIssue[] {
  const nums = numbersIn(text);
  const count = (v: number) => nums.filter((n) => n === v).length;
  const issues: GroundingIssue[] = [];
  for (const field of ['quantity', 'rate'] as const) {
    const used = new Map<number, number>();
    for (const it of items) {
      const v = it[field];
      // A confirmed previous-invoice rate legitimately does not appear in the message.
      if (v !== null && !(field === 'rate' && it.rate_from_previous)) used.set(v, (used.get(v) ?? 0) + 1);
    }
    for (const [v, uses] of used) {
      if (!count(v)) {
        issues.push({ problem: `ungrounded_${field}`, question: `I couldn't find the ${field} ${fmt(field, v)} in your message. Please confirm the ${field}.` });
      } else if (uses > 1 && count(v) < uses && !SHARED.test(text)) {
        issues.push({
          problem: `shared_${field}`,
          question: `The ${field} ${fmt(field, v)} was written once but would apply to ${uses} different items. Please give the ${field} for each item.`,
        });
      }
    }
  }
  return issues;
}
