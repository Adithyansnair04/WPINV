const SYNONYMS: Record<string, string> = {
  rim: 'wheel', rims: 'wheel', wheels: 'wheel', alloys: 'alloy', mag: 'alloy', mags: 'alloy',
  tyres: 'tyre', tire: 'tyre', tires: 'tyre',
  nuts: 'nut', caps: 'cap', valves: 'valve', sets: 'set',
  blk: 'black', blck: 'black', wht: 'white', slvr: 'silver', silvr: 'silver', gray: 'grey',
  gm: 'gunmetal', mat: 'matte', matt: 'matte', center: 'centre',
  ent: 'enterprises', ents: 'enterprises', enterprise: 'enterprises',
  '&': 'and',
};

/** Words that carry no identifying information in a product or customer reference. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'and', 'with', 'in', 'inch', 'inches', 'size', 'pcs', 'pc', 'piece', 'pieces',
  'nos', 'no', 'qty', 'unit', 'units', 'each', 'rate', 'rs', 'inr', 'please', 'pls', 'plz', 'bill', 'invoice', 'ms', 'm/s',
  'sir', 'bhai', 'ji', 'ko', 'type', 'model', 'new', 'x',
]);

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[“”″]/g, '"')
    .replace(/[‘’′]/g, "'")
    // tyre sizes: "195/55 R16", "195 55 16", "195-55-r16" -> 195/55r16
    .replace(/\b(\d{3})\s*[/\s-]\s*(\d{2})\s*[/\s-]?\s*(?:zr|r)?\s*(\d{2})\b/g, '$1/$2r$3')
    // pack counts: "(16 pcs)" -> 16pcs
    .replace(/\b(\d{1,3})\s*(?:pcs|pc|pieces|nos)\b/g, '$1pcs')
    // rim sizes: 18", 18'', 18 inch, 18in, r18 -> 18in
    .replace(/\b(\d{2})\s*(?:"|''|inches|inch|in)(?=[\s,.)]|$)/g, '$1in ')
    .replace(/\br(\d{2})\b/g, '$1in')
    .replace(/(^|[\s(,])(1[2-9]|2[0-4])(?=[\s,.)]|$)/g, '$1$2in')
    .replace(/[^a-z0-9/&\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(' ')
    .filter(Boolean)
    .map((t) => SYNONYMS[t] ?? t);
}

export function significantTokens(input: string): string[] {
  return tokenize(input).filter((t) => !STOPWORDS.has(t));
}

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
