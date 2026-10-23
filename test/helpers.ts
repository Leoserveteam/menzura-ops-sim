import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicies, loadConfig } from '../src/config.ts';
import type { SimContext } from '../src/context.ts';
import { Db } from '../src/db.ts';
import { Gate } from '../src/gate.ts';
import { ContentGuard } from '../src/guard/content.ts';
import { RunLog } from '../src/log.ts';
import { RngStreams } from '../src/util/rng.ts';
import { parseTime } from '../src/util/time.ts';
import { Budget } from '../src/engine/budget.ts';

export function testContext(): SimContext {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  let t = parseTime('2027-01-04T09:00');
  const ctx = {
    cfg, db,
    log: new RunLog(mkdtempSync(join(tmpdir(), 'mzsim-'))),
    rng: new RngStreams(1),
    content: new ContentGuard(undefined),
    policies: defaultPolicies(cfg),
    bus: new EventEmitter(),
    mode: 'offline',
    interactive: false,
    now: () => t,
  } as unknown as SimContext;
  (ctx as any).setNow = (v: number) => (t = v);
  ctx.budget = new Budget(10, db, ctx.now);
  ctx.gate = new Gate(ctx);
  db.insert('members', {
    id: 'M01', name: 'SIM-Test Member', tier: 'member', line: 'boardroom', profile: 'exacting',
    email: 'sim-test@example.invalid', joined_at: t, first_round_month: '2027-01', proposal_day: 5, delivery_day: 15, satisfaction: 70,
  });
  db.insert('members', {
    id: 'M02', name: 'SIM-Other Person', tier: 'member', line: 'heritage', profile: 'exacting',
    email: 'sim-other@example.invalid', joined_at: t, first_round_month: '2027-01', proposal_day: 5, delivery_day: 15, satisfaction: 70,
  });
  return ctx;
}
