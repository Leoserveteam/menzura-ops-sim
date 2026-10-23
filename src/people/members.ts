import type { Row } from '../db.ts';
import type { Sim } from '../engine/sim.ts';
import { DAY, HOUR, dateOf, iso, monthOf } from '../util/time.ts';
import * as scoring from '../engine/scoring.ts';

export type Intent =
  | 'answer' | 'question' | 'taste_question' | 'disappointment' | 'chase' | 'change_request' | 'exception'
  | 'commission' | 'occasion' | 'portrait_accept' | 'portrait_decline' | 'ack' | 'rsvp';

/**
 * Simulated members. The seeded behaviour profile decides what a member does
 * and when (so runs repeat); in live mode Haiku writes the words. Members
 * never see a score; they carry a satisfaction value the house cannot read.
 */
export class Members {
  constructor(private sim: Sim) {}

  private rng(memberId: string) {
    return this.sim.ctx.rng.get(`member:${memberId}`);
  }

  private persona(memberId: string): string {
    const m = this.sim.member(memberId);
    const p = this.sim.profile(memberId);
    return (
      `You are ${m.name.replace(/^SIM-/, '')}, a fictional ${m.tier === 'principal' ? 'Principal' : 'Member'} of a private members' house that dresses you every month ` +
      `(${m.line === 'heritage' ? 'agbada, kaftan and ceremonial dress' : 'tailoring'}). ${p.label}. ` +
      (p.via_assistant ? 'You never write yourself; your assistant writes for you, in the third person. ' : '') +
      'You value time, discretion and being known; you dislike being sold to. Write the way a busy senior person writes: short.'
    );
  }

  /** Earliest time a member could reply, honouring silent spells. */
  private replyAt(memberId: string, base: number): number {
    const m = this.sim.member(memberId);
    if (m.silent_from && m.silent_to && base >= m.silent_from && base < m.silent_to) return m.silent_to + this.rng(memberId).int(6, 30) * HOUR;
    return base;
  }

  async write(memberId: string, purpose: string, fallback: string): Promise<string> {
    if (this.sim.ctx.mode !== 'live') return fallback;
    return this.sim.llm.write(memberId, this.persona(memberId), `${purpose}\nWrite only the message body, 1-3 sentences.`, fallback);
  }

  // ───────────────────────── outbound arriving ─────────────────────────
  async deliver(outboxId: string): Promise<void> {
    const db = this.sim.ctx.db;
    const d = db.get('SELECT * FROM outbox WHERE id = ?', outboxId);
    if (!d || d.delivered) return;
    const now = this.sim.now();
    db.update('outbox', outboxId, { delivered: 1, status: 'sent' });
    if (d.reply_to) db.run('UPDATE inbox SET replied_at = COALESCE(replied_at, ?) WHERE id = ?', now, d.reply_to);
    if (d.round_id) {
      const field: Record<string, string> = { proposal: 'proposal_sent_at', portrait_offer: 'portrait_offered_at' };
      if (field[d.kind]) db.run(`UPDATE rounds SET ${field[d.kind]} = COALESCE(${field[d.kind]}, ?) WHERE id = ?`, now, d.round_id);
    }
    if (d.piece_id) {
      const field: Record<string, string> = { status_production: 'production_note_at', status_shipped: 'ship_note_at', late_notice: 'late_note_at' };
      if (field[d.kind]) db.run(`UPDATE pieces SET ${field[d.kind]} = COALESCE(${field[d.kind]}, ?) WHERE id = ?`, now, d.piece_id);
    }
    if (!d.member_id) return;
    await this.perceive(d);
    this.sim.logEvent('message_delivered', { id: d.id, kind: d.kind }, false, d.member_id);
    switch (d.kind) {
      case 'proposal':
        await this.scheduleAnswer(d.round_id);
        break;
      case 'late_notice':
        scoring.disappointment(this.sim, d.member_id, 'late_piece', `late notice for ${d.piece_id}`, d.round_id ?? this.sim.pieceRound(d.piece_id), 'desk', now);
        break;
      case 'portrait_offer': {
        const accept = this.rng(d.member_id).chance(this.sim.ctx.cfg.costs.portrait_usage_rate);
        const at = this.replyAt(d.member_id, now + this.rng(d.member_id).lognormal(this.sim.profile(d.member_id).reply_median_hours) * HOUR);
        this.sim.schedule(at, 'inbound', {
          memberId: d.member_id, intent: accept ? 'portrait_accept' : 'portrait_decline',
          body: await this.write(d.member_id, accept ? 'Accept the portrait session offer.' : 'Politely decline the portrait offer for now.', accept ? 'Yes, happy to sit for a portrait.' : 'Not this time, thank you.'),
        });
        break;
      }
      case 'dinner_invitation':
        db.run(
          `INSERT OR REPLACE INTO airtable_rows (tbl, id, data, updated_at, by_actor) VALUES ('rsvp', ?, ?, ?, 'world')`,
          `${d.member_id}:${dateOf(now)}`, JSON.stringify({ member_id: d.member_id, attend: this.rng(d.member_id).chance(this.sim.ctx.cfg.dinners.attend_rate) }), now,
        );
        break;
      default:
        break;
    }
  }

