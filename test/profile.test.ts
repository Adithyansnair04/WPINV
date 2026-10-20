import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GENERIC_PROFILE, loadProfile, normalizerFor } from '../src/clients/profile.js';
import { buildSystemPrompt } from '../src/extraction/prompt.js';

test('profile: the demo client prompt is byte-identical to the prompt the evaluation measured', () => {
  const golden = readFileSync('test/fixtures/auto-parts-prompt.txt', 'utf8');
  assert.equal(buildSystemPrompt(loadProfile('data/profile.json')), golden);
});

test('profile: a new client gets a generic prompt and generic text rules', () => {
  const prompt = buildSystemPrompt({ ...GENERIC_PROFILE, business: 'an Indian stationery wholesaler', keepWords: ['ream', 'refill'] });
  assert.match(prompt, /^You read chat messages sent to an Indian stationery wholesaler and extract/);
  assert.doesNotMatch(prompt, /lenzo|tyre|alloy/i);
  assert.match(prompt, /Keep words like "ream", "refill"\./);
  assert.equal(normalizerFor(GENERIC_PROFILE).normalizeText('12 refills'), '12 refills');
  assert.deepEqual(GENERIC_PROFILE.aliases, {});
});

test('profile: aliases and synonyms come from the file; invalid files fail loudly', () => {
  const p = loadProfile('data/profile.json');
  assert.deepEqual(p.aliases['VK Enterprises'], ['vk', 'vk ent', 'vke']);
  assert.deepEqual(p.normalizer.packs, ['auto_parts']);
  assert.throws(() => loadProfile('nope/profile.json'), /not found/);
});
