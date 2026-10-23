import type { Row } from '../db.ts';
import type { InitialMember, Role } from '../config.ts';
import { callTool } from '../mocks/registry.ts';
import { capacityForecast, pieceCostUsd } from '../mocks/views.ts';
import type { Sim } from './sim.ts';
import * as scoring from './scoring.ts';
import {
  DAY, HOUR, addMonths, atTime, dateOf, dayInMonth, endOfMonth, iso, monthOf, parseTime, seasonOf, startOfDay, weekday,
} from '../util/time.ts';

const CATALOGUE = {
  boardroom: ['navy chalk-stripe two-piece', 'charcoal flannel suit', 'midnight dinner jacket', 'grey windowpane three-piece', 'olive travel suit', 'ivory linen summer suit', 'double-breasted navy blazer', 'brown herringbone jacket'],
  heritage: ['ivory agbada with gold embroidery', 'indigo kaftan with hand stitching', 'burgundy agbada set', 'aso-oke ceremonial ensemble', 'cream senator kaftan', 'emerald agbada for evening', 'white kaftan for Friday prayers', 'royal blue agbada set'],
};
const FIRST = ['Femi', 'Olu', 'Kofi', 'Ifeanyi', 'Seun', 'Babajide', 'Yaw', 'Chidi', 'Kunle', 'Musa', 'Obinna', 'Tobi', 'Kwesi', 'Dapo', 'Uche', 'Segun', 'Nnamdi', 'Ade'];
const LAST = ['Adeyemi', 'Mensah', 'Nwosu', 'Balogun', 'Okeke', 'Danjuma', 'Owusu', 'Eze', 'Lawal', 'Boateng', 'Ogunleye', 'Ibekwe', 'Sowande', 'Afolabi', 'Oduya', 'Kalu'];

const pieceScript = (p: Row): Record<string, any> => JSON.parse(p.script || '{}');
function setScript(sim: Sim, pieceId: string, patch: Record<string, unknown>): void {
  const p = sim.piece(pieceId);
  sim.ctx.db.update('pieces', pieceId, { script: { ...pieceScript(p), ...patch } });
}
const slug = (name: string) => name.replace(/^SIM-/, '').toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');

// ───────────────────────────── setup ─────────────────────────────
export function setup(sim: Sim): void {
  const { cfg } = sim.ctx;
  for (const m of cfg.members.initial) addMember(sim, m, sim.startT - 30 * DAY, monthOf(sim.scoredStartT));
  // Known occasions in the founders' records
  setAttr(sim, 'M03', 'occasion:wedding', '2027-06-19, his wedding, abroad');
  setAttr(sim, 'M05', 'occasion:family', 'A major family celebration abroad in August 2027');
  setAttr(sim, 'M01', 'preference:contact', 'Everything through his assistant');

  // Base-case growth: one application a few weeks before each join month.
  const growth = sim.ctx.rng.get('growth');
  const following = cfg.scripted_events.find((e) => e.id === 'applicant_with_following');
  const followingJoin = following?.at ? addMonths(String(following.at).slice(0, 7), 1) : undefined;
  for (const [month, n0] of Object.entries(cfg.members.growth_base_case)) {
    const n = month === followingJoin ? n0 - 1 : n0; // the applicant with a following fills this slot
    for (let i = 0; i < n; i++) {
      const at = atTime(dayInMonth(addMonths(month, -1), 8 + i * 4), '10:00');
      if (at < sim.startT) continue;
      sim.schedule(at, 'applicant', { baseCase: true, joinMonth: month, seedPick: growth.next() });
    }
  }
  for (const q of ['03-31', '06-30', '09-30', '12-31']) sim.schedule(parseTime(`2027-${q}T22:00`), 'season_end', { season: seasonOf(parseTime(`2027-${q}`)) });
  for (const d of cfg.dinners.events) {
    sim.schedule(atTime(parseTime(d.date), '19:30'), 'dinner', { id: d.id });
    planDinnerTask(sim, d.id, d.date);
  }
}

function planDinnerTask(sim: Sim, id: string, date: string): void {
  const at = atTime(parseTime(date) - sim.ctx.cfg.dinners.plan_days_ahead * DAY, '10:00');
  sim.schedule(at, 'check', { kind: 'plan_dinner', dinner: id, date });
}

export function planDinner(sim: Sim, id: string, date: string): void {
  const members = sim.activeMembers().map((m) => ({ id: m.id, to: sim.addressOf(m.id) }));
  sim.task('table', 'plan_dinner', { data: { dinner: id.replace(/_/g, ' '), date, members } });
}

export function addMember(sim: Sim, m: InitialMember, joinedAt: number, firstRoundMonth: string, following = false): void {
  const { cfg } = sim.ctx;
  const s = slug(m.name);
  sim.ctx.db.insert('members', {
    id: m.id, name: m.name, tier: m.tier, line: m.line, profile: m.profile,
    email: `${s}@${cfg.privacy.member_domain}`,
    assistant_email: `office.${s}@${cfg.privacy.member_domain}`,
    joined_at: joinedAt, first_round_month: firstRoundMonth, proposal_day: m.proposal_day, delivery_day: m.delivery_day,
    satisfaction: cfg.satisfaction.start, following: following ? 1 : 0,
  });
  if (m.tier === 'principal') {
    // 12 monthly pieces plus 3 further commissions, placed in three seeded months.
    const r = sim.ctx.rng.get(`extras:${m.id}`);
    const months = new Set<string>();
    while (months.size < 3) months.add(addMonths(firstRoundMonth, r.int(1, 10)));
    setAttr(sim, m.id, 'extra_commission_months', [...months].sort().join(','));
  }
  sim.logEvent('member_joined', { tier: m.tier, line: m.line, profile: m.profile }, false, m.id);
}

function setAttr(sim: Sim, memberId: string, key: string, value: string): void {
  sim.ctx.db.run(
    `INSERT OR REPLACE INTO attio_attributes (member_id, key, value, updated_at, by_actor) VALUES (?, ?, ?, ?, 'world')`,
    memberId, key, value, sim.now(),
  );
}

