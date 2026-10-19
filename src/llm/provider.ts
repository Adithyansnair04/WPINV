import type { Config } from '../config.js';
import { fetchWithRetry, HttpError, categorize, type RetryStats } from '../http.js';

export interface LlmResult {
  text: string;
  latencyMs: number;
  retries: number;
  rateLimited: number;
}

export interface LlmProvider {
  id: string;
  complete(system: string, user: string): Promise<LlmResult>;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, maxRetries = 3) {
  const stats: RetryStats = { retries: 0, rateLimited: 0 };
  const started = performance.now();
  const { res, body: text } = await fetchWithRetry(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    { timeoutMs, stats, maxRetries, baseDelayMs: 1000 },
  );
  if (!res.ok) {
    if (res.status === 429) stats.rateLimited++;
    const err = new HttpError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, categorize(res.status), res.status);
    throw Object.assign(err, { stats });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new HttpError('LLM returned non-JSON HTTP body', 'validation'), { stats });
  }
  return { json, stats, latencyMs: performance.now() - started };
}

/** Mistral, Groq, OpenRouter and any other OpenAI-compatible /chat/completions endpoint. */
export function openAiCompatible(id: string, baseUrl: string, apiKey: string, model: string, timeoutMs: number, maxRetries = 3): LlmProvider {
  return {
    id,
    async complete(system, user) {
      const { json, stats, latencyMs } = await postJson(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        timeoutMs,
        maxRetries,
      );
      const text = (json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new HttpError('LLM response missing message content', 'validation');
      return { text, latencyMs, ...stats };
    },
  };
}

export function gemini(id: string, apiKey: string, model: string, timeoutMs: number, maxRetries = 3): LlmProvider {
  return {
    id,
    async complete(system, user) {
      const { json, stats, latencyMs } = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        },
        timeoutMs,
        maxRetries,
      );
      const parts = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts;
      const text = parts?.map((p) => p.text ?? '').join('');
      if (!text) throw new HttpError('Gemini response missing text', 'validation');
      return { text, latencyMs, ...stats };
    },
  };
}

/** Returns a canned response; used by tests. */
export function fixture(responder: (user: string) => string | object): LlmProvider {
  return {
    id: 'fixture',
    async complete(_system, user) {
      const r = responder(user);
      return { text: typeof r === 'string' ? r : JSON.stringify(r), latencyMs: 0, retries: 0, rateLimited: 0 };
    },
  };
}

/** Builds a provider from "provider:model", e.g. "mistral:mistral-small-latest" or "gemini:gemini-2.5-flash-lite". */
/** tuning: a primary model with a fallback fails faster (fewer retries, shorter timeout) so the fallback can answer quickly. */
export function createProvider(spec: string, cfg: Config, tuning: { timeoutMs?: number; maxRetries?: number } = {}): LlmProvider {
  const timeoutMs = tuning.timeoutMs ?? cfg.LLM_TIMEOUT_MS;
  const maxRetries = tuning.maxRetries ?? 3;
  const idx = spec.indexOf(':');
  const provider = idx > 0 ? spec.slice(0, idx) : spec;
  const model = idx > 0 ? spec.slice(idx + 1) : '';
  const need = (key: string | undefined, name: string) => {
    if (!key) throw new Error(`${name} is not set (required for model ${spec})`);
    return key;
  };
  switch (provider) {
    case 'mistral':
      return openAiCompatible(spec, 'https://api.mistral.ai/v1', need(cfg.MISTRAL_API_KEY, 'MISTRAL_API_KEY'), model, timeoutMs, maxRetries);
    case 'groq':
      return openAiCompatible(spec, 'https://api.groq.com/openai/v1', need(cfg.GROQ_API_KEY, 'GROQ_API_KEY'), model, timeoutMs, maxRetries);
    case 'openrouter':
      return openAiCompatible(spec, 'https://openrouter.ai/api/v1', need(cfg.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY'), model, timeoutMs, maxRetries);
    case 'compat':
      return openAiCompatible(spec, need(cfg.COMPAT_BASE_URL, 'COMPAT_BASE_URL'), cfg.COMPAT_API_KEY ?? 'none', model, timeoutMs, maxRetries);
    case 'gemini':
      return gemini(spec, need(cfg.GEMINI_API_KEY, 'GEMINI_API_KEY'), model, timeoutMs, maxRetries);
    default:
      throw new Error(`Unknown LLM provider "${provider}" in "${spec}" (use mistral:, groq:, gemini:, openrouter:, compat: or rules)`);
  }
}
