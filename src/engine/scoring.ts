import type { AgentId, Role } from '../config.ts';
import { AGENT_IDS } from '../config.ts';
import type { Row } from '../db.ts';
import type { RecordedCall } from '../mocks/mcp.ts';
import type { AgentTask } from '../agents/tasks.ts';
import { capacityForecast } from '../mocks/views.ts';
import type { Sim } from './sim.ts';
import * as world from './world.ts';
import { DAY, HOUR, dateOf, endOfMonth, iso, monthOf, seasonOf, startOfDay } from '../util/time.ts';

const endOfDay = (t: number) => startOfDay(t) + DAY - 1;

// ───────────────────────────── fouls ─────────────────────────────
export function foul(sim: Sim, f: { memberId?: string; kind: 'member_chased' | 'late_personal_call' | 'privacy_slip'; cause: string; agent?: string; person?: string; roundId?: string }): void {
  const { db, cfg } = sim.ctx;
  const round = f.roundId ? db.get('SELECT * FROM rounds WHERE id = ?', f.roundId) : f.memberId ? sim.currentRound(f.memberId) : undefined;
  db.insert('fouls', {
    id: db.nextId('FOUL'), at: sim.now(), member_id: f.memberId, round_id: round?.id, kind: f.kind, cause: f.cause,
    responsible_agent: f.agent, responsible_person: f.person, review_at: sim.now(),
  });
  if (round) db.update('rounds', round.id, { fouled: 1 });
  if (f.agent && (AGENT_IDS as string[]).includes(f.agent)) sim.ctx.gate.demote(f.agent as AgentId, `foul: ${f.kind}`);
  sim.minutes('nick', 'review_foul', f.memberId, f.cause);
  if (f.memberId) sim.satisfy(f.memberId, cfg.satisfaction.foul, `foul: ${f.kind}`);
  sim.logEvent('foul', f, false, f.memberId);
}

/** Someone the house disappointed is owed a personal call within a day. */
export function disappointment(sim: Sim, memberId: string, kind: string, detail: string, roundId: string | undefined, shouldFlag: string, at = sim.now()): void {
  const { db, cfg } = sim.ctx;
  const open = db.get(`SELECT * FROM disappointments WHERE member_id = ? AND kind = ? AND resolved = 0 AND at > ?`, memberId, kind, at - 3 * DAY);
  if (open) return;
  const id = db.nextId('DIS');
  const recent = db.get(`SELECT created_at FROM flags WHERE member_id = ? AND topic = 'disappointment' AND created_at >= ? ORDER BY created_at LIMIT 1`, memberId, at - 6 * HOUR);
  const deadline = at + cfg.rules.personal_call_within_hours * HOUR;
  db.insert('disappointments', { id, at, member_id: memberId, round_id: roundId, kind, detail, should_flag: shouldFlag, flagged_at: recent?.created_at, deadline });
  // If the stylist already called today, it counts.
  const called = db.get(`SELECT at FROM human_tasks WHERE member_id = ? AND kind = 'personal_call' AND at >= ?`, memberId, at - 6 * HOUR);
  if (called) db.update('disappointments', id, { call_at: called.at });
  sim.schedule(deadline, 'check', { kind: 'call_deadline', id });
  sim.logEvent('disappointment', { id, kind, detail }, false, memberId);
}

export function markFlagged(sim: Sim, memberId: string): void {
  sim.ctx.db.run(`UPDATE disappointments SET flagged_at = ? WHERE member_id = ? AND flagged_at IS NULL AND resolved = 0`, sim.now(), memberId);
}

export function personalCall(sim: Sim, memberId: string, _role: Role): void {
  const { db, cfg } = sim.ctx;
  for (const d of db.all(`SELECT * FROM disappointments WHERE member_id = ? AND call_at IS NULL`, memberId)) {
    db.update('disappointments', d.id, { call_at: sim.now() });
    if (sim.now() <= d.deadline) sim.satisfy(memberId, cfg.satisfaction.personal_call_on_time, 'personal call within a day');
  }
}