// ───────────────────────────── daily tick ─────────────────────────────
export async function dayTick(sim: Sim): Promise<void> {
  const { cfg, db } = sim.ctx;
  const today = startOfDay(sim.now());
  const d = new Date(today);
  const dom = d.getUTCDate();
  const month = monthOf(today);

  for (const role of ['stylist', 'operator', 'nick'] as Role[]) {
    const pol = cfg.humans[role];
    if (pol.work_days.includes(weekday(today))) for (const s of pol.sessions) sim.schedule(atTime(today, s), 'session', { role });
  }

  if (dom === 1) {
    const next = addMonths(month, 1);
    if (next <= monthOf(sim.endT)) for (const m of sim.activeMembers()) if (m.first_round_month <= next) createRound(sim, m, next);
    sim.task('workroom', 'capacity_check', { at: atTime(today, '09:30') });
    if (today <= sim.endT) {
      const sat = cfg.satisfaction;
      for (const m of sim.activeMembers()) {
        const drift = (sat.start - m.satisfaction) * sat.monthly_regression;
        if (Math.abs(drift) >= 0.05) sim.satisfy(m.id, drift, 'monthly drift toward neutral');
      }
      monthlyRandom(sim, month);
      scripted_followingChecks(sim);
    }
  }
  if (dom === 3) sim.task('counting_house', 'month_close', { at: atTime(today, '10:00'), data: { month: addMonths(month, -1) } });
  if (today > sim.endT) {
    for (const r of db.all(`SELECT * FROM rounds WHERE closed = 0`)) roundDaily(sim, r, today);
    return;
  }
  if (dom === 15 && [0, 3, 6, 9].includes(d.getUTCMonth())) sim.task('counting_house', 'investor_update', { at: atTime(today, '11:00'), data: { quarter: seasonOf(today) } });
  if (dom === 1 && [0, 3, 6, 9].includes(d.getUTCMonth()) && today >= sim.scoredStartT) seasonStart(sim, seasonOf(today));

  if (weekday(today) === 1) {
    if (!sim.ctx.db.get(`SELECT 1 FROM event_log WHERE kind = 'workshop_missed_update' AND date(at/1000, 'unixepoch') = ?`, dateOf(today))) {
      postDigest(sim, atTime(today, '08:00'), false);
    } else {
      sim.task('workroom', 'weekly_digest', { at: atTime(today, '09:00'), data: { today: dateOf(today), open_pieces: openPieces(sim) }, hidden: { update: null } });
    }
    sim.schedule(atTime(today, '10:00'), 'check', { kind: 'scoreboard' });
  }

  for (const r of db.all(`SELECT * FROM rounds WHERE closed = 0`)) roundDaily(sim, r, today);
}

function roundDaily(sim: Sim, r: Row, today: number): void {
  const { cfg, db } = sim.ctx;
  const m = sim.member(r.member_id);
  if (m.status === 'left') return;
  const lead = cfg.rules.desk_proposal_lead_days;
  if (startOfDay(r.agreed_at) - lead * DAY === today) {
    const piece = sim.pieceForRound(r.id)!;
    sim.minutes('stylist', 'curate_proposal', r.member_id, piece.description);
    sim.task('desk', 'proposal', {
      at: atTime(today, '10:00'), memberId: r.member_id, roundId: r.id, pieceId: piece.id,
      data: { to: sim.addressOf(r.member_id), agreed_day: dateOf(r.agreed_at), promised: dateOf(r.promised_at) },
    });
    sim.schedule(atTime(r.agreed_at + Math.max(1, sim.profile(r.member_id).chase_after_late_days) * DAY, '12:00'), 'check', { kind: 'proposal_chase', roundId: r.id });
  }
  if (r.proposal_sent_at && !r.answer_received_at && !r.held_at) {
    const days = Math.floor((today - startOfDay(r.proposal_sent_at)) / DAY);
    if (days >= cfg.rules.silence_call_days && !r.silence_flagged_at) {
      db.update('rounds', r.id, { silence_flagged_at: sim.now() });
      sim.task('desk', 'silence', { at: atTime(today, '09:30'), memberId: r.member_id, roundId: r.id, data: { days, pause_used: m.paused_months } });
    }
    if (days >= cfg.rules.silence_hold_days) {
      const piece = sim.pieceForRound(r.id)!;
      const protocol = r.silence_called_at && r.silence_called_at <= r.proposal_sent_at + (cfg.rules.silence_call_days + 1) * DAY;
      db.update('rounds', r.id, { held_at: sim.now(), held_reason: 'silence', in_play: protocol ? 0 : 1 });
      const used = m.paused_months + 1;
      db.update('members', m.id, { paused_months: used });
      if (used > cfg.rules.pause_max_months_per_year) {
        sim.ruleGap(`${m.id} went past the ${cfg.rules.pause_max_months_per_year}-month pause allowance through silence`, 'engine', 'stylist', 'held anyway', m.id);
      }
      sim.task('workroom', 'hold_piece', { at: atTime(today, '09:30'), memberId: r.member_id, roundId: r.id, pieceId: piece.id, data: { days } });
      sim.logEvent('round_held_silence', { round: r.id, protocol_followed: !!protocol }, false, r.member_id);
    }
  }
}

function monthlyRandom(sim: Sim, month: string): void {
  const { cfg } = sim.ctx;
  const ev = sim.ctx.rng.get('events');
  for (const m of sim.activeMembers()) {
    const p = sim.profile(m.id);
    if (ev.chance(p.question_rate)) sim.schedule(atTime(dayInMonth(month, ev.int(2, 26)), `${ev.int(8, 20)}:${ev.pick(['05', '20', '40'])}`), 'check', { kind: 'random_question', memberId: m.id });
    if (ev.chance(cfg.random_events.occasion_mentioned.p ?? 0)) sim.schedule(atTime(dayInMonth(month, ev.int(2, 26)), '12:15'), 'check', { kind: 'random_occasion', memberId: m.id });
  }
  if (ev.chance(cfg.random_events.extra_application.p_per_month ?? 0)) {
    sim.schedule(atTime(dayInMonth(month, ev.int(3, 25)), '11:00'), 'applicant', { baseCase: false, seedPick: ev.next() });
  }
}

