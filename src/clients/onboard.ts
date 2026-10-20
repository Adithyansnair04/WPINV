import type { Normalizer } from '../matching/normalize.js';
import type { Customer, Item } from '../types.js';

/**
 * Onboarding a client whose customers and items we have never seen: profile the Zoho catalogue to show where
 * the bot will have to ask (look-alike items, shared customer names) and to draft a profile for a human to approve.
 * Nothing here changes matching rules by itself.
 */
export interface CatalogueReport {
  customers: { active: number; inactive: number };
  items: { active: number; inactive: number; withoutSku: number; zeroRate: string[] };
  /** Items whose names are identical after normalisation: the bot can never tell them apart. */
  indistinguishable: string[][];
  /** Items that differ by exactly one word; requests that omit that word get a question. */
  lookAlikes: { base: string; variants: { word: string; item: string }[] }[];
  /** Words shared by several customer names: a message naming only that word gets a question. */
  sharedCustomerWords: { word: string; customers: string[] }[];
  /** Customers whose initials collide, so "VK"-style shorthand needs an explicit alias. */
  initialsCollisions: { initials: string; customers: string[] }[];
  /** Most frequent item words: candidates for the profile's keepWords. */
  vocabulary: { word: string; items: number }[];
  /** Units seen in item names (ml, kg, mm…): numbers with these are sizes, not quantities. */
  units: { unit: string; example: string }[];
  /** Tyre-size patterns or wheel/tyre vocabulary: the auto_parts normaliser pack fits. */
  autoPartsLike: boolean;
}

const UNIT = /\b(\d+(?:\.\d+)?)\s*(ml|ltr|l|kg|gm|g|mm|cm|m|inch|in|gb|tb|w|v|mah|"|ft)\b/i;
const TYRE = /\b\d{3}\s*\/\s*\d{2}\s*z?r?\s*\d{2}\b/i;

export function profileCatalogue(customers: Customer[], items: Item[], norm: Normalizer): CatalogueReport {
  const activeItems = items.filter((i) => i.active);
  const activeCustomers = customers.filter((c) => c.active);
  const tokensOf = (name: string) => [...new Set(norm.significantTokens(name).filter((t) => t !== 'and'))].sort();

  // Identical token sets
  const byKey = new Map<string, string[]>();
  for (const i of activeItems) {
    const key = tokensOf(i.name).join(' ');
    byKey.set(key, [...(byKey.get(key) ?? []), i.name]);
  }
  const indistinguishable = [...byKey.values()].filter((g) => g.length > 1);

  // Exactly one differing word: bucket each item under its name with one token removed.
  const buckets = new Map<string, { word: string; item: string }[]>();
  for (const i of activeItems) {
    const toks = tokensOf(i.name);
    if (toks.length < 2) continue;
    toks.forEach((t, idx) => {
      const base = toks.filter((_, j) => j !== idx).join(' ');
      buckets.set(base, [...(buckets.get(base) ?? []), { word: t, item: i.name }]);
    });
  }
  const lookAlikes = [...buckets.entries()]
    .filter(([, v]) => new Set(v.map((x) => x.word)).size > 1)
    .map(([base, variants]) => ({ base, variants }))
    .sort((a, b) => b.variants.length - a.variants.length);

  // Customer words used by more than one customer
  const wordCustomers = new Map<string, Set<string>>();
  for (const c of activeCustomers) for (const t of tokensOf(c.name)) if (!/\d/.test(t)) wordCustomers.set(t, (wordCustomers.get(t) ?? new Set()).add(c.name));
  const sharedCustomerWords = [...wordCustomers.entries()]
    .filter(([, s]) => s.size > 1)
    .map(([word, s]) => ({ word, customers: [...s].sort() }))
    .sort((a, b) => b.customers.length - a.customers.length || a.word.localeCompare(b.word));

  // Initials collisions (only names with 2+ words have meaningful initials)
  const byInitials = new Map<string, string[]>();
  for (const c of activeCustomers) {
    const words = norm.tokenize(c.name).filter((t) => t !== 'and');
    if (words.length < 2) continue;
    const ini = words.map((w) => w[0]).join('');
    byInitials.set(ini, [...(byInitials.get(ini) ?? []), c.name]);
  }
  const initialsCollisions = [...byInitials.entries()].filter(([, v]) => v.length > 1).map(([initials, cs]) => ({ initials, customers: cs.sort() }));

  const counts = new Map<string, number>();
  for (const i of activeItems) for (const t of tokensOf(i.name)) if (!/\d/.test(t) && t.length > 2) counts.set(t, (counts.get(t) ?? 0) + 1);
  const vocabulary = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25).map(([word, n]) => ({ word, items: n }));

  const units = new Map<string, string>();
  for (const i of activeItems) {
    const m = i.name.match(UNIT);
    if (m && !units.has(m[2]!.toLowerCase())) units.set(m[2]!.toLowerCase(), m[0]);
  }

  return {
    customers: { active: activeCustomers.length, inactive: customers.length - activeCustomers.length },
    items: {
      active: activeItems.length,
      inactive: items.length - activeItems.length,
      withoutSku: activeItems.filter((i) => !i.sku).length,
      zeroRate: activeItems.filter((i) => !(i.rate > 0)).map((i) => i.name),
    },
    indistinguishable,
    lookAlikes,
    sharedCustomerWords,
    initialsCollisions,
    vocabulary,
    units: [...units.entries()].map(([unit, example]) => ({ unit, example })),
    autoPartsLike: activeItems.some((i) => TYRE.test(i.name)) || ['wheel', 'tyre', 'tire', 'alloy', 'rim'].some((w) => counts.has(w)),
  };
}

