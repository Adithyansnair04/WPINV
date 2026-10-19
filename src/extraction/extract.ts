import { HttpError } from '../http.js';
import type { LlmProvider } from '../llm/provider.js';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.js';
import { Extraction } from './schema.js';

export interface PendingContext {
  originalText: string;
  question: string;
}

export interface ExtractMeta {
  model: string;
  latencyMs: number;
  attempts: number;
  retries: number;
  rateLimited: number;
  invalidOutputs: number;
  /** Set when the primary model failed and this result came from the fallback model. */
  fallbackFrom?: string;
  primaryError?: string;
}

export type ExtractOutcome =
  | { ok: true; extraction: Extraction; meta: ExtractMeta }
  | { ok: false; error: string; category: string; meta: ExtractMeta };

export interface Extractor {
  id: string;
  extract(text: string, pending?: PendingContext): Promise<ExtractOutcome>;
}

export function parseExtraction(raw: string): { ok: true; value: Extraction } | { ok: false; error: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, error: 'no JSON object in output' };
  let json: unknown;
  try {
    json = JSON.parse(match[0]);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const parsed = Extraction.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, value: parsed.data };
}

/** Tries the primary extractor; on any failure (overload, rate limit, timeout, unusable output) asks the fallback once. */
export function withFallback(primary: Extractor, fallback: Extractor): Extractor {
  return {
    id: `${primary.id} (fallback ${fallback.id})`,
    async extract(text, pending) {
      const first = await primary.extract(text, pending);
      if (first.ok) return first;
      const second = await fallback.extract(text, pending);
      const meta: ExtractMeta = {
        ...second.meta,
        latencyMs: first.meta.latencyMs + second.meta.latencyMs,
        attempts: first.meta.attempts + second.meta.attempts,
        retries: first.meta.retries + second.meta.retries,
        rateLimited: first.meta.rateLimited + second.meta.rateLimited,
        invalidOutputs: first.meta.invalidOutputs + second.meta.invalidOutputs,
        fallbackFrom: primary.id,
        primaryError: `${first.category}: ${first.error.slice(0, 120)}`,
      };
      return second.ok ? { ...second, meta } : { ...second, error: `primary: ${first.error.slice(0, 120)}; fallback: ${second.error}`, meta };
    },
  };
}

/** LLM-backed extractor: one corrective retry when the output is not valid JSON for the schema. */
export function llmExtractor(llm: LlmProvider, maxAttempts = 2): Extractor {
  return {
    id: llm.id,
    async extract(text, pending) {
      const meta: ExtractMeta = { model: llm.id, latencyMs: 0, attempts: 0, retries: 0, rateLimited: 0, invalidOutputs: 0 };
      let user = buildUserPrompt(text, pending);
      let lastError = '';
      while (meta.attempts < maxAttempts) {
        meta.attempts++;
        try {
          const r = await llm.complete(SYSTEM_PROMPT, user);
          meta.latencyMs += r.latencyMs;
          meta.retries += r.retries;
          meta.rateLimited += r.rateLimited;
          const parsed = parseExtraction(r.text);
          if (parsed.ok) return { ok: true, extraction: parsed.value, meta };
          meta.invalidOutputs++;
          lastError = parsed.error;
          user = `${buildUserPrompt(text, pending)}\n\nYour previous output was invalid (${parsed.error.slice(0, 200)}). Return only the JSON object.`;
        } catch (e) {
          const stats = (e as { stats?: { retries: number; rateLimited: number } }).stats;
          if (stats) {
            meta.retries += stats.retries;
            meta.rateLimited += stats.rateLimited;
          }
          const category = e instanceof HttpError ? e.category : 'unknown';
          return { ok: false, error: (e as Error).message.slice(0, 300), category, meta };
        }
      }
      return { ok: false, error: lastError, category: 'validation', meta };
    },
  };
}