function seasonStart(sim: Sim, season: string): void {
  let i = 0;
  for (const m of sim.activeMembers()) {
    sim.ctx.db.insert('gestures', { id: `G-${season}-${m.id}`, member_id: m.id, season });
    sim.task('record', 'gesture_prompts', { at: atTime(sim.now(), '10:00') + i++ * 10 * 60_000, memberId: m.id, data: { season } });
  }
}

// ───────────────────────────── rounds ─────────────────────────────
export function createRound(sim: Sim, m: Row, month: string): void {
  const { cfg, db } = sim.ctx;
  const id = `R-${m.id}-${month}`;
  if (db.get('SELECT 1 FROM rounds WHERE id = ?', id)) return;
  const lead = cfg.rules.desk_proposal_lead_days;
  let agreed = atTime(dayInMonth(addMonths(month, -1), m.proposal_day), '10:00');
  if (startOfDay(agreed) - lead * DAY <= startOfDay(sim.now())) agreed = atTime(sim.now() + (lead + 1) * DAY, '10:00');
  const promised = atTime(dayInMonth(month, m.delivery_day), '12:00');
  const prodDays = cfg.rules.production_days[m.line as 'boardroom' | 'heritage'];
  const plannedStart = startOfDay(promised) - (cfg.rules.shipping_days + prodDays + cfg.rules.booking_cutoff_buffer_days) * DAY + 8 * HOUR;
  const extras = (db.get(`SELECT value FROM attio_attributes WHERE member_id = ? AND key = 'extra_commission_months'`, m.id)?.value ?? '').split(',');
  const garments = extras.includes(month) ? 2 : 1;
  const r = sim.ctx.rng.get(`curation:${m.id}`);
  const desc = r.pick(CATALOGUE[m.line as 'boardroom' | 'heritage']) + (garments === 2 ? ', with a further commission' : '');
  const scoredMonth = month >= monthOf(sim.scoredStartT) && month <= monthOf(sim.endT);
  db.insert('rounds', { id, member_id: m.id, month, agreed_at: agreed, planned_start: plannedStart, promised_at: promised, scored: scoredMonth ? 1 : 0 });
  const pid = db.nextId('PIECE');
  db.insert('pieces', {
    id: pid, round_id: id, member_id: m.id, description: desc, line: m.line, garments, production_month: monthOf(plannedStart),
    cost_usd: pieceCostUsd(cfg, m.line, garments),
  });
  for (const ev of cfg.scripted_events) {
    if (ev.member === m.id && ev.round_month === month) {
      if (ev.id === 'late_before_wedding') {
        db.update('pieces', pid, { occasion: 'wedding abroad', occasion_at: atTime(parseTime(String(ev.wedding)), '15:00') });
        setScript(sim, pid, { overrun: Number(ev.delay_days), scripted: ev.id });
      }
      if (ev.id === 'fit_fails_twice') setScript(sim, pid, { fit_failures: 2, scripted: ev.id });
    }
  }
  const chaseDays = sim.ctx.cfg.members.profiles[m.profile].chase_after_late_days;
  sim.schedule(startOfDay(promised) + DAY + chaseDays * DAY + 10 * HOUR, 'check', { kind: 'late_chase', roundId: id });
  const occ = db.get('SELECT occasion_at FROM pieces WHERE id = ?', pid);
  if (occ?.occasion_at) sim.schedule(occ.occasion_at, 'check', { kind: 'occasion_check', pieceId: pid });
  sim.schedule(endOfMonth(month) + cfg.rules.round_close_days_after_month * DAY, 'close_round', { roundId: id });
}

// ───────────────────────────── the workshop ─────────────────────────────
export function orderPlaced(sim: Sim, pieceId: string): void {
  const { cfg, db } = sim.ctx;
  const p = sim.piece(pieceId);
  if (p.ordered_at) return;
  db.update('pieces', pieceId, { ordered_at: sim.now() });
  const plannedStart = p.round_id ? sim.round(p.round_id).planned_start : pieceScript(p).planned_start ?? sim.now();
  let start = Math.max(atTime(sim.now() + DAY, '08:00'), plannedStart);
  const w = sim.ctx.rng.get('workshop');
  const sd = cfg.random_events.workshop_start_delay;
  if (w.chance(sd.p ?? 0)) start += w.int(sd.days![0], sd.days![1]) * DAY;
  if (w.chance(cfg.random_events.cloth_unavailable.p ?? 0)) {
    start += w.int(3, 5) * DAY;
    sim.logEvent('cloth_unavailable', { piece: pieceId }, false, p.member_id);
  }
  const po = cfg.random_events.production_overrun;
  const script = pieceScript(p);
  const overrun = script.overrun ?? (w.chance(po.p ?? 0) ? w.int(po.days![0], po.days![1]) : 0);
  setScript(sim, pieceId, { scheduled_start: start, overrun });
  sim.schedule(start, 'workshop_start', { pieceId });
}

export function workshopStart(sim: Sim, pieceId: string): void {
  const { cfg, db } = sim.ctx;
  const p = sim.piece(pieceId);
  if (p.house_status === 'hold' || p.start_at) return;
  const month = monthOf(sim.now());
  const allocation = cfg.capacity.monthly_garment_allocation + Number(getFlag(sim, `allocation_extra:${month}`) ?? 0);
  const startedThisMonth = db.scalar<number>(`SELECT COALESCE(SUM(garments), 0) FROM pieces WHERE start_at IS NOT NULL AND production_month = ?`, month);
  if (startedThisMonth + p.garments > allocation) {
    const next = atTime(dayInMonth(addMonths(month, 1), 1), '08:00');
    sim.logEvent('allocation_overflow', { piece: pieceId, month, started: startedThisMonth, garments: p.garments, allocation }, false, p.member_id);
    setScript(sim, pieceId, { scheduled_start: next, overflowed: true });
    sim.schedule(next, 'workshop_start', { pieceId });
    return;
  }
  if (getFlag(sim, 'hold_members_july') && month === '2027-07' && p.kind === 'monthly') {
    const next = atTime(dayInMonth(addMonths(month, 1), 1), '08:00');
    setScript(sim, pieceId, { scheduled_start: next, held_for_capacity: true });
    sim.schedule(next, 'workshop_start', { pieceId });
    return;
  }
  const script = pieceScript(p);
  const prodDays = cfg.rules.production_days[p.line as 'boardroom' | 'heritage'];
  const cut = p.express ? 6 : 0;
  const shipAt = sim.now() + Math.max(1, prodDays + (script.overrun ?? 0) - cut) * DAY;
  if (script.scripted === 'late_before_wedding') sim.logEvent('late_before_wedding', { piece: pieceId, overrun_days: script.overrun }, true, p.member_id);
  db.update('pieces', pieceId, { start_at: sim.now(), production_month: month });
  setScript(sim, pieceId, { planned_ship: shipAt });
  sim.schedule(shipAt, 'workshop_ship', { pieceId, at: shipAt });
}