/** A starting profile for a human to review. Business description and aliases are left for the client to confirm. */
export function draftProfile(r: CatalogueReport, business?: string) {
  const unitExamples = r.units.slice(0, 2).map((u) => `"${u.example}"`);
  return {
    _comment: 'Draft generated by npm run client:profile. Review every field; aliases must be confirmed by the client.',
    business: business ?? 'TODO: describe the business, e.g. "an Indian stationery wholesaler"',
    ...(unitExamples.length ? { notQuantity: `A size or measure like ${unitExamples.join(' or ')} is NOT a quantity.` } : {}),
    keepWords: r.vocabulary.filter((v) => v.items >= 3).slice(0, 8).map((v) => v.word),
    normalizer: { packs: r.autoPartsLike ? ['auto_parts'] : [], synonyms: {}, stopwords: [] },
    aliases: {},
  };
}

export function renderReport(r: CatalogueReport, clientName: string): string {
  const list = (xs: string[], empty: string) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : `_${empty}_`);
  return [
    `# Onboarding report: ${clientName}`,
    '',
    `Generated from the client's Zoho Books data. It shows where the bot will need to ask questions, and what to review in the client profile. Nothing here is applied automatically.`,
    '',
    '## Catalogue',
    '',
    `- Customers: ${r.customers.active} active (${r.customers.inactive} inactive, ignored)`,
    `- Items: ${r.items.active} active (${r.items.inactive} inactive, ignored), ${r.items.withoutSku} without SKU`,
    ...(r.items.zeroRate.length ? [`- Items with no selling rate (rate must always come from the message): ${r.items.zeroRate.length}`] : []),
    '',
    '## Items the bot can never tell apart',
    '',
    list(r.indistinguishable.map((g) => g.join(' / ')), 'None.'),
    '',
    'Fix these in Zoho (rename or deactivate duplicates); otherwise every request for them gets a question.',
    '',
    '## Look-alike items (differ by one word)',
    '',
    list(
      r.lookAlikes.slice(0, 20).map((g) => `**${g.base}** + ${g.variants.map((v) => `\`${v.word}\``).join(' / ')}`),
      'None.',
    ),
    ...(r.lookAlikes.length > 20 ? ['', `…and ${r.lookAlikes.length - 20} more groups.`] : []),
    '',
    'A message that leaves out the distinguishing word (colour, size, brand…) gets a numbered question. Tell the team to include it.',
    '',
    '## Customer names that share a word',
    '',
    list(r.sharedCustomerWords.slice(0, 20).map((w) => `\`${w.word}\`: ${w.customers.join(' / ')}`), 'None.'),
    '',
    'A message naming only the shared word gets a question. Ask the client for the shorthand they actually use and add it as aliases.',
    '',
    '## Initials that collide',
    '',
    list(r.initialsCollisions.map((c) => `\`${c.initials}\`: ${c.customers.join(' / ')}`), 'None: initials like "VK" will resolve on their own.'),
    '',
    '## For the profile',
    '',
    `- Frequent item words (keepWords candidates): ${r.vocabulary.slice(0, 15).map((v) => `${v.word} (${v.items})`).join(', ') || '–'}`,
    `- Units in item names: ${r.units.map((u) => `${u.unit} (e.g. "${u.example}")`).join(', ') || 'none found'}`,
    `- Wheels/tyres catalogue: ${r.autoPartsLike ? 'yes, enable the auto_parts normaliser pack' : 'no, keep the generic rules'}`,
    '',
    '## Next steps',
    '',
    '1. Review `clients/<id>/profile.json`: business description, keepWords, units sentence.',
    '2. Ask the client for the shorthand they use for customers; add only confirmed ones as aliases.',
    '3. Run in preview mode (`INVOICE_ALLOW_LIVE_CREATE=false`) in the client group for 1–2 weeks and collect real messages.',
    '4. Label 50+ of those messages and run the evaluation before allowing real drafts.',
    '',
  ].join('\n');
}
