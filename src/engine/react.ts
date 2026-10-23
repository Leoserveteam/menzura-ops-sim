import type { Row } from '../db.ts';
import type { Sim } from './sim.ts';
import * as world from './world.ts';
import * as scoring from './scoring.ts';
import { DAY, HOUR, dateOf, iso, parseTime, startOfDay } from '../util/time.ts';

/**
 * Turns what agents and people do through the tools into consequences in the
 * world. The mocks only record; this is where a booked fitting becomes a
 * fitting, an "ordered" record becomes work at the workshop, and so on.
 */
export function wireReactions(sim: Sim): void {
  const { bus, db } = sim.ctx;

  // A draft that names its member but not its round or piece is linked to the open one it must be about.
  bus.on('draft', (d: Row) => {
    if (!d.member_id) return;
    const patch: Record<string, string> = {};
    if (d.kind === 'proposal' && !d.round_id) {
      const r = db.get(`SELECT id FROM rounds WHERE member_id = ? AND proposal_sent_at IS NULL AND closed = 0 ORDER BY agreed_at LIMIT 1`, d.member_id);
      if (r) patch.round_id = r.id;
    }
    const status: Record<string, string> = { status_production: 'in_production', status_shipped: 'shipped', late_notice: '' };
    if (d.kind in status && !d.piece_id) {
      const p = db.get(
        `SELECT id, round_id FROM pieces WHERE member_id = ? AND kind = 'monthly' AND (? = '' OR house_status = ?) AND arrive_at IS NULL ORDER BY id DESC LIMIT 1`,
        d.member_id, status[d.kind], status[d.kind],
      );
      if (p) Object.assign(patch, { piece_id: p.id, ...(d.round_id ? {} : { round_id: p.round_id }) });
    }
    if (d.kind === 'portrait_offer' && !d.round_id) {
      const r = db.get(`SELECT r.id FROM rounds r JOIN pieces p ON p.round_id = r.id WHERE r.member_id = ? AND p.fit_ok_at IS NOT NULL AND r.portrait_offered_at IS NULL ORDER BY r.month DESC LIMIT 1`, d.member_id);
      if (r) patch.round_id = r.id;
    }
    if (Object.keys(patch).length) db.update('outbox', d.id, patch);
  });

  bus.on('flag', (f: Row) => {
    if (f.topic === 'disappointment' && f.member_id) scoring.markFlagged(sim, f.member_id);
    sim.humans.onFlag(f);
  });

  bus.on('approval_requested', (a: Row) => {
    if (a.urgent) sim.schedule(sim.humans.urgentResponseAt(a.veto, sim.now()), 'session', { role: a.veto, urgentOnly: true });
  });

  bus.on('attribute', (e: { member_id: string; key: string; value: string }) => {
    // Lenient on the exact key: "answer:2027-01", "answer_2027-01", "monthly answer 2027-01"...
    const m = e.key.toLowerCase().match(/answer\D{0,12}(\d{4}-\d{2})/);
    if (!m) return;
    const r = db.get('SELECT * FROM rounds WHERE member_id = ? AND month = ?', e.member_id, m[1]);
    if (!r || r.answer_recorded_at) return;
    const value = (['approve', 'swap', 'hold'].find((w) => e.value.toLowerCase().includes(w)) ?? e.value.toLowerCase().trim());
    db.update('rounds', r.id, { answer_recorded_at: sim.now(), answer: ['approve', 'swap', 'hold'].includes(value) ? value : r.answer });
    const piece = sim.pieceForRound(r.id)!;
    if (value === 'approve') {
      sim.task('workroom', 'place_order', { memberId: r.member_id, roundId: r.id, pieceId: piece.id, data: world.placeOrderData(sim, r) });
    } else if (value === 'hold') {
      db.update('rounds', r.id, { held_at: sim.now(), held_reason: 'member chose hold', in_play: 0 });
      sim.task('workroom', 'hold_piece', { memberId: r.member_id, roundId: r.id, pieceId: piece.id, data: { days: 0 } });
    }
    // swap: the stylist picks the alternative at her next session
  });

  bus.on('note', (n: Row) => {
    if (n.kind !== 'learned') return;
    const r =
      db.get(`SELECT r.* FROM rounds r JOIN pieces p ON p.round_id = r.id AND p.kind = 'monthly' WHERE r.member_id = ? AND r.closed = 0 AND r.record_line_at IS NULL AND p.fit_ok_at IS NOT NULL ORDER BY r.month LIMIT 1`, n.subject_id) ??
      db.get(`SELECT * FROM rounds WHERE member_id = ? AND closed = 0 AND record_line_at IS NULL ORDER BY month LIMIT 1`, n.subject_id);
    if (r) db.update('rounds', r.id, { record_line_at: sim.now() });
  });

  bus.on('piece_status', (e: { piece_id: string; status: string }) => {
    const p = sim.piece(e.piece_id);
    if (e.status === 'ordered') world.orderPlaced(sim, p.id);
    if (e.status === 'in_production' && p.round_id && !p.production_note_at) {
      sim.task('desk', 'status_production', { memberId: p.member_id, roundId: p.round_id, pieceId: p.id, data: { to: sim.addressOf(p.member_id), promised: dateOf(sim.round(p.round_id).promised_at) } });
    }
  });

  bus.on('late_flag', (e: { piece_id: string }) => {
    const p = sim.piece(e.piece_id);
    const proj = world.projectedArrival(sim, p);
    if (p.round_id && !p.late_note_at && !world.pieceScript(p).late_notice_task) {
      world.setScript(sim, p.id, { late_notice_task: true });
      sim.task('desk', 'late_notice', {
        memberId: p.member_id, roundId: p.round_id, pieceId: p.id, urgent: true,
        data: { to: sim.addressOf(p.member_id), promised: dateOf(sim.round(p.round_id).promised_at), projected: dateOf(proj) },
      });
    }
    if (p.occasion_at && proj > p.occasion_at - 3 * DAY && !world.pieceScript(p).guarantee_task) {
      world.setScript(sim, p.id, { guarantee_task: true });
      sim.task('table', 'occasion_guarantee', {
        memberId: p.member_id, pieceId: p.id, urgent: true,
        data: { projected: dateOf(proj), occasion: p.occasion, occasion_at: dateOf(p.occasion_at) },
      });
    }
  });

  bus.on('capacity_warning', (e: { month: string; garments: number }) => {
    sim.logEvent('capacity_warning', { month: e.month, garments: e.garments });
  });

  bus.on('booked', (ev: Row) => {
    if (ev.kind === 'fitting' || ev.kind === 'alteration') world.fittingBooked(sim, ev);
    if (ev.kind === 'portrait_session' && ev.member_id) sim.schedule(Math.max(ev.starts_at, sim.now() + HOUR), 'portrait_session', { memberId: ev.member_id });
    if (ev.kind === 'courier' && ev.piece_id) expressPiece(sim, ev.piece_id);
  });

  bus.on('credit', (c: { member_id: string; reason: string }) => {
    sim.satisfy(c.member_id, sim.ctx.cfg.satisfaction.recovery.A, `recovery A: free month (${c.reason})`);
  });

  bus.on('envelope_sent', (env: Row) => world.envelopeSent(sim, env));
}