/** Projected arrival as the workshop would report it today. */
function projectedArrival(sim: Sim, p: Row): number {
  const { cfg } = sim.ctx;
  const s = pieceScript(p);
  if (p.arrive_at) return p.arrive_at;
  if (s.planned_arrival) return s.planned_arrival;
  const prodDays = cfg.rules.production_days[p.line as 'boardroom' | 'heritage'];
  const start = p.start_at ?? s.scheduled_start ?? sim.now();
  const ship = s.planned_ship ?? start + (prodDays + (s.overrun ?? 0)) * DAY;
  return ship + (p.express ? 1 : cfg.rules.shipping_days) * DAY;
}

function openPieces(sim: Sim) {
  return sim.ctx.db
    .all(`SELECT * FROM pieces WHERE ordered_at IS NOT NULL AND arrive_at IS NULL AND house_status != 'hold' ORDER BY id`)
    .map((p) => ({ piece_id: p.id, member_id: p.member_id, status: p.house_status, promised: p.round_id ? dateOf(sim.round(p.round_id).promised_at) : dateOf(p.occasion_at ?? sim.now()) }));
}

export function postDigest(sim: Sim, at: number, catchUp: boolean): void {
  const { db } = sim.ctx;
  const last = db.scalar<number>(`SELECT COALESCE(MAX(updated_at), 0) FROM airtable_rows WHERE tbl = 'workshop_updates'`);
  const started = db.all(`SELECT * FROM pieces WHERE start_at IS NOT NULL AND reported_start_at IS NULL AND start_at <= ?`, at)
    .map((p) => ({ piece_id: p.id, member_id: p.member_id, started: dateOf(p.start_at) }));
  for (const s of started) db.update('pieces', s.piece_id, { reported_start_at: at });
  const projected = db.all(`SELECT * FROM pieces WHERE ordered_at IS NOT NULL AND ship_at IS NULL AND house_status != 'hold'`).map((p) => {
    const promised = p.round_id ? sim.round(p.round_id).promised_at : p.occasion_at ?? at;
    const proj = projectedArrival(sim, p);
    return { piece_id: p.id, member_id: p.member_id, projected_arrival: iso(proj), promised: dateOf(promised), late: startOfDay(proj) > startOfDay(promised) };
  });
  const id = db.nextId('WSU');
  const update = { week_of: dateOf(at), catch_up: catchUp, since: last ? dateOf(last) : null, started, projected };
  db.insert('airtable_rows', { tbl: 'workshop_updates', id, data: update, updated_at: at, by_actor: 'world' });
  sim.task('workroom', 'weekly_digest', { at: at + HOUR, data: { today: dateOf(at), open_pieces: openPieces(sim) }, hidden: { update } });
}

export function workshopShip(sim: Sim, pieceId: string): void {
  const { cfg, db } = sim.ctx;
  const p = sim.piece(pieceId);
  if (p.ship_at || p.house_status === 'hold') return;
  const s = pieceScript(p);
  if (s.planned_ship && s.planned_ship > sim.now() + HOUR) return; // superseded by an express reschedule
  const c = sim.ctx.rng.get('courier');
  const sd = cfg.random_events.shipping_delay;
  const base = (p.express ? 1 : cfg.rules.shipping_days) * DAY;
  const delay = !p.express && c.chance(sd.p ?? 0) ? c.int(sd.days![0], sd.days![1]) * DAY : 0;
  const arriveAt = sim.now() + base + delay;
  db.update('pieces', pieceId, { ship_at: sim.now(), house_status: 'shipped' });
  setScript(sim, pieceId, { planned_arrival: arriveAt });
  const expected = sim.now() + base;
  if (p.round_id) {
    sim.task('desk', 'status_shipped', { memberId: p.member_id, roundId: p.round_id, pieceId, data: { to: sim.addressOf(p.member_id), expected: dateOf(expected) } });
  }
  const promisedAt = p.round_id ? sim.round(p.round_id).promised_at : p.occasion_at ?? arriveAt;
  if (delay && startOfDay(arriveAt) > startOfDay(promisedAt)) {
    const promised = promisedAt;
    sim.task('workroom', 'courier_delay', {
      at: sim.now() + DAY, memberId: p.member_id, pieceId,
      data: { projected: iso(arriveAt), promised: dateOf(promised), late: startOfDay(arriveAt) > startOfDay(promised) },
    });
  }
  sim.schedule(arriveAt, 'arrive', { pieceId });
}

export function arrive(sim: Sim, pieceId: string): void {
  const { cfg, db } = sim.ctx;
  const p = sim.piece(pieceId);
  if (p.arrive_at) return;
  const s = pieceScript(p);
  if (s.planned_arrival && s.planned_arrival > sim.now() + HOUR) return; // rescheduled
  db.update('pieces', pieceId, { arrive_at: sim.now(), house_status: 'delivered' });
  sim.logEvent('piece_arrived', { piece: pieceId }, false, p.member_id);
  if (p.round_id) {
    const r = sim.round(p.round_id);
    if (startOfDay(sim.now()) > startOfDay(r.promised_at)) scoring.failure(sim, p.member_id, 'late_piece', r.id, pieceId);
  }
  if (p.kind === 'commission') {
    sim.task('desk', 'book_fitting', { memberId: p.member_id, pieceId, data: { availability: 'Family commission: fittings for the family in one session.' } });
    return;
  }
  if (s.damaged_script || sim.ctx.rng.get('courier').chance(cfg.random_events.damaged_on_arrival.p ?? 0)) {
    damagedOnArrival(sim, pieceId, s.damaged_script ? 0.5 : sim.ctx.rng.get('courier').int(2, 6));
    return;
  }
  sim.task('desk', 'book_fitting', { memberId: p.member_id, roundId: p.round_id, pieceId, data: { availability: availability(sim, p.member_id) } });
}

