/** Shorthand every client uses: colour abbreviations, business suffixes, plurals of generic words. */
const BASE_SYNONYMS: Record<string, string> = {
  sets: 'set', blk: 'black', blck: 'black', wht: 'white', slvr: 'silver', silvr: 'silver', gray: 'grey',
  ent: 'enterprises', ents: 'enterprises', enterprise: 'enterprises',
  '&': 'and',
};

/** Words that carry no identifying information in a product or customer reference. */
const BASE_STOPWORDS = [
  'a', 'an', 'the', 'of', 'for', 'to', 'and', 'with', 'in', 'inch', 'inches', 'size', 'pcs', 'pc', 'piece', 'pieces',
  'nos', 'no', 'qty', 'unit', 'units', 'each', 'rate', 'rs', 'inr', 'please', 'pls', 'plz', 'bill', 'invoice', 'ms', 'm/s',
  'sir', 'bhai', 'ji', 'ko', 'type', 'model', 'new', 'x',
];

/** Optional domain packs, enabled per client in its profile. */
export const PACKS = {
  /** Wheels and tyres: tyre sizes ("195/55 R16"), rim sizes (r18, a bare 12–24 means inches) and trade synonyms. */
  auto_parts: {
    synonyms: {
      rim: 'wheel', rims: 'wheel', wheels: 'wheel', alloys: 'alloy', mag: 'alloy', mags: 'alloy',
      tyres: 'tyre', tire: 'tyre', tires: 'tyre', nuts: 'nut', caps: 'cap', valves: 'valve',
      gm: 'gunmetal', mat: 'matte', matt: 'matte', center: 'centre',
    } as Record<string, string>,
  },
} as const;
export type PackName = keyof typeof PACKS;

export interface NormalizerOptions {
  packs?: PackName[];
  /** Extra client shorthand, e.g. { "dolo": "paracetamol" }. Keys and values are lowercase single words. */
  synonyms?: Record<string, string>;
  stopwords?: string[];
}

/** Turns customer names, item names and message fragments into comparable tokens, per client. */
export class Normalizer {
  private readonly synonyms: Record<string, string>;
  private readonly stopwords: Set<string>;
  private readonly autoParts: boolean;

  constructor(opts: NormalizerOptions = {}) {
    const packs = opts.packs ?? [];
    this.autoParts = packs.includes('auto_parts');
    this.synonyms = { ...BASE_SYNONYMS, ...Object.assign({}, ...packs.map((p) => PACKS[p].synonyms)), ...(opts.synonyms ?? {}) };
    this.stopwords = new Set([...BASE_STOPWORDS, ...(opts.stopwords ?? [])]);
  }

  normalizeText(input: string): string {
    let s = input.toLowerCase().replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
    // tyre sizes: "195/55 R16", "195 55 16", "195-55-r16" -> 195/55r16
    if (this.autoParts) s = s.replace(/\b(\d{3})\s*[/\s-]\s*(\d{2})\s*[/\s-]?\s*(?:zr|r)?\s*(\d{2})\b/g, '$1/$2r$3');
    // pack counts: "(16 pcs)" -> 16pcs
    s = s.replace(/\b(\d{1,3})\s*(?:pcs|pc|pieces|nos)\b/g, '$1pcs');
    // explicit inches: 18", 18'', 18 inch, 18in -> 18in
    s = s.replace(/\b(\d{2})\s*(?:"|''|inches|inch|in)(?=[\s,.)]|$)/g, '$1in ');
    if (this.autoParts) {
      // rim sizes: r18 -> 18in, and a bare 12–24 next to wheel words means inches
      s = s.replace(/\br(\d{2})\b/g, '$1in').replace(/(^|[\s(,])(1[2-9]|2[0-4])(?=[\s,.)]|$)/g, '$1$2in');
    }
    return s
      .replace(/[^a-z0-9/&\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  tokenize(input: string): string[] {
    return this.normalizeText(input)
      .split(' ')
      .filter(Boolean)
      .map((t) => this.synonyms[t] ?? t);
  }

  significantTokens(input: string): string[] {
    return this.tokenize(input).filter((t) => !this.stopwords.has(t));
  }
}

/** For clients without a profile: no domain assumptions. */
export const GENERIC_NORMALIZER = new Normalizer();
/** The wheels-and-tyres demo client (seed data, evaluation sets). */
export const AUTO_PARTS_NORMALIZER = new Normalizer({ packs: ['auto_parts'] });

/** Optimal-string-alignment distance: insert, delete, substitute, or swap two adjacent letters ("tyers" -> "tyres") each cost 1. */
export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return Math.min(prev[b.length]!, max + 1);
}

const isNumeric = (t: string) => /\d/.test(t);

/** Edit distance allowed for a typo: none for short or numeric tokens. */
export function typoBudget(token: string): number {
  if (isNumeric(token) || token.length < 4) return 0;
  return token.length >= 8 ? 2 : 1;
}