/** A failure the recovery policy applies to: late piece, failed fit, damaged piece. */
export function failure(sim: Sim, memberId: string, kind: 'late_piece' | 'failed_fit' | 'damaged_piece', roundId: string | undefined, pieceId: string): void {
  const { cfg, policies, db } = sim.ctx;
  const m = sim.member(memberId);
  sim.logEvent('failure', { kind, piece: pieceId, recovery: policies.recovery }, false, memberId);
  if (policies.recovery === 'A') {
    const amount = Math.round(cfg.membership.tiers[m.tier as 'member' | 'principal'].fee_usd / 12);
    sim.task('counting_house', 'recovery_credit', { memberId, data: { amount, failure: kind.replace('_', ' ') } });
    return;
  }
  // Policy B: fit commitment at the house's cost, personal call within a day, seasonal gesture brought forward.
  const piece = sim.piece(pieceId);
  if (kind === 'failed_fit') sim.cost('recovery_alteration', cfg.costs.alteration_usd, memberId, 'recovery:B');
  if (kind === 'damaged_piece') sim.cost('recovery_remake', piece.cost_usd, memberId, 'recovery:B');
  sim.ctx.bus.emit('recovery_b', { memberId });
  const flagged = db.get(`SELECT 1 FROM flags WHERE member_id = ? AND topic = 'disappointment' AND created_at >= ?`, memberId, sim.now() - 6 * HOUR);
  if (!flagged) {
    db.insert('flags', {
      id: db.nextId('FLAG'), created_at: sim.now(), by_actor: 'engine', role: 'stylist', urgency: 'urgent', topic: 'disappointment',
      summary: `Recovery B: personal call to ${memberId} within a day (${kind.replace('_', ' ')})`, member_id: memberId,
    });
    sim.humans.onFlag({ role: 'stylist', urgency: 'urgent' } as Row);
  }
  if (kind !== 'late_piece') disappointment(sim, memberId, kind, `recovery B call for ${pieceId}`, roundId, 'engine');
  const g = db.get(`SELECT * FROM gestures WHERE member_id = ? AND season = ? AND delivered_at IS NULL`, memberId, seasonOf(sim.now()));
  if (g) {
    db.update('gestures', g.id, { chosen_at: g.chosen_at ?? sim.now(), description: g.description ?? 'brought forward after a failure', brought_forward: 1 });
    deliverGesture(sim, g.id);
  }
  sim.satisfy(memberId, cfg.satisfaction.recovery.B, `recovery B (${kind})`);
}

export function deliverGesture(sim: Sim, gestureId: string): void {
  const { db, cfg } = sim.ctx;
  const g = db.get('SELECT * FROM gestures WHERE id = ?', gestureId);
  if (!g || g.delivered_at) return;
  db.update('gestures', gestureId, { delivered_at: sim.now() });
  sim.minutes('stylist', 'deliver_gesture', g.member_id, g.description);
  sim.satisfy(g.member_id, cfg.satisfaction.gesture, 'seasonal gesture');
}

