import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DASHBOARD_HTML } from '../src/dashboard/page.js';

// The page script lives inside a TS template string, where escapes like "\/" silently change meaning. Catch that here.
test('dashboard page: embedded script is valid JavaScript', () => {
  const script = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('<script>') + 8, DASHBOARD_HTML.indexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
});