export function damagedOnArrival(sim: Sim, pieceId: string, hoursToMessage: number): void {
  const p = sim.piece(pieceId);
  const msgAt = sim.now() + hoursToMessage * HOUR;
  setScript(sim, pieceId, { damaged: true });
  sim.schedule(msgAt, 'check', { kind: 'damage_message', pieceId });
  // repaired and re-delivered within the week
  sim.schedule(sim.now() + 7 * DAY, 'check', { kind: 'repaired', pieceId });
  scoring.failure(sim, p.member_id, 'damaged_piece', p.round_id, pieceId);
}

function availability(sim: Sim, memberId: string): string {
  const prof = sim.profile(memberId);
  if (prof.label.includes('travels')) return 'He travels often; offer two slots.';
  if (prof.via_assistant) return 'Arrange through his assistant.';
  return '';
}

export function fittingBooked(sim: Sim, ev: Row): void {
  const { db } = sim.ctx;
  if (!ev.piece_id && ev.member_id) {
    const p = db.get(`SELECT id FROM pieces WHERE member_id = ? AND arrive_at IS NOT NULL AND fit_ok_at IS NULL ORDER BY id DESC LIMIT 1`, ev.member_id);
    if (p) {
      db.update('calendar_events', ev.id, { piece_id: p.id });
      ev = { ...ev, piece_id: p.id };
    }
  }
  if (!ev.piece_id) return;
  const p = sim.piece(ev.piece_id);
  const field = ev.kind === 'fitting' ? 'fitting_booked_at' : 'alteration_booked_at';
  if (ev.kind === 'alteration') {
    const s = pieceScript(p);
    const list = (s.alterations_booked ?? []) as number[];
    list.push(sim.now());
    setScript(sim, p.id, { alterations_booked: list });
  }
  db.run(`UPDATE pieces SET ${field} = COALESCE(${field}, ?) WHERE id = ?`, sim.now(), p.id);
  const at = Math.max(ev.starts_at, sim.now() + HOUR);
  sim.schedule(at, 'fitting', { eventId: ev.id });
}

export function fitting(sim: Sim, eventId: string): void {
  const { db } = sim.ctx;
  const ev = db.get('SELECT * FROM calendar_events WHERE id = ?', eventId);
  if (!ev || ev.status !== 'booked' || !ev.piece_id) return;
  const p = sim.piece(ev.piece_id);
  if (p.fit_ok_at) return;
  if (!p.arrive_at) {
    // booked before arrival: move it a day after the piece arrives
    sim.schedule(sim.now() + DAY, 'fitting', { eventId });
    return;
  }
  const attempt = p.fit_attempts + 1;
  sim.minutes('stylist', attempt === 1 ? 'fitting' : 'alteration_fitting', p.member_id, p.id);
  const s = pieceScript(p);
  let ok: boolean;
  if ((s.fit_failures ?? 0) >= attempt) ok = false;
  else ok = sim.ctx.rng.get(`fit:${p.member_id}`).chance(attempt === 1 ? sim.profile(p.member_id).fit_ok : 0.95);
  db.update('pieces', p.id, { fit_attempts: attempt });
  if (s.scripted === 'fit_fails_twice' && attempt === 1) sim.logEvent('fit_fails_twice', { piece: p.id }, true, p.member_id);
  if (ok) {
    db.update('pieces', p.id, { fit_ok_at: sim.now() });
    if (p.occasion_at && sim.now() < p.occasion_at) {
      sim.satisfy(p.member_id, sim.ctx.cfg.satisfaction.occasion_saved, `ready for ${p.occasion}`);
    }
    if (p.round_id) {
      sim.task('desk', 'portrait_offer', { memberId: p.member_id, roundId: p.round_id, pieceId: p.id, data: { to: sim.addressOf(p.member_id) } });
      const r = sim.round(p.round_id);
      sim.task('record', 'record_line', {
        at: sim.now() + 2 * HOUR, memberId: p.member_id, roundId: r.id,
        data: { month_facts: { piece: p.description, answer: r.answer, fit: attempt === 1 ? 'right first time' : `right after ${attempt - 1} alteration(s)` } },
      });
    }
  } else {
    const failures = ((s.failed_at ?? []) as number[]).concat(sim.now());
    setScript(sim, p.id, { failed_at: failures });
    db.run('UPDATE pieces SET fit_failed_at = COALESCE(fit_failed_at, ?) WHERE id = ?', sim.now(), p.id);
    sim.task('desk', 'book_alteration', { memberId: p.member_id, roundId: p.round_id, pieceId: p.id, data: { attempt } });
    scoring.failure(sim, p.member_id, 'failed_fit', p.round_id, p.id);
  }
}

export function portraitSession(sim: Sim, memberId: string): void {
  const m = sim.member(memberId);
  sim.cost('portrait_session', sim.ctx.cfg.membership.tiers[m.tier as 'member' | 'principal'].portrait_session_usd, memberId);
  sim.task('record', 'file_portrait', { at: sim.now() + 3 * DAY, memberId });
}

// ───────────────────────────── applicants ─────────────────────────────
export function applicantArrives(sim: Sim, p: { baseCase: boolean; joinMonth?: string; following?: boolean; seedPick?: number }): void {
  const { cfg, db } = sim.ctx;
  const g = sim.ctx.rng.get('applicants');
  const mix = cfg.members.new_member_mix;
  let name = `SIM-${g.pick(FIRST)} ${g.pick(LAST)}`;
  while (db.get('SELECT 1 FROM applicants WHERE name = ? UNION SELECT 1 FROM members WHERE name = ?', name, name)) name = `SIM-${g.pick(FIRST)} ${g.pick(LAST)}`;
  const tier = g.chance(mix.principal_share) ? 'principal' : 'member';
  const line = g.chance(mix.heritage_share) ? 'heritage' : 'boardroom';
  const profile = g.pick(mix.profiles);
  const id = db.nextId('APP');
  const roles = ['founder of a payments company', 'chief executive of a logistics group', 'managing partner at an investment firm', 'founder of a media company', 'chair of a family holding company'];
  const summary = p.following
    ? `Founder and public figure with a very large social following (several million). Wants to be dressed for appearances. ${tier}, ${line}.`
    : `${g.pick(roles)}; referred by a member. ${tier}, ${line}.`;
  db.insert('applicants', { id, name, received_at: sim.now(), summary, following: p.following ? 1 : 0, tier, line, profile, intended_join: p.joinMonth, status: p.baseCase || p.following ? 'received' : 'received_extra' });
  sim.logEvent('application', { id, following: !!p.following, base_case: p.baseCase }, !!p.following);
  sim.task('door', 'applicant_brief', { data: { applicant_id: id } });
}