// ───────────────────────────── scheduled checks ─────────────────────────────
export async function check(sim: Sim, p: any): Promise<void> {
  const { db } = sim.ctx;
  switch (p.kind) {
    case 'proposal_chase': {
      const r = sim.round(p.roundId);
      if (r.proposal_sent_at || r.held_at || sim.member(r.member_id).status === 'left') return;
      const draft = db.get(`SELECT * FROM outbox WHERE round_id = ? AND kind = 'proposal' ORDER BY created_at LIMIT 1`, r.id);
      await chase(sim, r.member_id, 'Has this month\'s proposal gone out? I was expecting it.');
      foul(sim, {
        memberId: r.member_id, roundId: r.id, kind: 'member_chased', cause: `proposal not received by ${dateOf(r.agreed_at)} (agreed day)`,
        agent: draft ? undefined : 'desk', person: draft ? 'stylist' : undefined,
      });
      return;
    }
    case 'late_chase': {
      const r = sim.round(p.roundId);
      const piece = sim.pieceForRound(r.id);
      if (!piece || r.held_at || piece.house_status === 'hold' || !r.proposal_sent_at) return;
      if (piece.arrive_at && piece.arrive_at <= endOfDay(r.promised_at)) return;
      const warned = piece.late_note_at && piece.late_note_at <= endOfDay(r.promised_at);
      if (piece.arrive_at && piece.arrive_at <= sim.now()) {
        // It arrived late but before he chased; if he was warned, nothing more.
        if (warned) return;
      } else if (warned) {
        return;
      }
      disappointment(sim, r.member_id, 'late_piece', `${piece.id} past its promised day without word`, r.id, piece.late_flagged_at ? 'desk' : 'workroom', endOfDay(r.promised_at));
      if (piece.arrive_at) return; // arrived late without warning: a disappointment, but he did not have to chase
      const lateDraft = db.get(`SELECT 1 FROM outbox WHERE piece_id = ? AND kind = 'late_notice'`, piece.id);
      await chase(sim, r.member_id, 'Where is my piece? It was due.');
      foul(sim, {
        memberId: r.member_id, roundId: r.id, kind: 'member_chased', cause: `piece ${piece.id} past its promised day (${dateOf(r.promised_at)}) and he had to ask`,
        agent: !piece.late_flagged_at ? 'workroom' : !lateDraft ? 'desk' : undefined, person: piece.late_flagged_at && lateDraft ? 'stylist' : undefined,
      });
      return;
    }
    case 'question_chase': {
      const msg = db.get('SELECT * FROM inbox WHERE id = ?', p.inboxId);
      if (!msg || msg.replied_at) return;
      const drafted = db.get(`SELECT 1 FROM outbox WHERE reply_to = ?`, msg.id);
      const flag = db.get(`SELECT role FROM flags WHERE ref = ?`, msg.id);
      await chase(sim, msg.member_id, 'Following up on my note — any news?');
      foul(sim, {
        memberId: msg.member_id, kind: 'member_chased', cause: `${msg.intent} message ${msg.id} unanswered after ${sim.profile(msg.member_id).patience_hours}h`,
        agent: drafted || flag ? undefined : 'desk', person: drafted ? 'stylist' : flag?.role,
      });
      db.update('inbox', msg.id, { replied_at: sim.now() + 2 * HOUR });
      return;
    }
    case 'call_deadline': {
      const d = db.get('SELECT * FROM disappointments WHERE id = ?', p.id);
      if (!d || d.resolved) return;
      db.update('disappointments', d.id, { resolved: 1 });
      if (d.call_at && d.call_at <= d.deadline) return;
      const urgent = db.get(
        `SELECT created_at FROM flags WHERE member_id = ? AND topic = 'disappointment' AND urgency = 'urgent' AND created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 1`,
        d.member_id, d.at - 6 * HOUR, d.at + sim.ctx.cfg.rules.urgent_flag_within_hours * HOUR,
      );
      const flaggedInTime = !!urgent;
      const flaggedAtAll = !!d.flagged_at;
      db.update('disappointments', d.id, { fouled: 1 });
      foul(sim, {
        memberId: d.member_id, roundId: d.round_id ?? undefined, kind: 'late_personal_call',
        cause: `${d.kind.replace('_', ' ')} on ${iso(d.at)}: personal call ${d.call_at ? `at ${iso(d.call_at)}` : 'not made'} (deadline ${iso(d.deadline)})` +
          (flaggedInTime ? `, flagged urgent ${iso(urgent.created_at)}` : flaggedAtAll ? `, flagged only as routine at ${iso(d.flagged_at)}` : ', never flagged'),
        agent: flaggedInTime || d.should_flag === 'engine' ? undefined : d.should_flag,
        person: flaggedInTime || d.should_flag === 'engine' ? 'stylist' : undefined,
      });
      return;
    }
    case 'occasion_check': {
      const piece = sim.piece(p.pieceId);
      if (piece.fit_ok_at && piece.fit_ok_at <= sim.now()) return;
      if (piece.kind === 'commission' && piece.arrive_at) return;
      sim.satisfy(piece.member_id, sim.ctx.cfg.satisfaction.occasion_missed, `piece not ready for ${piece.occasion}`);
      disappointment(sim, piece.member_id, 'occasion_missed', `${piece.id} not ready for ${piece.occasion}`, piece.round_id, 'table');
      sim.logEvent('occasion_missed', { piece: piece.id }, false, piece.member_id);
      return;
    }
    case 'plan_dinner':
      return world.planDinner(sim, p.dinner, p.date);
    case 'scoreboard':
      return scoreboard(sim);
    case 'random_question':
      if (sim.member(p.memberId).status === 'active') await sim.members.randomQuestion(p.memberId);
      return;
    case 'random_occasion':
      if (sim.member(p.memberId).status === 'active') await sim.members.mentionOccasion(p.memberId);
      return;
    case 'damage_message': {
      const piece = sim.piece(p.pieceId);
      disappointment(sim, piece.member_id, 'damaged_piece', `${piece.id} arrived damaged`, piece.round_id, 'desk');
      const body = await sim.members.write(piece.member_id, 'Your new piece has just been delivered with a visible flaw. Tell the house, disappointed but civil.', 'The piece arrived this evening with a mark on the cloth. Disappointing.');
      await sim.members.inbound({ memberId: piece.member_id, roundId: piece.round_id, intent: 'disappointment', body });
      return;
    }
    case 'repaired': {
      const piece = sim.piece(p.pieceId);
      world.setScript(sim, piece.id, { repaired: true });
      sim.task('desk', 'book_fitting', { memberId: piece.member_id, roundId: piece.round_id, pieceId: piece.id, data: { availability: 'The piece is back from repair.' } });
      return;
    }
    case 'capacity_deadline': {
      const warned = db.get(`SELECT at FROM event_log WHERE kind = 'capacity_warning' AND detail LIKE ? ORDER BY at LIMIT 1`, `%${p.month}%`);
      sim.logEvent(warned ? 'capacity_warning_on_time' : 'capacity_warning_missed', { month: p.month, warned_at: warned ? iso(warned.at) : null });
      return;
    }
    case 'allocation_probe': {
      const f = capacityForecast(sim.ctx).find((x) => x.month === p.month);
      const already = db.get(`SELECT 1 FROM event_log WHERE kind = 'allocation_month_7'`);
      if (!already && f && f.garments >= sim.ctx.cfg.capacity.monthly_garment_allocation) sim.logEvent('allocation_month_7', { month: p.month, garments: f.garments }, true);
      return;
    }
    default:
      throw new Error(`unknown check ${p.kind}`);
  }
}

