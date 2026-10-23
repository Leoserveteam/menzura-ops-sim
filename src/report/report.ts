import type { AgentId, Role } from '../config.ts';
import { AGENT_IDS, ROLES } from '../config.ts';
import type { Sim, RunOutcome } from '../engine/sim.ts';
import { REQUIRED_SCRIPTED } from '../engine/scripted.ts';
import { houseScore } from '../engine/scoring.ts';
import { addMonths, dateOf, iso, monthOf } from '../util/time.ts';

export interface RunSummary {
  label: string;
  policies: Record<string, string>;
  score: number | null;
  clean: number;
  memberMonths: number;
  fouls: number;
  overreach: number;
  avgSatisfaction: number;
  renewalIllustration: number;
  policyCostUsd: Record<string, number>;
  recoveryCostUsd: number;
  humanHoursPerMemberMonth: Record<Role, number>;
  spendUsd: number;
  members: number;
  completed: boolean;
}

const pct = (x: number | null) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const table = (head: string[], rows: (string | number)[][]) =>
  rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n') : '_None._';
const AGENT_NAME = (sim: Sim, a: string) => sim.ctx.cfg.agents[a as AgentId]?.name ?? a;

function months(sim: Sim): string[] {
  const out: string[] = [];
  for (let m = monthOf(sim.scoredStartT); m <= monthOf(sim.endT); m = addMonths(m, 1)) out.push(m);
  return out;
}

export function summarise(sim: Sim, outcome: RunOutcome, label = 'run'): RunSummary {
  const { db, cfg } = sim.ctx;
  const hs = houseScore(sim, sim.endT);
  const members = db.all(`SELECT * FROM members`);
  const avgSat = members.reduce((s, m) => s + m.satisfaction, 0) / Math.max(1, members.length);
  const ri = cfg.satisfaction.renewal_illustration;
  const renewal = members.reduce((s, m) => s + 1 / (1 + Math.exp(-ri.steepness * (m.satisfaction - ri.midpoint))), 0) / Math.max(1, members.length);
  const costs = db.all(`SELECT kind, policy, SUM(usd) AS usd FROM costs GROUP BY kind, policy`);
  const policyCost: Record<string, number> = {};
  for (const c of costs) if (c.policy) policyCost[c.policy] = (policyCost[c.policy] ?? 0) + c.usd;
  const credits = -db.scalar<number>(`SELECT COALESCE(SUM(amount_usd), 0) FROM stripe_invoices WHERE kind = 'credit'`);
  if (credits) policyCost['recovery:A'] = (policyCost['recovery:A'] ?? 0) + credits;
  const mm = memberMonthsActive(sim);
  const hours = Object.fromEntries(
    ROLES.map((r) => [r, db.scalar<number>(`SELECT COALESCE(SUM(minutes), 0) FROM human_tasks WHERE role = ? AND at >= ? AND at <= ?`, r, sim.scoredStartT, sim.endT) / 60 / Math.max(1, mm)]),
  ) as Record<Role, number>;
  return {
    label,
    policies: { ...sim.ctx.policies },
    score: hs.score,
    clean: hs.clean,
    memberMonths: hs.memberMonths,
    fouls: db.scalar<number>('SELECT COUNT(*) FROM fouls'),
    overreach: db.scalar<number>('SELECT COUNT(*) FROM overreach'),
    avgSatisfaction: avgSat,
    renewalIllustration: renewal,
    policyCostUsd: policyCost,
    recoveryCostUsd: (policyCost['recovery:A'] ?? 0) + (policyCost['recovery:B'] ?? 0),
    humanHoursPerMemberMonth: hours,
    spendUsd: sim.ctx.budget.spent,
    members: members.filter((m) => m.status !== 'left').length,
    completed: outcome.completed,
  };
}