export async function applicantDecision(sim: Sim, applicantId: string): Promise<void> {
  const { db, policies } = sim.ctx;
  const a = db.get('SELECT * FROM applicants WHERE id = ?', applicantId);
  if (!a || a.decision) return;
  let admit: boolean;
  let promotional = false;
  if (a.following) {
    admit = true;
    promotional = policies.applicant_following === 'A';
    sim.ruleGap('An applicant with a large public following applied', 'door', 'nick', promotional ? 'Admitted with a promotional piece (policy A)' : 'Admitted on standard terms; privacy promise covers his posts (policy B)');
  } else if (a.status === 'received') {
    admit = true;
  } else {
    const d = await sim.humans.decide('nick', `Application ${a.id}: ${a.summary}. The house is growing to plan this month already.`, ['Admit', 'Place on the waiting list'], 1);
    admit = d.choice === 0;
  }
  db.update('applicants', applicantId, { decided_at: sim.now(), decision: admit ? (promotional ? 'admit_promotional' : 'admit') : 'waitlist', status: admit ? 'admitted' : 'waitlisted' });
  if (admit) sim.task('door', 'draft_agreement', { data: { applicant_id: applicantId, promotional } });
}

export function envelopeSent(sim: Sim, env: Row): void {
  if (env.template !== 'membership_agreement') return;
  const g = sim.ctx.rng.get('applicants');
  sim.schedule(sim.now() + g.int(2, 6) * DAY + g.int(1, 8) * HOUR, 'sign', { envelopeId: env.id });
}

export function applicantSigns(sim: Sim, envelopeId: string): void {
  const { db } = sim.ctx;
  const env = db.get('SELECT * FROM docusign_envelopes WHERE id = ?', envelopeId);
  if (!env || env.status === 'signed') return;
  db.update('docusign_envelopes', envelopeId, { status: 'signed', signed_at: sim.now() });
  const a = db.get('SELECT * FROM applicants WHERE id = ?', env.subject_id);
  if (!a || a.member_id) return;
  const n = db.scalar<number>('SELECT COUNT(*) FROM members') + 1;
  const memberId = `M${String(n).padStart(2, '0')}`;
  const g = sim.ctx.rng.get('applicants');
  const dom = new Date(sim.now()).getUTCDate();
  const firstRound = addMonths(monthOf(sim.now()), dom <= 10 ? 1 : 2);
  addMember(sim, { id: memberId, name: a.name, tier: a.tier, line: a.line, profile: a.profile, proposal_day: g.int(5, 12), delivery_day: g.int(14, 21) }, sim.now(), firstRound, !!a.following);
  db.update('applicants', a.id, { member_id: memberId, status: 'member' });
  sim.minutes('stylist', 'curate_proposal', memberId, 'first meeting: measures and preferences', 60);
  const tier = sim.ctx.cfg.membership.tiers[a.tier as 'member' | 'principal'];
  sim.task('counting_house', 'new_member_billing', { memberId, data: { tier: a.tier, fee: tier.fee_usd } });
  // If the regular day-1 round creation has passed, create the first round now.
  if (firstRound === addMonths(monthOf(sim.now()), 1) && firstRound <= monthOf(sim.endT)) createRound(sim, sim.member(memberId), firstRound);
  if (a.following && sim.ctx.policies.applicant_following === 'A') {
    sim.schedule(sim.now() + 42 * DAY, 'publication', { memberId, kind: 'promotional_piece' });
    sim.cost('promotional_piece', sim.ctx.cfg.costs.promotional_piece_usd, memberId, 'applicant_following:A');
  }
}

function scripted_followingChecks(sim: Sim): void {
  if (sim.ctx.policies.applicant_following !== 'B') return;
  for (const m of sim.ctx.db.all(`SELECT id FROM members WHERE following = 1 AND status = 'active'`)) {
    if (sim.ctx.rng.get('following').chance(sim.ctx.cfg.random_events.following_post_breach.p_per_month ?? 0)) {
      sim.schedule(sim.now() + sim.ctx.rng.get('following').int(2, 25) * DAY, 'publication', { memberId: m.id, kind: 'post_breach' });
    }
  }
}

// ───────────────────────────── dinners ─────────────────────────────
export function dinner(sim: Sim, id: string): void {
  const { db, cfg } = sim.ctx;
  const since = sim.now() - 45 * DAY;
  const invited = db.all(`SELECT DISTINCT member_id FROM outbox WHERE kind = 'dinner_invitation' AND delivered = 1 AND sent_at >= ?`, since);
  let attended = 0;
  for (const { member_id } of invited) {
    const rsvp = db.get(`SELECT data FROM airtable_rows WHERE tbl = 'rsvp' AND id LIKE ? ORDER BY updated_at DESC`, `${member_id}:%`);
    if (rsvp && JSON.parse(rsvp.data).attend) {
      attended++;
      sim.satisfy(member_id, cfg.satisfaction.dinner_attended, id);
    }
  }
  for (const role of ['operator', 'stylist', 'nick'] as Role[]) sim.minutes(role, 'dinner_hosting', undefined, id);
  const extra = db.all(`SELECT * FROM exceptions WHERE decision = 'granted' AND request LIKE ?`, `%${id}%`);
  for (const e of extra) sim.cost('extra_dinner_guests', 2 * cfg.costs.extra_dinner_guest_usd, e.member_id, `exceptions:${sim.ctx.policies.exceptions}`);
  sim.logEvent('dinner_held', { id, invited: invited.length, attended });
}