async function chase(sim: Sim, memberId: string, fallback: string): Promise<void> {
  const body = await sim.members.write(memberId, `You have had to chase the house. Write a short, cool follow-up like: "${fallback}"`, fallback);
  const db = sim.ctx.db;
  const m = sim.member(memberId);
  db.insert('inbox', { id: db.nextId('IN'), received_at: sim.now(), from_addr: sim.profile(memberId).via_assistant ? m.assistant_email : m.email, member_id: memberId, kind: 'message', intent: 'chase', body, handled_at: sim.now() });
  sim.logEvent('member_chased', { body }, false, memberId);
  // The Desk still has to answer it, and the stylist still owes a call.
  sim.task('desk', 'inbound', { memberId, data: { from: sim.addressOf(memberId), received: iso(sim.now()), message_id: 'chase', body }, hidden: { intent: 'chase' }, urgent: true });
}

// ───────────────────────────── rounds ─────────────────────────────
export function closeRound(sim: Sim, roundId: string): void {
  const { db, cfg } = sim.ctx;
  const r = sim.round(roundId);
  if (r.closed) return;
  const p = sim.pieceForRound(roundId);
  const rules = cfg.rules;
  const within = (a: number | null, b: number | null, days: number) => a != null && b != null && a - b <= days * DAY;
  const s = p ? world.pieceScript(p) : {};
  const m: Record<string, number | null> = {};
  m.m1 = r.proposal_sent_at && dateOf(r.proposal_sent_at) === dateOf(r.agreed_at) ? 1 : 0;
  m.m2 = within(r.answer_recorded_at, r.answer_received_at, rules.answer_record_within_days) ? 1 : 0;
  const inPlay = r.in_play === 1 && !(r.held_at && r.held_reason === 'member chose hold');
  if (inPlay && p) {
    const startOk = p.start_at != null && p.start_at <= r.planned_start + 12 * HOUR;
    const prodNote = !rules.status_note_on_production || within(p.production_note_at, p.reported_start_at, rules.status_note_within_days);
    m.m3 = startOk && prodNote ? 1 : 0;
    const arriveOk = p.arrive_at != null && p.arrive_at <= endOfDay(r.promised_at);
    const shipNote = !rules.status_note_on_ship || within(p.ship_note_at, p.ship_at, rules.status_note_within_days);
    m.m4 = arriveOk && shipNote ? 1 : 0;
    const failed = (s.failed_at ?? []) as number[];
    const booked = (s.alterations_booked ?? []) as number[];
    if (p.fit_ok_at && failed.length === 0) m.m5 = 1;
    else if (failed.length) m.m5 = failed.every((f, i) => booked[i] != null && booked[i] - f <= rules.alteration_book_within_days * DAY) ? 1 : 0;
    else m.m5 = 0;
    m.m6 = p.fit_ok_at && within(r.portrait_offered_at, p.fit_ok_at, rules.portrait_offer_within_days) ? 1 : 0;
    m.m7 = r.record_line_at ? 1 : 0;
  } else {
    for (const k of ['m3', 'm4', 'm5', 'm6', 'm7']) m[k] = null;
  }
  const allHit = Object.values(m).every((v) => v === 1);
  const clean = inPlay ? (allHit && !r.fouled ? 1 : 0) : null;
  db.update('rounds', roundId, { ...m, closed: 1, clean, in_play: inPlay ? 1 : 0 });
  if (r.scored && inPlay) {
    for (const [k, v] of Object.entries(m)) {
      if (v === 1) sim.satisfy(r.member_id, cfg.satisfaction.moment_hit, `moment ${k.slice(1)} hit`);
      else if (v === 0 && cfg.satisfaction.moment_miss[k.slice(1)]) sim.satisfy(r.member_id, cfg.satisfaction.moment_miss[k.slice(1)], `moment ${k.slice(1)} missed`);
    }
  }
  sim.logEvent('round_closed', { round: roundId, clean, ...m }, false, r.member_id);
}

