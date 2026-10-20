import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { Normalizer, PACKS, type PackName } from '../matching/normalize.js';

/**
 * Everything client-specific that is not in Zoho: how to describe the business to the LLM, domain text rules,
 * and business-approved customer shorthand. A new client starts from the generic defaults and an empty alias list.
 */
export const ProfileSchema = z.object({
  /** Fills "You read chat messages sent to <business> …", e.g. "an Indian stationery wholesaler". */
  business: z.string().min(3).default('a business'),
  /** Example product description for the prompt, e.g. "red lenzo alloy 18 inch". */
  descriptionExample: z.string().optional(),
  /** Product word used in the leading-count example: "4 <word> ...". */
  quantityExample: z.string().optional(),
  /** Domain sentence about numbers that are NOT quantities (sizes, dimensions). */
  notQuantity: z.string().optional(),
  /** Example of a "rate same as last time" request. */
  previousRateExample: z.string().optional(),
  /** Product words the LLM must keep in descriptions. */
  keepWords: z.array(z.string()).default([]),
  normalizer: z
    .object({
      packs: z.array(z.enum(Object.keys(PACKS) as [PackName, ...PackName[]])).default([]),
      synonyms: z.record(z.string(), z.string()).default({}),
      stopwords: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Exact Zoho customer name -> approved shorthand. Matched by name at runtime; no ids stored. */
  aliases: z.record(z.string(), z.array(z.string())).default({}),
});

export type ClientProfile = z.infer<typeof ProfileSchema>;

export const GENERIC_PROFILE: ClientProfile = ProfileSchema.parse({});

/** Reads a profile JSON file; a missing path means the generic profile. Keys starting with "_" are comments. */
export function loadProfile(path?: string): ClientProfile {
  if (!path) return GENERIC_PROFILE;
  if (!existsSync(path)) throw new Error(`Client profile not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const aliases = raw.aliases && typeof raw.aliases === 'object' ? Object.fromEntries(Object.entries(raw.aliases).filter(([k]) => !k.startsWith('_'))) : raw.aliases;
  const parsed = ProfileSchema.safeParse({ ...raw, aliases });
  if (!parsed.success) throw new Error(`Invalid client profile ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export const normalizerFor = (p: ClientProfile) => new Normalizer(p.normalizer);
