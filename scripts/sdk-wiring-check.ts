/**
 * Proves the live path end to end without a key or any network: one real Agent
 * SDK call (subprocess, in-process MCP tools, permission gate, cost capture)
 * against a fake Messages API on localhost.
 *
 *   node --import tsx scripts/sdk-wiring-check.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeAnthropic } from './fake-anthropic.ts';
import { loadConfig, defaultPolicies } from '../src/config.ts';
import { Sim } from '../src/engine/sim.ts';
import { SdkRunner } from '../src/agents/sdk.ts';
import { OfflinePeople } from '../src/people/llm.ts';
import { installNetworkGuard } from '../src/guard/network.ts';
import * as world from '../src/engine/world.ts';

const fake = await startFakeAnthropic({
  name: 'create_draft',
  input: { to: 'office.adewale.coker@example.invalid', member_id: 'M01', kind: 'proposal', subject: 'January', body: 'Dear Adewale,\n\nFor January we propose a charcoal flannel suit. Approve, swap or hold.\n\nThe house', round_id: 'R-M01-2027-01' },
});
process.env.ANTHROPIC_BASE_URL = fake.url;
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-local-only';
installNetworkGuard([], (e) => e.outcome === 'blocked' && console.error('guard blocked', e));

const dir = mkdtempSync(join(tmpdir(), 'mz-wiring-'));
const cfg = loadConfig();
const sim = new Sim({
  cfg, runDir: dir, seed: 1, policies: defaultPolicies(cfg), budgetUsd: 1, mode: 'live', interactive: false,
  runnerFactory: (s) => new SdkRunner(s, join(dir, 'cache')),
  llmFactory: () => new OfflinePeople(),
});
world.setup(sim);
world.createRound(sim, sim.member('M01'), '2027-01');
const piece = sim.pieceForRound('R-M01-2027-01')!;
const runner = new SdkRunner(sim, join(dir, 'cache'));
const t0 = Date.now();
const res = await runner.run({
  id: 'T-WIRE', agent: 'desk', kind: 'proposal', memberId: 'M01', roundId: 'R-M01-2027-01', pieceId: piece.id,
  data: { to: sim.addressOf('M01'), agreed_day: '2026-12-06', promised: '2027-01-18' }, hidden: {}, createdAt: sim.now(),
});
const outbox = sim.ctx.db.all('SELECT id, by_agent, kind, status FROM outbox');
const sys = fake.requests.find((r) => r.body?.system)?.body;
console.log(JSON.stringify({
  seconds: (Date.now() - t0) / 1000,
  fake_api_requests: fake.requests.length,
  model_sent: sys?.model,
  tools_offered: (sys?.tools ?? []).map((t: any) => t.name),
  system_prompt_starts: JSON.stringify(sys?.system).slice(0, 120),
  calls: res.calls.map((c) => `${c.tool}.${c.action} ok=${c.result.ok}`),
  outbox,
  usd: res.usd,
  summary: res.summary,
  requests: fake.requests.map((r) => `${r.path} model=${r.body?.model} msgs=${r.body?.messages?.length} max_tokens=${r.body?.max_tokens} sys=${JSON.stringify(r.body?.system ?? '').length}ch tools=${(r.body?.tools ?? []).length}`),
}, null, 2));
fake.close();
process.exit(outbox.length === 1 ? 0 : 1);