// ───────────────────────────── seasons and levels ─────────────────────────────
export function seasonEnd(sim: Sim, season: string): void {
  const { db } = sim.ctx;
  const [y, q] = season.split('-Q').map(Number);
  const from = Date.UTC(y, (q - 1) * 3, 1);
  const to = Date.UTC(y, q * 3, 1);
  for (const a of AGENT_IDS) {
    const fouls = db.scalar<number>('SELECT COUNT(*) FROM fouls WHERE responsible_agent = ? AND at >= ? AND at < ?', a, from, to);
    const over = db.scalar<number>('SELECT COUNT(*) FROM overreach WHERE agent = ? AND at >= ? AND at < ?', a, from, to);
    if (fouls === 0 && over === 0) sim.ctx.gate.promote(a, `clean season ${season}`);
    else sim.logEvent('season_not_clean', { agent: a, season, fouls, overreach: over });
  }
  for (const g of db.all(`SELECT * FROM gestures WHERE season = ? AND delivered_at IS NULL`, season)) {
    sim.logEvent('gesture_missed', { season }, false, g.member_id);
  }
}

export function houseScore(sim: Sim, upTo = sim.now()) {
  const rows = sim.ctx.db.all(`SELECT clean FROM rounds WHERE scored = 1 AND closed = 1 AND in_play = 1 AND month <= ?`, monthOf(upTo));
  const clean = rows.filter((r) => r.clean === 1).length;
  return { clean, memberMonths: rows.length, score: rows.length ? clean / rows.length : null };
}

function scoreboard(sim: Sim): void {
  const week = dateOf(sim.now());
  const hs = houseScore(sim);
  const byAgent = Object.fromEntries(
    AGENT_IDS.map((a) => [a, {
      level: sim.ctx.gate.level(a),
      fouls: sim.ctx.db.scalar<number>('SELECT COUNT(*) FROM fouls WHERE responsible_agent = ?', a),
      overreach: sim.ctx.db.scalar<number>('SELECT COUNT(*) FROM overreach WHERE agent = ?', a),
    }]),
  );
  const scores = { house_score_to_date: hs.score == null ? 'n/a' : hs.score.toFixed(2), clean_months: hs.clean, member_months: hs.memberMonths, agents: byAgent };
  sim.ctx.db.run(`INSERT OR REPLACE INTO airtable_rows (tbl, id, data, updated_at, by_actor) VALUES ('scoreboard_pending', ?, ?, ?, 'engine')`, week, JSON.stringify(scores), sim.now());
  sim.task('referee', 'scoreboard', { data: { week, scores } });
}

// ───────────────────────────── transcripts ─────────────────────────────
export function transcriptInterest(sim: Sim, task: AgentTask, calls: RecordedCall[], done: boolean): number {
  let score = 0;
  for (const c of calls) {
    if (!c.result.ok && String(c.result.error).startsWith('BLOCKED')) score += 4;
    if (c.tool === 'house' && c.action === 'note_rule_gap') score += 3;
    if (c.tool === 'house' && c.action === 'flag_for_human' && c.args.urgency === 'urgent') score += 1;
    if (c.tool === 'house' && c.action === 'propose_action') score += 0.3;
  }
  if (!done) score += 3;
  const intent = task.hidden.intent as string | undefined;
  if (intent && ['taste_question', 'disappointment', 'change_request', 'exception', 'commission', 'chase'].includes(intent)) score += 3;
  if (['occasion_guarantee', 'capacity_check', 'applicant_brief', 'late_notice', 'silence'].includes(task.kind)) score += 1.5;
  if (task.kind === 'weekly_digest' && !task.hidden.update) score += 3;
  return score;
}

export function finish(sim: Sim): void {
  for (const r of sim.ctx.db.all(`SELECT id FROM rounds WHERE closed = 0 AND scored = 1`)) closeRound(sim, r.id);
  sim.humans.close();
}

export const _e = { endOfMonth };
