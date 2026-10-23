import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('live agent path works end to end against a local fake API (no key, no network)', () => {
  const out = execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'scripts/sdk-wiring-check.ts'], { encoding: 'utf8', timeout: 120_000 });
  const r = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(r.model_sent, 'claude-sonnet-5-5');
  assert.deepEqual(r.calls, ['gmail.create_draft ok=true']);
  assert.equal(r.outbox.length, 1);
  assert.equal(r.outbox[0].status, 'awaiting_human');
  // Only the Desk's lane: no built-in tools, no other services.
  for (const t of r.tools_offered) assert.ok(/^mcp__(gmail|calendar|house)__/.test(t) || t === 'DeferredToolPlaceholder', t);
  assert.ok(r.usd > 0);
});
