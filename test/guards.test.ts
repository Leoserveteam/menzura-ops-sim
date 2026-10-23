import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNetworkGuard } from '../src/guard/network.ts';
import { suspectEnvVars, agentSubprocessEnv } from '../src/guard/env.ts';
import { ContentGuard } from '../src/guard/content.ts';
import https from 'node:https';

test('network guard blocks anything not on the allowlist and logs it', async () => {
  const seen: any[] = [];
  const g = installNetworkGuard([], (e) => seen.push(e));
  await assert.rejects(() => fetch('https://api.stripe.com/v1/charges'), /blocked by the sim network guard/);
  assert.throws(() => https.get('https://www.googleapis.com/'), /blocked/);
  assert.equal(seen.filter((s) => s.outcome === 'blocked').length, 2);
  assert.equal(g.blocked, 2);
});

test('env guard flags real-service credentials and strips them from the agent subprocess', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_live_x', PATH: '/bin', ATTIO_TOKEN: 'a', HOME: '/root' };
  assert.deepEqual(suspectEnvVars(env).sort(), ['ATTIO_TOKEN', 'STRIPE_SECRET_KEY']);
  const sub = agentSubprocessEnv(env);
  assert.equal(sub.STRIPE_SECRET_KEY, undefined);
  assert.equal(sub.PATH, '/bin');
  assert.equal(sub.DISABLE_TELEMETRY, '1');
});

test('content guard catches denylisted names, other members and real addresses', () => {
  const g = new ContentGuard(undefined);
  g.addDenylisted('Real Workshop Name');
  const members = [{ id: 'M01', name: 'SIM-Adewale Coker' }, { id: 'M02', name: 'SIM-Kwame Asante-Lord' }];
  assert.equal(g.scan('Made by the workshop.', { toMemberId: 'M01', members, addresses: ['sim-a@example.invalid'] }).length, 0);
  const issues = g.scan('Real Workshop Name made it; Kwame Asante-Lord loved his.', { toMemberId: 'M01', members, addresses: ['someone@gmail.com'] });
  assert.deepEqual(issues.map((i) => i.kind).sort(), ['denylisted_name', 'other_member_named', 'real_address']);
});