// ───────────────────────────── people's judgement calls ─────────────────────────────
export async function stylistRoutine(sim: Sim): Promise<void> {
  const { db } = sim.ctx;
  // Swaps: the stylist picks the alternative, then the Workroom places it.
  for (const r of db.all(`SELECT * FROM rounds WHERE answer = 'swap' AND answer_recorded_at IS NOT NULL AND closed = 0`)) {
    const p = sim.pieceForRound(r.id);
    if (!p || pieceScript(p).swapped || p.ordered_at) continue;
    sim.minutes('stylist', 'swap_alternative', r.member_id, p.description);
    const alt = sim.ctx.rng.get(`curation:${r.member_id}`).pick(CATALOGUE[p.line as 'boardroom' | 'heritage']);
    db.update('pieces', p.id, { description: alt });
    setScript(sim, p.id, { swapped: true });
    sim.task('workroom', 'place_order', { memberId: r.member_id, roundId: r.id, pieceId: p.id, data: placeOrderData(sim, r) });
  }
  // Gestures: choose this season's considered gesture for each member.
  for (const g of db.all(`SELECT * FROM gestures WHERE chosen_at IS NULL AND season = ?`, seasonOf(sim.now()))) {
    const hasPrompt = db.get(`SELECT 1 FROM attio_notes WHERE subject_id = ? AND kind = 'gesture_prompt' AND created_at >= ?`, g.member_id, sim.now() - 20 * DAY);
    if (!hasPrompt && sim.now() < startOfDay(parseTime(`${seasonStartDate(g.season)}`)) + 10 * DAY) continue; // give the Record a chance
    sim.minutes('stylist', 'choose_gesture', g.member_id);
    const options = ['a handwritten note with a pocket square in his colours', 'a book chosen for his next trip', 'a framed portrait from the season', 'flowers for a family occasion'];
    const d = await sim.humans.decide('stylist', `Choose this season's considered gesture for ${g.member_id}.${hasPrompt ? '' : ' (No prompts surfaced by the Record.)'}`, options, sim.ctx.rng.get('gestures').int(0, options.length - 1));
    db.update('gestures', g.id, { chosen_at: sim.now(), description: options[d.choice] });
    sim.schedule(sim.now() + sim.ctx.rng.get('gestures').int(3, 30) * DAY, 'gesture', { gestureId: g.id });
  }
}

const seasonStartDate = (season: string) => {
  const [y, q] = season.split('-Q');
  return `${y}-${String((Number(q) - 1) * 3 + 1).padStart(2, '0')}-01`;
};

export function placeOrderData(sim: Sim, r: Row) {
  return { planned_start: dateOf(r.planned_start), cutoff: dateOf(r.planned_start - DAY) };
}

export async function exceptionDecision(sim: Sim, f: Row): Promise<void> {
  const { db, policies, cfg } = sim.ctx;
  const memberId = f.member_id;
  sim.minutes('nick', 'decide_exception', memberId, f.summary);
  const dinnerId = getFlag(sim, `exception_dinner:${memberId}`) ?? 'dinner';
  const prior = db.get(`SELECT * FROM exceptions WHERE member_id != ? AND request LIKE '%extra dinner guests%' ORDER BY at LIMIT 1`, memberId);
  let granted: boolean;
  let rationale: string;
  if (policies.exceptions === 'B') {
    granted = false;
    rationale = 'Policy B: exceptions are never granted.';
  } else {
    const situation = `${memberId} asks to bring two extra guests to the ${dinnerId} (published rule: ${cfg.rules.dinner_guest_allowance} guest).` +
      (prior ? ` You granted ${prior.member_id} the same exception on ${dateOf(prior.at)} (${prior.decision}).` : '');
    const d = await sim.humans.decide('nick', situation, ['Grant it', 'Decline it'], prior ? (prior.decision === 'granted' ? 0 : 1) : 0);
    granted = d.choice === 0;
    rationale = d.rationale;
    if (prior) sim.ruleGap('A second member asked for the same exception another member received', 'desk', 'nick', `${granted ? 'Granted' : 'Declined'}: ${rationale}`, memberId);
  }
  db.insert('exceptions', {
    id: db.nextId('EXC'), at: sim.now(), member_id: memberId, request: `extra dinner guests for ${dinnerId}`, decision: granted ? 'granted' : 'declined',
    decided_by: 'nick', precedent_of: prior?.id, rationale,
  });
  const s = cfg.satisfaction;
  sim.satisfy(memberId, granted ? s.exception_granted : prior && prior.decision === 'granted' ? s.exception_precedent_denied : s.exception_denied, `exception ${granted ? 'granted' : 'declined'}`);
  sim.task('desk', 'relay_decision', { memberId, data: { to: sim.addressOf(memberId), decision: granted ? 'Of course: please do bring your two guests.' : 'We keep the evening to one guest each, so that it stays what it is. We very much hope to see you.' } });
  if (f.ref) db.run('UPDATE inbox SET replied_at = COALESCE(replied_at, ?) WHERE id = ?', sim.now() + HOUR, f.ref);
}

export async function changeRequest(sim: Sim, f: Row): Promise<void> {
  const { cfg } = sim.ctx;
  const memberId = f.member_id;
  sim.minutes('stylist', 'improvise', memberId, f.summary);
  sim.minutes('stylist', 'personal_call', memberId, 'change request');
  const d = await sim.humans.decide(
    'stylist',
    `${memberId} asks for a change to a finished piece three days before his event: "${f.summary}". No house rule covers changes to finished pieces near an event.`,
    [`Rush a local alteration at the house's cost (about $${cfg.costs.local_alteration_rush_usd})`, 'Decline gracefully and suggest wearing it as made'],
    0,
  );
  if (!sim.isCovered('change_to_finished_piece')) sim.ruleGap('A member asked for a change to a finished piece days before an event', 'desk', 'stylist', d.rationale + ` → ${d.choice === 0 ? 'rush alteration' : 'declined'}`, memberId);
  if (d.choice === 0) {
    sim.cost('rush_alteration', cfg.costs.local_alteration_rush_usd, memberId);
    sim.satisfy(memberId, cfg.satisfaction.rush_change_granted, 'rush change granted');
  } else {
    sim.satisfy(memberId, cfg.satisfaction.change_declined, 'change declined');
  }
  if (f.ref) sim.ctx.db.run('UPDATE inbox SET replied_at = COALESCE(replied_at, ?) WHERE id = ?', sim.now(), f.ref);
}

