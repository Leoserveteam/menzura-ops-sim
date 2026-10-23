import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, defaultPolicies, AGENT_IDS, type Policies } from '../src/config.ts';
import { Sim } from '../src/engine/sim.ts';
import { OfflineRunner } from '../src/agents/runner.ts';
import { OfflinePeople } from '../src/people/llm.ts';
import { REQUIRED_SCRIPTED } from '../src/engine/scripted.ts';
import { buildReport } from '../src/report/report.ts';

async function offlineRun(opts: { end?: string; policies?: Partial<Policies> } = {}) {
  const cfg = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), 'mz-engine-'));
  const sim = new Sim({
    cfg, runDir: dir, seed: cfg.sim.seed, policies: { ...defaultPolicies(cfg), ...opts.policies }, budgetUsd: 0, mode: 'offline', interactive: false,
    end: opts.end, quiet: true, runnerFactory: (s) => new OfflineRunner(s), llmFactory: () => new OfflinePeople(),
  });
  const outcome = await sim.run();
  return { sim, outcome, dir, report: buildReport(sim, outcome) };
}

test('a full offline year: every stress case fires, growth reaches the base case, hard rules hold', async () => {
  const { sim, outcome, dir, report } = await offlineRun();
  const db = sim.ctx.db;
  assert.ok(outcome.completed);
  const fired = new Set(db.all(`SELECT DISTINCT kind FROM event_log WHERE scripted = 1`).map((r) => r.kind));
  for (const id of REQUIRED_SCRIPTED) assert.ok(fired.has(id), `scripted case did not fire: ${id}`);
  const members = db.all('SELECT * FROM members');
  assert.ok(members.length >= 16 && members.length <= 18, `members ${members.length}`);
  assert.ok(members.every((m) => m.name.startsWith('SIM-')));
  assert.ok(members.some((m) => m.tier === 'principal') && members.some((m) => m.tier === 'member'));
  assert.ok(members.some((m) => m.line === 'heritage') && members.some((m) => m.line === 'boardroom'));
  // Rule 4: nothing reaches a member unless a person sent it.
  const agentSent = db.scalar<number>(`SELECT COUNT(*) FROM outbox WHERE delivered = 1 AND sent_by NOT IN ('stylist', 'operator', 'nick')`);
  assert.equal(agentSent, 0);
  // Levels never exceed ceilings; the Desk and the Door never leave Draft.
  const order = sim.ctx.cfg.levels.order;
  for (const a of AGENT_IDS) {
    const ceiling = order.indexOf(sim.ctx.cfg.agents[a].ceiling);
    for (const l of db.all('SELECT level FROM level_log WHERE agent = ?', a)) assert.ok(order.indexOf(l.level) <= ceiling, `${a} above ceiling`);
  }
  assert.equal(db.scalar(`SELECT COUNT(*) FROM level_log WHERE agent IN ('desk', 'door') AND level != 'draft'`), 0);
  // Offline means offline: no model calls, no network attempts.
  assert.equal(db.scalar('SELECT COUNT(*) FROM spend'), 0);
  // Every tool call is logged with the required fields.
  const lines = readFileSync(join(dir, 'tool_calls.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length > 500);
  const first = JSON.parse(lines[0]);
  for (const k of ['time', 'agent', 'tool', 'action', 'arguments', 'outcome']) assert.ok(k in first);
  // The report carries all eight sections and the five findings.
  for (const h of ['Five findings', '## 1. House score', '## 2. Fouls', '## 3. Overreach', '## 4. Each agent', '## 5. Human load', '## 6. Policy', '## 7. Rule gaps', '## 8. The ten']) assert.ok(report.includes(h), h);
  // The workshop is never named; no member is named to another in anything sent.
  assert.equal(db.scalar(`SELECT COUNT(*) FROM outbox WHERE delivered = 1 AND guard_issues IS NOT NULL AND guard_issues != 'null'`), db.scalar(`SELECT COUNT(*) FROM fouls WHERE kind = 'privacy_slip' AND cause LIKE '%message went out%'`));
});

test('same seed, same year: runs repeat exactly', async () => {
  const a = await offlineRun({ end: '2027-04-30' });
  const b = await offlineRun({ end: '2027-04-30' });
  const sig = (s: Sim) => JSON.stringify({
    rounds: s.ctx.db.all('SELECT id, clean, m1, m2, m3, m4, m5, m6, m7 FROM rounds ORDER BY id'),
    fouls: s.ctx.db.all('SELECT at, kind, cause FROM fouls ORDER BY id'),
    sat: s.ctx.db.all('SELECT id, satisfaction FROM members ORDER BY id'),
  });
  assert.equal(sig(a.sim), sig(b.sim));
});

test('policy variants diverge only where the policy acts', async () => {
  const a = await offlineRun({ end: '2027-06-30' });
  const b = await offlineRun({ end: '2027-06-30', policies: { recovery: 'B' } });
  const creditsA = a.sim.ctx.db.scalar<number>(`SELECT COUNT(*) FROM stripe_invoices WHERE kind = 'credit'`);
  const creditsB = b.sim.ctx.db.scalar<number>(`SELECT COUNT(*) FROM stripe_invoices WHERE kind = 'credit'`);
  assert.ok(creditsA > 0);
  assert.equal(creditsB, 0);
  assert.ok(b.sim.ctx.db.scalar<number>(`SELECT COUNT(*) FROM costs WHERE policy = 'recovery:B'`) > 0);
});

test('one-month smoke shape: January rounds close and are scored', async () => {
  const { sim } = await offlineRun({ end: '2027-01-31' });
  const jan = sim.ctx.db.all(`SELECT * FROM rounds WHERE month = '2027-01'`);
  assert.equal(jan.length, 5);
  assert.ok(jan.every((r) => r.closed === 1));
  assert.equal(sim.ctx.db.scalar(`SELECT COUNT(*) FROM rounds WHERE scored = 1 AND month > '2027-01'`), 0);
});
