import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExtractor } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { llmExtractor, withFallback } from '../src/extraction/extract.js';
import { HttpError } from '../src/http.js';
import { fixture, type LlmProvider } from '../src/llm/provider.js';
import { ex } from './helpers.js';

const good = ex({ customer: 'VK', items: [{ description: 'lenzo 18 red', quantity: 4, rate: 5200 }] });
const overloaded: LlmProvider = {
  id: 'gemini:primary',
  async complete() {
    throw Object.assign(new HttpError('LLM HTTP 503: overloaded', 'transient', 503), { stats: { retries: 1, rateLimited: 0 } });
  },
};

test('fallback: an overloaded primary is answered by the fallback, and the result says so', async () => {
  let fallbackCalls = 0;
  const backup = fixture(() => (fallbackCalls++, good));
  const r = await withFallback(llmExtractor(overloaded), llmExtractor({ ...backup, id: 'groq:backup' })).extract('VK lenzo 18 red x 4 rate 5200');
  assert.ok(r.ok);
  assert.equal(fallbackCalls, 1);
  assert.equal(r.meta.model, 'groq:backup');
  assert.equal(r.meta.fallbackFrom, 'gemini:primary');
  assert.match(r.meta.primaryError!, /^transient: LLM HTTP 503/);
  assert.equal(r.meta.retries, 1);
});

test('fallback: unusable primary output also falls back; a healthy primary never calls the fallback', async () => {
  let fallbackCalls = 0;
  const backup = { ...fixture(() => (fallbackCalls++, good)), id: 'groq:backup' };
  const junk = { ...fixture(() => 'not json at all'), id: 'gemini:junk' };
  const r1 = await withFallback(llmExtractor(junk), llmExtractor(backup)).extract('x');
  assert.ok(r1.ok && r1.meta.fallbackFrom === 'gemini:junk');

  fallbackCalls = 0;
  const healthy = { ...fixture(() => good), id: 'gemini:ok' };
  const r2 = await withFallback(llmExtractor(healthy), llmExtractor(backup)).extract('x');
  assert.ok(r2.ok && !r2.meta.fallbackFrom);
  assert.equal(fallbackCalls, 0);
});

test('fallback: both failing returns an error mentioning both; nothing is guessed', async () => {
  const r = await withFallback(llmExtractor(overloaded), llmExtractor({ ...overloaded, id: 'groq:down' })).extract('x');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /primary: .*503.*fallback: .*503/.test(r.error));
});

test('fallback wiring: only the live bot gets a fallback; evaluation measures single models', () => {
  const cfg = { ...loadConfig({}), GEMINI_API_KEY: 'k', GROQ_API_KEY: 'k', LLM_FALLBACK_MODEL: 'groq:openai/gpt-oss-120b' };
  assert.equal(createExtractor('gemini:gemini-3.1-flash-lite', cfg, { withFallback: true }).id, 'gemini:gemini-3.1-flash-lite (fallback groq:openai/gpt-oss-120b)');
  assert.equal(createExtractor('gemini:gemini-3.1-flash-lite', cfg).id, 'gemini:gemini-3.1-flash-lite');
  assert.equal(createExtractor('groq:openai/gpt-oss-120b', cfg, { withFallback: true }).id, 'groq:openai/gpt-oss-120b');
});