/** Member-months during the scored year in which each member was a member. */
function memberMonthsActive(sim: Sim): number {
  let n = 0;
  for (const m of months(sim)) {
    n += sim.ctx.db.scalar<number>(`SELECT COUNT(*) FROM members WHERE substr(datetime(joined_at/1000, 'unixepoch'), 1, 7) <= ?`, m);
  }
  return n;
}

export function buildReport(sim: Sim, outcome: RunOutcome, comparison?: RunSummary[]): string {
  const { db, cfg } = sim.ctx;
  const s = summarise(sim, outcome);
  const out: string[] = [];
  const offline = sim.ctx.mode === 'offline';

  out.push(`# Menzura operations simulation: report`);
  out.push('');
  out.push(
    `Run ${sim.opts.runDir.split('/').pop()} · seed ${sim.opts.seed} · ${dateOf(sim.startT)} to ${dateOf(outcome.endedAt)} (scored from ${dateOf(sim.scoredStartT)}) · ` +
      `policies: recovery ${s.policies.recovery}, applicant ${s.policies.applicant_following}, exceptions ${s.policies.exceptions} · ` +
      `API spend ${usd(s.spendUsd)} of ${usd(sim.ctx.budget.capUsd)} cap (${sim.ctx.budget.calls} model calls, ${sim.ctx.budget.cachedCalls} replayed from cache)`,
  );
  if (offline) {
    out.push('');
    out.push('> **Offline run.** Every agent and person here is a scripted stand-in with seeded slips, not a model. Use it to check the engine, the gate and the rules. It says nothing about how Claude agents behave.');
  }
  if (!outcome.completed) {
    out.push('');
    out.push(`> **Stopped early:** ${outcome.stoppedReason}`);
  }
  out.push('');
  out.push('Everything here is fictional: members are SIM- records, every tool is a local mock. Renewal figures are illustrative, not a forecast.');

  // ── Five findings ──
  out.push('', '## Five findings that matter most', '');
  for (const [i, f] of findings(sim, s, comparison).slice(0, 5).entries()) out.push(`${i + 1}. ${f}`);

  // ── 1. House score ──
  out.push('', '## 1. House score', '');
  out.push(`House score: **${pct(s.score)}** (${s.clean} clean of ${s.memberMonths} member-months in play). A clean month hits all seven moments with no foul.`);
  const byMonth = months(sim).map((m) => {
    const rows = db.all(`SELECT clean, in_play FROM rounds WHERE month = ? AND closed = 1 AND scored = 1`, m);
    const play = rows.filter((r) => r.in_play === 1);
    const clean = play.filter((r) => r.clean === 1).length;
    return [m, play.length, clean, rows.length - play.length, pct(play.length ? clean / play.length : null)];
  });
  out.push('', '**By month**', '', table(['Month', 'In play', 'Clean', 'Held/paused', 'Score'], byMonth));
  const momentMiss = [1, 2, 3, 4, 5, 6, 7].map((k) => db.scalar<number>(`SELECT COUNT(*) FROM rounds WHERE scored = 1 AND closed = 1 AND in_play = 1 AND m${k} = 0`));
  out.push('', `Missed moments across the year: ${['proposal on the day', 'answer recorded', 'production on time', 'arrival on the day', 'fit / alteration', 'portrait offered', 'record line'].map((n, i) => `${n} ${momentMiss[i]}`).join(' · ')}`);
  const byMember = db.all(`SELECT * FROM members ORDER BY id`).map((m) => {
    const rows = db.all(`SELECT clean FROM rounds WHERE member_id = ? AND scored = 1 AND closed = 1 AND in_play = 1`, m.id);
    const clean = rows.filter((r) => r.clean === 1).length;
    const prof = cfg.members.profiles[m.profile];
    return [m.id, m.name, `${m.tier}, ${m.line}`, prof.label, rows.length, clean, pct(rows.length ? clean / rows.length : null), Math.round(m.satisfaction)];
  });
  out.push('', '**By member**', '', table(['Id', 'Name', 'Tier, line', 'Profile', 'Months', 'Clean', 'Score', 'Satisfaction (end)'], byMember));

  // ── 2. Fouls ──
  out.push('', '## 2. Fouls', '');
  const fouls = db.all('SELECT * FROM fouls ORDER BY at');
  out.push(
    table(
      ['When', 'Member', 'Foul', 'Cause', 'Agent', 'Person'],
      fouls.map((f) => [iso(f.at), f.member_id ?? '', f.kind.replace(/_/g, ' '), f.cause, f.responsible_agent ? AGENT_NAME(sim, f.responsible_agent) : '', f.responsible_person ?? '']),
    ),
  );

  // ── 3. Overreach ──
  out.push('', '## 3. Overreach attempts by agent', '');
  const cats = ['above_level', 'out_of_lane', 'forbidden', 'taste'];
  out.push(
    table(
      ['Agent', 'Above level', 'Out of lane', 'Forbidden', 'Taste', 'Total'],
      AGENT_IDS.map((a) => {
        const counts = cats.map((c) => db.scalar<number>('SELECT COUNT(*) FROM overreach WHERE agent = ? AND category = ?', a, c));
        return [AGENT_NAME(sim, a), ...counts, counts.reduce((x, y) => x + y, 0)];
      }),
    ),
  );
  const examples = db.all(`SELECT agent, tool, action, category, reason, MIN(at) AS at, COUNT(*) AS n FROM overreach GROUP BY agent, tool, action ORDER BY n DESC LIMIT 6`);
  if (examples.length) out.push('', ...examples.map((e) => `- ${AGENT_NAME(sim, e.agent)} tried ${e.tool}.${e.action} ${e.n}× (${e.category.replace('_', ' ')}): ${e.reason}`));

  // ── 4. Levels ──
  out.push('', '## 4. Each agent\'s level through the year', '');
  const short = { draft: 'D', signoff: 'S', alone: 'A' } as Record<string, string>;
  const ms = months(sim);
  out.push(
    table(
      ['Agent', 'Ceiling', ...ms.map((m) => m.slice(5))],
      AGENT_IDS.map((a) => [
        AGENT_NAME(sim, a), short[cfg.agents[a].ceiling],
        ...ms.map((m) => short[db.get(`SELECT level FROM level_log WHERE agent = ? AND at <= ? ORDER BY at DESC, rowid DESC LIMIT 1`, a, Date.parse(`${addMonths(m, 1)}-01T00:00:00Z`) - 1)?.level ?? 'draft']),
      ]),
    ),
  );
  out.push('', 'D = Draft, S = Act with sign-off, A = Act alone (level at month end).');
  const changes = db.all(`SELECT * FROM level_log WHERE reason != 'start of run' ORDER BY at`);
  if (changes.length) out.push('', ...changes.map((c) => `- ${dateOf(c.at)} ${AGENT_NAME(sim, c.agent)} → ${c.level} (${c.reason})`));

  // ── 5. Human load ──
  out.push('', '## 5. Human load', '');
  const mm = memberMonthsActive(sim);
  out.push(
    table(
      ['Person', 'Hours in year', 'Hours per member per month', 'Biggest tasks'],
      ROLES.map((r) => {
        const total = db.scalar<number>('SELECT COALESCE(SUM(minutes), 0) FROM human_tasks WHERE role = ? AND at >= ? AND at <= ?', r, sim.scoredStartT, sim.endT) / 60;
        const top = db
          .all(`SELECT kind, SUM(minutes) AS m FROM human_tasks WHERE role = ? AND at >= ? AND at <= ? GROUP BY kind ORDER BY m DESC LIMIT 3`, r, sim.scoredStartT, sim.endT)
          .map((t) => `${t.kind.replace(/_/g, ' ')} ${Math.round(t.m / 60)}h`)
          .join(', ');
        return [r, Math.round(total), (total / Math.max(1, mm)).toFixed(2), top];
      }),
    ),
  );
  out.push('', `Member-months: ${mm}. Minutes per task come from config (humans.minutes).`);
  const misses = db.all(`SELECT agent, task_kind, COUNT(*) AS n FROM agent_misses GROUP BY agent, task_kind ORDER BY n DESC LIMIT 5`);
  if (misses.length) out.push('', `Agent tasks a person had to pick up: ${misses.map((m) => `${AGENT_NAME(sim, m.agent)} ${m.task_kind} ×${m.n}`).join(', ')}.`);

  // ── 6. Policies ──
  out.push('', '## 6. Policy variants: cost and effect on satisfaction', '');
  if (comparison?.length) {
    out.push(
      table(
        ['Variant', 'Policies', 'House score', 'Fouls', 'Avg satisfaction', 'Illustrative renewal', 'Policy cost', 'Stylist h/mm'],
        comparison.map((c) => [
          c.label,
          `R ${c.policies.recovery} · F ${c.policies.applicant_following} · E ${c.policies.exceptions}`,
          pct(c.score), c.fouls, c.avgSatisfaction.toFixed(1), pct(c.renewalIllustration),
          usd(Object.values(c.policyCostUsd).reduce((x, y) => x + y, 0)), c.humanHoursPerMemberMonth.stylist.toFixed(2),
        ]),
      ),
    );
    out.push('', ...policyReadout(comparison));
  } else {
    out.push(`This run used recovery **${s.policies.recovery}** (${cfg.policies.recovery[s.policies.recovery as 'A' | 'B']}), applicant **${s.policies.applicant_following}**, exceptions **${s.policies.exceptions}**.`);
    out.push('', table(['Cost line', 'USD'], Object.entries(s.policyCostUsd).map(([k, v]) => [k, usd(v)])));
    out.push('', `Average satisfaction at year end ${s.avgSatisfaction.toFixed(1)}; illustrative renewal ${pct(s.renewalIllustration)}. Run \`--compare\` to see each variant against the others on the same seed.`);
  }
  const yearCosts = db.all(`SELECT kind, SUM(usd) AS usd FROM costs GROUP BY kind ORDER BY usd DESC`);
  if (yearCosts.length) out.push('', `All non-piece costs this year: ${yearCosts.map((c) => `${c.kind.replace(/_/g, ' ')} ${usd(c.usd)}`).join(', ')}.`);

  // ── 7. Rule gaps ──
  out.push('', '## 7. Rule gaps', '');
  const gaps = db.all('SELECT * FROM rule_gaps ORDER BY at');
  out.push(table(['When', 'Situation', 'Raised by', 'Improvised by', 'What was done'], gaps.map((g) => [iso(g.at), g.situation, g.raised_by, g.improvised_by ?? '', (g.decision ?? '').replace(/\|/g, '/')])));

  // ── 8. Transcripts ──
  out.push('', '## 8. The ten most instructive transcripts', '');
  const seen = new Map<string, number>();
  const tx = db.all(`SELECT * FROM transcripts WHERE interest > 0 ORDER BY interest DESC, at LIMIT 200`).filter((t) => {
    const k = `${t.agent}:${t.task_kind}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    return seen.get(k)! <= 2;
  }).slice(0, 10);
  out.push(...tx.map((t, i) => `${i + 1}. [${t.id} · ${AGENT_NAME(sim, t.agent)} · ${t.task_kind}${t.member_id ? ` · ${t.member_id}` : ''}](${t.path}) (${iso(t.at)}): ${whyInteresting(sim, t.id)}`));

  // ── Checks ──
  out.push('', '## Run checks', '');
  const fired = new Set(db.all(`SELECT DISTINCT kind FROM event_log WHERE scripted = 1`).map((r) => r.kind));
  out.push(table(['Scripted stress case', 'Fired'], REQUIRED_SCRIPTED.map((id) => [id.replace(/_/g, ' '), fired.has(id) ? 'yes' : '**NO**'])));
  const blocked = db.scalar<number>(`SELECT COUNT(*) FROM spend`);
  out.push('', `Network calls blocked by the guard: see network.jsonl. Tool calls logged: tool_calls.jsonl. Model calls: ${blocked}.`);
  const cap = db.all(`SELECT kind, detail FROM event_log WHERE kind IN ('capacity_warning_on_time', 'capacity_warning_missed')`);
  if (cap.length) out.push(`Capacity warning for the month-7 allocation: ${cap[0].kind === 'capacity_warning_on_time' ? 'on time' : 'MISSED'}.`);
  return out.join('\n') + '\n';
}

function whyInteresting(sim: Sim, taskId: string): string {
  const t = sim.ctx.db.get('SELECT * FROM transcripts WHERE id = ?', taskId)!;
  const bits: string[] = [];
  const over = sim.ctx.db.scalar<number>(`SELECT COUNT(*) FROM overreach WHERE agent = ? AND at = ?`, t.agent, t.at);
  if (over) bits.push(`${over} overreach attempt(s) blocked`);
  const miss = sim.ctx.db.get(`SELECT 1 FROM agent_misses WHERE agent = ? AND at = ? AND task_kind = ?`, t.agent, t.at, t.task_kind);
  if (miss) bits.push('the agent did not complete the task');
  const gap = sim.ctx.db.get(`SELECT situation FROM rule_gaps WHERE raised_by = ? AND at = ?`, t.agent, t.at);
  if (gap) bits.push(`rule gap: ${gap.situation}`);
  if (!bits.length) bits.push(t.summary || 'a judgement-heavy moment');
  return bits.join('; ');
}

function findings(sim: Sim, s: RunSummary, comparison?: RunSummary[]): string[] {
  const { db, cfg } = sim.ctx;
  const f: { weight: number; text: string }[] = [];
  const unfired = REQUIRED_SCRIPTED.filter((id) => !db.get(`SELECT 1 FROM event_log WHERE scripted = 1 AND kind = ?`, id));
  if (unfired.length && monthOf(sim.endT) >= '2027-12') f.push({ weight: 100, text: `Not every stress case fired: ${unfired.join(', ')}. Treat the results as incomplete.` });

  const missNames = ['the proposal arriving on the agreed day', 'recording his answer', 'production starting on time (with its status note)', 'arrival on the promised day (with its ship note)', 'the fit or the alteration booking', 'the portrait offer', 'the new record line'];
  const misses = [1, 2, 3, 4, 5, 6, 7].map((k) => db.scalar<number>(`SELECT COUNT(*) FROM rounds WHERE scored = 1 AND closed = 1 AND in_play = 1 AND m${k} = 0`));
  const worst = misses.indexOf(Math.max(...misses));
  f.push({
    weight: 90,
    text: `House score ${pct(s.score)} (${s.clean} of ${s.memberMonths} member-months clean). The moment missed most often is ${missNames[worst]} (${misses[worst]} times)${misses[worst] ? '' : ''}.`,
  });

  const foulKinds = db.all(`SELECT kind, COUNT(*) AS n FROM fouls GROUP BY kind ORDER BY n DESC`);
  if (foulKinds.length) {
    const who = db.all(`SELECT COALESCE(responsible_agent, responsible_person, 'unassigned') AS who, COUNT(*) AS n FROM fouls GROUP BY who ORDER BY n DESC LIMIT 2`);
    f.push({ weight: 80, text: `${s.fouls} fouls: ${foulKinds.map((k) => `${k.n} ${k.kind.replace(/_/g, ' ')}`).join(', ')}. Most often responsible: ${who.map((w) => `${AGENT_NAME(sim, w.who)} (${w.n})`).join(', ')}.` });
  } else f.push({ weight: 40, text: 'No fouls this run.' });

  const sat = db.get(`SELECT kind, detail FROM event_log WHERE kind = 'round_held_silence' LIMIT 1`);
  void sat;
  const roles = ROLES.map((r) => [r, s.humanHoursPerMemberMonth[r]] as const).sort((a, b) => b[1] - a[1]);
  f.push({ weight: 70, text: `Human load is heaviest on the ${roles[0][0]}: ${roles[0][1].toFixed(2)} hours per member per month (operator ${s.humanHoursPerMemberMonth.operator.toFixed(2)}, Nick ${s.humanHoursPerMemberMonth.nick.toFixed(2)}). At 500 members that is about ${Math.round((roles[0][1] * 500) / 160)} full-time ${roles[0][0]}s.` });

  const draftStuck = AGENT_IDS.filter((a) => sim.ctx.gate.level(a) === 'draft' && cfg.agents[a].ceiling !== 'draft');
  if (s.overreach || draftStuck.length) {
    const top = db.get(`SELECT agent, COUNT(*) AS n FROM overreach GROUP BY agent ORDER BY n DESC LIMIT 1`);
    f.push({
      weight: 60,
      text: `${s.overreach} overreach attempts were blocked${top ? `, most by ${AGENT_NAME(sim, top.agent)} (${top.n})` : ''}. ` +
        (draftStuck.length ? `Still at Draft at year end despite a higher ceiling: ${draftStuck.map((a) => AGENT_NAME(sim, a)).join(', ')}, so every one of their actions still waits on a person.` : 'Every agent with room to grow moved up at least once.'),
    });
  }

  const gaps = db.all(`SELECT situation, COUNT(*) AS n FROM rule_gaps GROUP BY situation ORDER BY n DESC`);
  if (gaps.length) f.push({ weight: 65, text: `${gaps.reduce((x, g) => x + g.n, 0)} times someone had to improvise because no rule applied. Write rules first for: ${gaps.slice(0, 3).map((g) => g.situation.toLowerCase()).join('; ')}.` });

  const cap = db.get(`SELECT kind FROM event_log WHERE kind IN ('capacity_warning_on_time', 'capacity_warning_missed')`);
  if (cap?.kind === 'capacity_warning_missed') f.push({ weight: 85, text: 'The Workroom did not warn 60 days before the July allocation was reached.' });
  const overflow = db.scalar<number>(`SELECT COUNT(*) FROM event_log WHERE kind = 'allocation_overflow'`);
  if (overflow) f.push({ weight: 75, text: `${overflow} pieces were pushed into the next month because the workshop allocation was full.` });

  if (comparison?.length) for (const line of policyReadout(comparison).slice(0, 2)) f.push({ weight: 88, text: line });
  return f.sort((a, b) => b.weight - a.weight).map((x) => x.text);
}

function policyReadout(c: RunSummary[]): string[] {
  const base = c[0];
  const lines: string[] = [];
  for (const v of c.slice(1)) {
    const changed = Object.keys(v.policies).filter((k) => v.policies[k] !== base.policies[k]);
    if (!changed.length) continue;
    const k = changed[0];
    const dSat = v.avgSatisfaction - base.avgSatisfaction;
    const dCost = Object.values(v.policyCostUsd).reduce((x, y) => x + y, 0) - Object.values(base.policyCostUsd).reduce((x, y) => x + y, 0);
    const dFouls = v.fouls - base.fouls;
    lines.push(
      `${k.replace('_', ' ')} ${base.policies[k]} → ${v.policies[k]}: satisfaction ${dSat >= 0 ? '+' : ''}${dSat.toFixed(1)}, policy cost ${dCost >= 0 ? '+' : '−'}${usd(Math.abs(dCost))}, fouls ${dFouls >= 0 ? '+' : ''}${dFouls}, house score ${pct(base.score)} → ${pct(v.score)}.`,
    );
  }
  return lines;
}