/** Occasion guarantee: workshop priority and express courier. */
function expressPiece(sim: Sim, pieceId: string): void {
  const { db, cfg } = sim.ctx;
  const p = sim.piece(pieceId);
  if (p.express || p.arrive_at) return;
  db.update('pieces', pieceId, { express: 1 });
  sim.cost('occasion_guarantee', cfg.costs.occasion_guarantee_express_usd, p.member_id, undefined, `express for ${pieceId}`);
  sim.logEvent('occasion_guarantee_used', { piece: pieceId }, false, p.member_id);
  const s = world.pieceScript(p);
  if (!p.ship_at) {
    const prodDays = cfg.rules.production_days[p.line as 'boardroom' | 'heritage'];
    const start = p.start_at ?? s.scheduled_start ?? sim.now();
    const original = s.planned_ship ?? start + (prodDays + (s.overrun ?? 0)) * DAY;
    const newShip = Math.max(sim.now() + DAY, original - 6 * DAY);
    world.setScript(sim, pieceId, { planned_ship: newShip });
    if (p.start_at) sim.schedule(newShip, 'workshop_ship', { pieceId });
  } else {
    const newArrival = Math.max(sim.now() + DAY, p.ship_at + DAY);
    world.setScript(sim, pieceId, { planned_arrival: newArrival });
    sim.schedule(newArrival, 'arrive', { pieceId });
  }
}

export const _t = { iso, parseTime, startOfDay };
