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
export const STOPWORDS = new Set([
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

export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

const isNumeric = (t: string) => /\d/.test(t);

/** Edit distance allowed for a typo: none for short or numeric tokens. */
export function typoBudget(token: string): number {
  if (isNumeric(token) || token.length < 4) return 0;
  return token.length >= 8 ? 2 : 1;
}