  /** How the member reads a message: a sales tone costs satisfaction; a privacy slip is a foul. */
  private async perceive(d: Row): Promise<void> {
    const meta = d.meta ? JSON.parse(d.meta) : {};
    const p = this.sim.profile(d.member_id);
    let selling = !!meta.selling;
    if (this.sim.ctx.mode === 'live' && !selling && ['proposal', 'portrait_offer', 'reply', 'dinner_invitation'].includes(d.kind)) {
      const v = await this.sim.llm.judge<{ sold_to: boolean }>(
        d.member_id, this.persona(d.member_id),
        `You received this from the house:\nSubject: ${d.subject}\n${d.body}\n\nDid it feel like you were being sold to? Reply with JSON: {"sold_to": true|false}`,
        { sold_to: false },
      );
      selling = !!v.sold_to;
    }
    if (selling) this.sim.satisfy(d.member_id, this.sim.ctx.cfg.satisfaction.selling_tone * p.selling_sensitivity, `felt sold to (${d.kind})`);
    if (d.guard_issues) {
      const issues = JSON.parse(d.guard_issues) as { kind: string; detail: string }[];
      const agent = d.by_agent as string;
      scoring.foul(this.sim, {
        memberId: d.member_id, kind: 'privacy_slip', cause: `${d.kind} message went out with: ${issues.map((i) => i.detail).join('; ')}`,
        agent: ['desk', 'table', 'door', 'counting_house', 'record', 'workroom'].includes(agent) ? agent : undefined, person: d.reviewed_by ?? d.sent_by,
      });
    }
  }

  async scheduleAnswer(roundId: string): Promise<void> {
    const r = this.sim.round(roundId);
    const id = r.member_id;
    const p = this.sim.profile(id);
    const rng = this.rng(id);
    const choice = rng.weighted(p.answer);
    const delayH = Math.min(21 * 24, Math.max(1, rng.lognormal(p.reply_median_hours)));
    const at = this.replyAt(id, this.sim.now() + delayH * HOUR);
    const piece = this.sim.pieceForRound(roundId);
    const fallback = { approve: 'Approved, thank you.', swap: 'Could we look at an alternative?', hold: 'Hold this one, please.' }[choice];
    const body = await this.write(id, `Answer the house's proposal of "${piece?.description}" with: ${choice}.`, fallback);
    this.sim.schedule(at, 'inbound', { memberId: id, roundId, intent: 'answer', answer: choice, body });
  }

  /** The stylist called and offered the pause. A silent member does not pick up. */
  offeredPause(memberId: string, roundId?: string): void {
    const m = this.sim.member(memberId);
    const silent = m.silent_from && m.silent_to && this.sim.now() >= m.silent_from && this.sim.now() < m.silent_to;
    this.sim.logEvent('pause_offered', { roundId, picked_up: !silent }, false, memberId);
    if (!silent && roundId) {
      const r = this.sim.round(roundId);
      if (!r.answer_received_at) {
        // He (or his assistant) answers on the call; the reply follows by email within a day.
        void this.scheduleAnswerSoon(roundId);
      }
    }
  }