export async function occasionFlag(sim: Sim, role: Role, f: Row): Promise<void> {
  const pending = f.member_id ? getFlag(sim, `commission_pending:${f.member_id}`) : undefined;
  if (role === 'stylist' && pending) {
    sim.minutes('stylist', 'personal_call', f.member_id, 'family commission');
    acceptCommission(sim, f.member_id, JSON.parse(pending));
    setFlag(sim, `commission_pending:${f.member_id}`, '');
    if (f.ref) sim.ctx.db.run('UPDATE inbox SET replied_at = COALESCE(replied_at, ?) WHERE id = ?', sim.now(), f.ref);
    return;
  }
  sim.minutes(role, role === 'operator' ? 'occasion_rescue' : 'review_draft', f.member_id, f.summary);
}

function acceptCommission(sim: Sim, memberId: string, c: { garments: number; for_month: string; occasion: string }): void {
  const { db, cfg } = sim.ctx;
  const pid = db.nextId('PIECE');
  const plannedStart = atTime(dayInMonth(c.for_month, 1), '08:00');
  db.insert('pieces', {
    id: pid, member_id: memberId, description: `family commission: ${c.garments} agbada and kaftan for the family celebration abroad`, line: 'heritage',
    garments: c.garments, kind: 'commission', production_month: c.for_month, occasion: 'family celebration abroad', occasion_at: atTime(parseTime(c.occasion), '12:00'),
    cost_usd: pieceCostUsd(cfg, 'heritage', c.garments), script: { planned_start: plannedStart },
  });
  sim.logEvent('family_commission_accepted', { piece: pid, garments: c.garments, month: c.for_month }, false, memberId);
  sim.schedule(atTime(parseTime(c.occasion), '12:00'), 'check', { kind: 'occasion_check', pieceId: pid });
  sim.task('workroom', 'place_order', { memberId, pieceId: pid, data: { planned_start: dateOf(plannedStart), cutoff: dateOf(plannedStart - DAY) } });
  sim.task('workroom', 'capacity_check', { at: sim.now() + 2 * HOUR });
  const f = capacityForecast(sim.ctx).find((x) => x.month === c.for_month);
  if (f && f.garments >= cfg.capacity.monthly_garment_allocation) {
    sim.logEvent('allocation_month_7', { month: c.for_month, garments: f.garments, allocation: cfg.capacity.monthly_garment_allocation }, true, memberId);
  }
}

export async function capacityDecision(sim: Sim, f: Row): Promise<void> {
  const { db } = sim.ctx;
  if (getFlag(sim, 'capacity_decided')) {
    sim.minutes('operator', 'review_draft', undefined, 'capacity already decided');
    return;
  }
  sim.minutes('operator', 'capacity_decision', undefined, f.summary);
  const d = await sim.humans.decide(
    'operator',
    `${f.summary} The workshop's allocation is ${sim.ctx.cfg.capacity.monthly_garment_allocation} garments a month. A family commission of 50 garments is planned for July. No rule says what to do when the allocation is reached.`,
    ['Stagger the family commission across June and July', 'Ask the workshop for extra allocation in July', "Hold some members' July pieces a month"],
    0,
  );
  setFlag(sim, 'capacity_decided', String(d.choice));
  sim.ruleGap('Demand reached the monthly garment allocation', 'workroom', 'operator', `${['stagger', 'extra allocation', 'hold members'][d.choice]}: ${d.rationale}`);
  const commission = db.get(`SELECT * FROM pieces WHERE kind = 'commission' AND start_at IS NULL ORDER BY id LIMIT 1`);
  if (d.choice === 0 && commission) {
    const half = Math.floor(commission.garments / 2);
    const pid = db.nextId('PIECE');
    const juneStart = atTime(dayInMonth(addMonths(commission.production_month, -1), 7), '08:00');
    db.update('pieces', commission.id, { garments: commission.garments - half, cost_usd: pieceCostUsd(sim.ctx.cfg, 'heritage', commission.garments - half) });
    db.insert('pieces', {
      id: pid, member_id: commission.member_id, description: `${commission.description} (first half)`, line: 'heritage', garments: half, kind: 'commission',
      production_month: monthOf(juneStart), occasion: commission.occasion, occasion_at: commission.occasion_at, cost_usd: pieceCostUsd(sim.ctx.cfg, 'heritage', half),
      script: { planned_start: juneStart }, house_status: commission.house_status,
    });
    if (commission.ordered_at) orderPlaced(sim, pid);
  } else if (d.choice === 1) {
    const agrees = sim.ctx.rng.get('workshop').chance(0.5);
    if (agrees) setFlag(sim, `allocation_extra:${commission?.production_month ?? '2027-07'}`, '20');
    sim.logEvent('workshop_extra_allocation', { agreed: agrees });
  } else if (d.choice === 2) {
    setFlag(sim, 'hold_members_july', '1');
  }
}

export async function workshopChase(sim: Sim, f: Row): Promise<void> {
  sim.minutes('operator', 'improvise', undefined, f.summary);
  if (!sim.isCovered('workshop_missed_update')) sim.ruleGap('The workshop missed its weekly update', 'workroom', 'operator', 'Chased the workshop by phone; asked for a catch-up update tomorrow.');
  postDigest(sim, atTime(sim.now() + DAY, '10:00'), true);
}

// ───────────────────────────── engine flags (not member-visible) ─────────────────────────────
export function setFlag(sim: Sim, key: string, value: string): void {
  sim.ctx.db.run(`INSERT OR REPLACE INTO airtable_rows (tbl, id, data, updated_at, by_actor) VALUES ('_engine', ?, ?, ?, 'engine')`, key, JSON.stringify(value), sim.now());
}
export function getFlag(sim: Sim, key: string): string | undefined {
  const r = sim.ctx.db.get(`SELECT data FROM airtable_rows WHERE tbl = '_engine' AND id = ?`, key);
  const v = r ? JSON.parse(r.data) : undefined;
  return v === '' ? undefined : v;
}

export { pieceScript, setScript, projectedArrival };
export const _unused = { iso, endOfMonth };