  private async scheduleAnswerSoon(roundId: string): Promise<void> {
    const id = this.sim.round(roundId).member_id;
    const choice = this.rng(id).weighted(this.sim.profile(id).answer);
    this.sim.schedule(this.sim.now() + this.rng(id).int(2, 20) * HOUR, 'inbound', {
      memberId: id, roundId, intent: 'answer', answer: choice, body: await this.write(id, `Following the stylist's call, answer the proposal with: ${choice}.`, `Following our call: ${choice}.`),
    });
  }

  // ───────────────────────── inbound arriving at the house ─────────────────────────
  async inbound(p: { memberId: string; roundId?: string; intent: Intent; answer?: string; body: string; disappointment?: string }): Promise<void> {
    const db = this.sim.ctx.db;
    const m = this.sim.member(p.memberId);
    const prof = this.sim.profile(p.memberId);
    const from = prof.via_assistant ? m.assistant_email : m.email;
    const id = db.nextId('IN');
    const now = this.sim.now();
    db.insert('inbox', { id, received_at: now, from_addr: from, member_id: p.memberId, round_id: p.roundId, kind: p.intent === 'answer' ? 'answer' : 'message', intent: p.intent, body: p.body });
    this.sim.logEvent(`inbound_${p.intent}`, { id }, false, p.memberId);
    const shown = { from, received: iso(now), message_id: id, body: p.body };

    switch (p.intent) {
      case 'answer': {
        const r = this.sim.round(p.roundId!);
        if (r.answer_received_at || r.held_at) {
          db.update('inbox', id, { handled_at: now });
          return; // late reply after hold, or a duplicate
        }
        db.update('rounds', r.id, { answer: p.answer, answer_received_at: now });
        this.sim.task('record', 'record_answer', { memberId: p.memberId, roundId: r.id, data: { month: r.month, body: p.body }, hidden: { answer: p.answer } });
        break;
      }
      case 'portrait_accept':
        this.sim.task('desk', 'book_portrait', { memberId: p.memberId });
        db.update('inbox', id, { handled_at: now, replied_at: now });
        break;
      case 'portrait_decline':
      case 'ack':
      case 'rsvp':
        db.update('inbox', id, { handled_at: now, replied_at: now });
        break;
      case 'occasion':
        this.sim.task('record', 'occasion_note', { memberId: p.memberId, data: { body: p.body } });
        this.sim.task('desk', 'inbound', { memberId: p.memberId, data: shown, hidden: { intent: p.intent } });
        break;
      default:
        this.sim.task('desk', 'inbound', { memberId: p.memberId, data: shown, hidden: { intent: p.intent }, urgent: ['disappointment', 'chase', 'change_request'].includes(p.intent) });
        if (['question', 'taste_question', 'exception', 'commission', 'change_request'].includes(p.intent)) {
          this.sim.schedule(now + prof.patience_hours * HOUR, 'check', { kind: 'question_chase', inboxId: id, memberId: p.memberId });
        }
    }
  }

  /** A random logistics question during the month. */
  async randomQuestion(memberId: string): Promise<void> {
    const topics = ['Could the fitting be moved to a morning?', 'Is the lining the one we discussed?', 'Can the piece be delivered to my office instead?', 'What time will the courier come?'];
    const fallback = this.rng(memberId).pick(topics);
    const body = await this.write(memberId, `Ask the house a short practical question about logistics, like: "${fallback}"`, fallback);
    await this.inbound({ memberId, intent: 'question', body });
  }

  async mentionOccasion(memberId: string): Promise<void> {
    const occasions = ['a board dinner in Lagos next month', 'my daughter\'s graduation in June', 'a state function in Abuja', 'an investiture later this year'];
    const fallback = `For your notes: ${this.rng(memberId).pick(occasions)}.`;
    await this.inbound({ memberId, intent: 'occasion', body: await this.write(memberId, `Mention an upcoming occasion to the house in passing, like: "${fallback}"`, fallback) });
  }
}

export const DAY_IN_MS = DAY;
export const monthKey = monthOf;
