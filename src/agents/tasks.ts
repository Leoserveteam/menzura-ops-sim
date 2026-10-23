import type { AgentId, Role } from '../config.ts';
import type { Actor } from '../context.ts';
import { isAgent } from '../gate.ts';
import { callTool, findDef, type CallResult } from '../mocks/registry.ts';
import type { RecordedCall } from '../mocks/mcp.ts';
import type { Sim } from '../engine/sim.ts';
import { DAY, HOUR, atTime, dateOf, iso, startOfDay, monthOf } from '../util/time.ts';

/**
 * Every piece of routine work the house agents do. Each kind has:
 *  - brief:   the plain instruction a live agent receives
 *  - expects: tool actions that count as "done" (directly, or proposed to a person)
 *  - offline: the canonical way to do it, used by offline stand-ins and by a
 *             person who picks up work an agent missed
 */
export interface AgentTask {
  id: string;
  agent: AgentId;
  kind: TaskKind;
  memberId?: string;
  roundId?: string;
  pieceId?: string;
  data: Record<string, unknown>;    // shown to the agent
  hidden: Record<string, unknown>;  // ground truth for stand-ins and checks; never shown to a live agent
  urgent?: boolean;
  createdAt: number;
}

export type TaskKind =
  | 'proposal' | 'inbound' | 'status_production' | 'status_shipped' | 'late_notice' | 'book_fitting' | 'book_alteration'
  | 'portrait_offer' | 'book_portrait' | 'silence' | 'relay_decision'
  | 'record_answer' | 'record_line' | 'gesture_prompts' | 'file_portrait' | 'occasion_note'
  | 'place_order' | 'weekly_digest' | 'hold_piece' | 'capacity_check' | 'courier_delay'
  | 'plan_dinner' | 'occasion_guarantee'
  | 'applicant_brief' | 'draft_agreement'
  | 'new_member_billing' | 'month_close' | 'recovery_credit' | 'investor_update'
  | 'scoreboard';

type Expect = [tool: string, action: string];

/** Helpers a stand-in (or a person covering for an agent) uses to do the work. */
export class Standin {
  readonly calls: RecordedCall[] = [];
  constructor(private sim: Sim, readonly actor: Actor, private mistakes: boolean) {}

  /** A seeded slip, only for offline agent stand-ins (never for people). */
  slip(rate: number): boolean {
    return this.mistakes && this.sim.ctx.rng.get(`slip:${this.actor}`).chance(rate);
  }

  /** Do the action if the level allows; otherwise propose it to the veto (sometimes overreaching first). */
  act(tool: string, action: string, args: Record<string, unknown>, reason: string, urgent = false): CallResult {
    const ctx = this.sim.ctx;
    if (!isAgent(this.actor)) return this.call(tool, action, args, 'human');
    const def = findDef(tool, action);
    if (!def) throw new Error(`stand-in used unknown action ${tool}.${action}`);
    const cls = typeof def.cls === 'function' ? def.cls(args, ctx) : def.cls;
    if (ctx.gate.check(this.actor, def.tool, action, cls, 'agent').allowed) return this.call(tool, action, args);
    if (this.slip(ctx.cfg.offline.overreach_rate)) this.call(tool, action, args); // overreach: blocked and logged
    return this.call('house', 'propose_action', { tool, action, args, reason, urgent });
  }

  call(tool: string, action: string, args: Record<string, unknown>, via: 'agent' | 'human' = 'agent'): CallResult {
    const result = callTool(this.sim.ctx, this.actor, tool, action, args, via);
    this.calls.push({ tool, action, args, result });
    return result;
  }

  draft(args: Record<string, unknown>, meta?: Record<string, unknown>): CallResult {
    const r = this.call('gmail', 'create_draft', args);
    if (r.ok && meta) this.sim.ctx.db.update('outbox', (r.result as any).draft_id, { meta });
    return r;
  }

  flag(role: Role, urgency: 'routine' | 'urgent', topic: string, summary: string, memberId?: string, ref?: string): CallResult {
    return this.call('house', 'flag_for_human', { role, urgency, topic, summary, member_id: memberId, ref });
  }
}

export interface TaskDef {
  agent: AgentId;
  brief: (sim: Sim, t: AgentTask) => string;
  expects: Expect[];
  offline: (sim: Sim, t: AgentTask, s: Standin) => void;
}

const firstName = (sim: Sim, id: string) => sim.member(id).name.replace(/^SIM-/, '').split(' ').filter((w: string) => !/^Chief$/.test(w))[0];
const salutation = (sim: Sim, id: string) => {
  const m = sim.member(id);
  const p = sim.profile(id);
  return p.via_assistant ? `Dear ${firstName(sim, id)}'s office,` : `Dear ${firstName(sim, id)},`;
};
const pieceDesc = (sim: Sim, t: AgentTask) => (t.pieceId ? sim.piece(t.pieceId).description : 'this month\'s piece');

/** Occasional slips in offline drafts: a sales tone, or naming another member. */
function draftMeta(sim: Sim, s: Standin): Record<string, unknown> | undefined {
  if (s.slip(sim.ctx.cfg.offline.mistake_rate)) return { selling: true };
  return undefined;
}
function maybeNameAnother(sim: Sim, s: Standin, memberId: string): string {
  if (!s.slip(sim.ctx.cfg.offline.mistake_rate / 4)) return '';
  const other = sim.ctx.db.get(`SELECT name FROM members WHERE id != ? ORDER BY id LIMIT 1`, memberId);
  return other ? ` ${other.name.replace(/^SIM-/, '')} chose the same cloth last season.` : '';
}

export const TASKS: Record<TaskKind, TaskDef> = {
  // ─────────────────────────── The Desk ───────────────────────────
  proposal: {
    agent: 'desk',
    expects: [['gmail', 'create_draft']],
    brief: (sim, t) =>
      `Draft this month's proposal for ${t.memberId}. The stylist has chosen: "${pieceDesc(sim, t)}" for delivery on ${t.data.promised}. ` +
      `It must reach him on the agreed day, ${t.data.agreed_day}. Ask him to approve, swap or hold. ` +
      `Use gmail.create_draft with kind "proposal", round_id ${t.roundId}, piece_id ${t.pieceId}, addressed to ${t.data.to}.`,
    offline: (sim, t, s) => {
      s.draft({
        to: t.data.to, member_id: t.memberId, kind: 'proposal', round_id: t.roundId, piece_id: t.pieceId,
        subject: `Your ${monthOf(sim.round(t.roundId!).promised_at)} piece`,
        body: `${salutation(sim, t.memberId!)}\n\nFor ${t.data.promised} we propose ${pieceDesc(sim, t)}.${maybeNameAnother(sim, s, t.memberId!)} ` +
          `Approve, swap or hold, whichever suits.\n\nThe house`,
      }, draftMeta(sim, s));
    },
  },
  inbound: {
    agent: 'desk',
    expects: [['gmail', 'create_draft'], ['house', 'flag_for_human']],
    brief: (sim, t) =>
      `A message arrived from ${t.data.from} (${t.memberId}) at ${t.data.received}. Message id ${t.data.message_id}:\n"""${t.data.body}"""\n` +
      `Deal with it in your lane. Draft a reply if one is needed (reply_to ${t.data.message_id}). ` +
      `Anything that needs the stylist's taste or judgement, a disappointment, an exception to a published rule or a change ` +
      `to a finished piece goes to the right person with house.flag_for_human; disappointments are urgent. Do not decide those yourself.`,
    offline: (sim, t, s) => {
      const intent = t.hidden.intent as string;
      const m = t.memberId!;
      const to = t.data.from as string;
      const reply = (body: string) =>
        s.draft({ to, member_id: m, kind: 'reply', reply_to: t.data.message_id, subject: 'Re: your note', body: `${salutation(sim, m)}\n\n${body}\n\nThe house` }, draftMeta(sim, s));
      switch (intent) {
        case 'question':
          reply('Thank you. All in hand; we will confirm the details shortly.');
          break;
        case 'taste_question':
          if (s.slip(sim.ctx.cfg.offline.taste_answer_rate)) {
            reply('The agbada for the investiture, and the navy for the board dinner.'); // a taste call: the Desk's to avoid
          } else {
            s.flag('stylist', 'routine', 'taste_question', `Assistant asks a styling question for ${m}: ${String(t.data.body).slice(0, 160)}`, m, t.data.message_id as string);
            reply('Thank you. The stylist will come back to you personally on this.');
          }
          break;
        case 'disappointment':
        case 'chase':
          s.flag('stylist', s.slip(sim.ctx.cfg.offline.urgent_miss_rate) ? 'routine' : 'urgent', 'disappointment', `${m}: ${String(t.data.body).slice(0, 160)}`, m, t.data.message_id as string);
          reply('We are very sorry. The stylist will call you personally.');
          break;
        case 'change_request':
          s.flag('stylist', 'urgent', 'change_request', `${m} asks for a change to a finished piece before an event: ${String(t.data.body).slice(0, 160)}`, m, t.data.message_id as string);
          reply('Understood. The stylist will be in touch today.');
          break;
        case 'exception':
          s.flag('nick', 'routine', 'exception', `${m} asks for an exception to a published rule: ${String(t.data.body).slice(0, 160)}`, m, t.data.message_id as string);
          reply('Thank you for asking. We will come back to you shortly.');
          break;
        case 'commission':
          s.flag('stylist', 'routine', 'occasion', `${m} enquires about a family commission: ${String(t.data.body).slice(0, 160)}`, m, t.data.message_id as string);
          reply('What a wonderful occasion. The stylist will call you to talk it through.');
          break;
        case 'occasion':
          s.flag('stylist', 'routine', 'occasion', `${m} mentioned an occasion: ${String(t.data.body).slice(0, 160)}`, m, t.data.message_id as string);
          reply('Thank you for letting us know. We will keep it in mind.');
          break;
        default:
          reply('Thank you for your note.');
      }
    },
  },
  status_production: {
    agent: 'desk',
    expects: [['gmail', 'create_draft']],
    brief: (sim, t) =>
      `Piece ${t.pieceId} ("${pieceDesc(sim, t)}") for ${t.memberId} has entered production. Draft the short status note the house sends at this point ` +
      `(kind "status_production", piece_id ${t.pieceId}, round_id ${t.roundId}) to ${t.data.to}. Promised delivery: ${t.data.promised}.`,
    offline: (sim, t, s) => {
      s.draft({
        to: t.data.to, member_id: t.memberId, kind: 'status_production', piece_id: t.pieceId, round_id: t.roundId,
        subject: 'Under way', body: `${salutation(sim, t.memberId!)}\n\nYour ${pieceDesc(sim, t)} is now being made. Delivery as promised, ${t.data.promised}.\n\nThe house`,
      }, draftMeta(sim, s));
    },
  },
  status_shipped: {
    agent: 'desk',
    expects: [['gmail', 'create_draft']],
    brief: (sim, t) =>
      `Piece ${t.pieceId} for ${t.memberId} has shipped; expected arrival ${t.data.expected}. Draft the status note (kind "status_shipped", piece_id ${t.pieceId}, round_id ${t.roundId}) to ${t.data.to}.`,
    offline: (sim, t, s) => {
      s.draft({
        to: t.data.to, member_id: t.memberId, kind: 'status_shipped', piece_id: t.pieceId, round_id: t.roundId,
        subject: 'On its way', body: `${salutation(sim, t.memberId!)}\n\nYour piece is on its way and should be with you by ${t.data.expected}.\n\nThe house`,
      }, draftMeta(sim, s));
    },
  },
  late_notice: {
    agent: 'desk',
    expects: [['gmail', 'create_draft']],
    brief: (sim, t) =>
      `Piece ${t.pieceId} for ${t.memberId} will miss its promised day (${t.data.promised}); projected arrival ${t.data.projected}. ` +
      `Draft an honest, brief note before he has to ask (kind "late_notice", piece_id ${t.pieceId}, round_id ${t.roundId}) to ${t.data.to}. ` +
      `This is a disappointment: also raise it with the stylist (urgent) so the personal call happens within a day.`,
    offline: (sim, t, s) => {
      s.draft({
        to: t.data.to, member_id: t.memberId, kind: 'late_notice', piece_id: t.pieceId, round_id: t.roundId,
        subject: 'A short delay', body: `${salutation(sim, t.memberId!)}\n\nYour piece will reach you a few days late, by ${t.data.projected}. We are sorry; the stylist will call.\n\nThe house`,
      }, draftMeta(sim, s));
      s.flag('stylist', s.slip(sim.ctx.cfg.offline.urgent_miss_rate) ? 'routine' : 'urgent', 'disappointment', `${t.memberId}'s piece ${t.pieceId} will be late (${t.data.projected}).`, t.memberId, t.pieceId);
    },
  },
  book_fitting: {
    agent: 'desk',
    expects: [['calendar', 'book_event']],
    brief: (sim, t) =>
      `Piece ${t.pieceId} has been delivered to ${t.memberId}. Book his fitting with calendar.book_event (kind "fitting", member_id ${t.memberId}, piece_id ${t.pieceId}) ` +
      `within the next three days at a sensible hour. ${t.data.availability ?? ''}`,
    offline: (sim, t, s) => {
      const at = atTime(sim.now() + 2 * DAY, '11:00');
      s.act('calendar', 'book_event', { kind: 'fitting', member_id: t.memberId, piece_id: t.pieceId, starts_at: iso(at), title: `Fitting: ${t.memberId}` }, 'piece delivered');
    },
  },
  book_alteration: {
    agent: 'desk',
    expects: [['calendar', 'book_event']],
    brief: (sim, t) =>
      `The fitting of piece ${t.pieceId} for ${t.memberId} did not go right (attempt ${t.data.attempt}). Book the alteration fitting ` +
      `(calendar.book_event, kind "alteration", member_id ${t.memberId}, piece_id ${t.pieceId}) within the week.`,
    offline: (sim, t, s) => {
      const at = atTime(sim.now() + 5 * DAY, '11:00');
      s.act('calendar', 'book_event', { kind: 'alteration', member_id: t.memberId, piece_id: t.pieceId, starts_at: iso(at), title: `Alteration: ${t.memberId}` }, 'fit failed');
    },
  },
  portrait_offer: {
    agent: 'desk',
    expects: [['gmail', 'create_draft']],
    brief: (sim, t) =>
      `The fit for ${t.memberId}'s piece ${t.pieceId} is confirmed. Draft the offer of a portrait session (kind "portrait_offer", round_id ${t.roundId}, piece_id ${t.pieceId}) to ${t.data.to}. No pressure; he may decline.`,
    offline: (sim, t, s) => {
      s.draft({
        to: t.data.to, member_id: t.memberId, kind: 'portrait_offer', round_id: t.roundId, piece_id: t.pieceId,
        subject: 'A portrait, if you would like one', body: `${salutation(sim, t.memberId!)}\n\nShould you like a portrait in the new piece, we would be glad to arrange it at your convenience.\n\nThe house`,
      }, draftMeta(sim, s));
    },
  },
  book_portrait: {
    agent: 'desk',
    expects: [['calendar', 'book_event']],
    brief: (sim, t) => `${t.memberId} accepted a portrait session. Book it with calendar.book_event (kind "portrait_session", member_id ${t.memberId}) within two weeks.`,
    offline: (sim, t, s) => {
      s.act('calendar', 'book_event', { kind: 'portrait_session', member_id: t.memberId, starts_at: iso(atTime(sim.now() + 8 * DAY, '15:00')), title: `Portrait: ${t.memberId}` }, 'accepted');
    },
  },
  silence: {
    agent: 'desk',
    expects: [['house', 'flag_for_human']],
    brief: (sim, t) =>
      `${t.memberId} has not answered his proposal (round ${t.roundId}) for ${t.data.days} days. House rule: at ${sim.ctx.cfg.rules.silence_call_days} days the stylist calls him or his assistant and offers the pause ` +
      `(up to ${sim.ctx.cfg.rules.pause_max_months_per_year} months a year; he has used ${t.data.pause_used}). Raise it with the stylist so the call happens today.`,
    offline: (sim, t, s) => {
      s.flag('stylist', 'routine', 'silence', `${t.memberId} silent ${t.data.days} days on round ${t.roundId}; call and offer the pause.`, t.memberId, t.roundId);
    },
  },
  relay_decision: {
    agent: 'desk',
    expects: [['gmail', 'create_draft']],
    brief: (sim, t) => `Draft a short reply to ${t.memberId} (${t.data.to}) conveying this decision, warmly and without fuss: ${t.data.decision}`,
    offline: (sim, t, s) => {
      s.draft({ to: t.data.to, member_id: t.memberId, kind: 'reply', subject: 'Following up', body: `${salutation(sim, t.memberId!)}\n\n${t.data.decision}\n\nThe house` }, draftMeta(sim, s));
    },
  },
  // ─────────────────────────── The Record ───────────────────────────
  record_answer: {
    agent: 'record',
    expects: [['attio', 'set_attribute']],
    brief: (sim, t) =>
      `${t.memberId} answered his proposal for ${t.data.month}: """${t.data.body}""". Record his answer with attio.set_attribute ` +
      `(key "answer:${t.data.month}", value approve, swap or hold). If he mentions a preference or an occasion, add a note too.`,
    offline: (sim, t, s) => {
      s.act('attio', 'set_attribute', { member_id: t.memberId, key: `answer:${t.data.month}`, value: t.hidden.answer }, 'record answer');
    },
  },
  record_line: {
    agent: 'record',
    expects: [['attio', 'add_note']],
    brief: (sim, t) =>
      `Round ${t.roundId} for ${t.memberId} is nearly complete. Add one new line to his record about something learned this month ` +
      `(attio.add_note, kind "learned"). What happened: ${JSON.stringify(t.data.month_facts)}`,
    offline: (sim, t, s) => {
      const facts = t.data.month_facts as Record<string, unknown>;
      s.act('attio', 'add_note', { subject_id: t.memberId, kind: 'learned', text: `Prefers ${facts.answer === 'swap' ? 'to choose between two options' : 'a settled proposal'}; fit ${facts.fit}.` }, 'monthly line');
    },
  },
  gesture_prompts: {
    agent: 'record',
    expects: [['attio', 'add_note']],
    brief: (sim, t) =>
      `A new season (${t.data.season}) begins. From ${t.memberId}'s record, surface two or three prompts the stylist could draw on for this season's considered gesture ` +
      `(attio.add_note, kind "gesture_prompt"). The stylist chooses; you only surface.`,
    offline: (sim, t, s) => {
      s.act('attio', 'add_note', { subject_id: t.memberId, kind: 'gesture_prompt', text: 'Recent occasion noted; consider a handwritten card with a pocket square in his colours.' }, 'season');
    },
  },
  file_portrait: {
    agent: 'record',
    expects: [['drive', 'file_portrait']],
    brief: (sim, t) => `${t.memberId}'s portrait session took place. File the portrait in his private folder (drive.file_portrait). It must never be shared outside the house.`,
    offline: (sim, t, s) => {
      s.act('drive', 'file_portrait', { member_id: t.memberId, name: `portrait-${dateOf(sim.now())}.jpg` }, 'portrait');
    },
  },
  occasion_note: {
    agent: 'record',
    expects: [['attio', 'add_note']],
    brief: (sim, t) => `${t.memberId} mentioned an occasion: """${t.data.body}""". Note it in his record (attio.add_note, kind "occasion").`,
    offline: (sim, t, s) => {
      s.act('attio', 'add_note', { subject_id: t.memberId, kind: 'occasion', text: String(t.data.body).slice(0, 140) }, 'occasion');
    },
  },
  // ─────────────────────────── The Workroom ───────────────────────────
  place_order: {
    agent: 'workroom',
    expects: [['airtable', 'update_piece']],
    brief: (sim, t) =>
      `Piece ${t.pieceId} for ${t.memberId} is approved ("${pieceDesc(sim, t)}"). Place it with the workshop by setting its record to "ordered" (airtable.update_piece). ` +
      `Planned production start: ${t.data.planned_start}; booking cutoff: ${t.data.cutoff}.`,
    offline: (sim, t, s) => {
      s.act('airtable', 'update_piece', { piece_id: t.pieceId, house_status: 'ordered', note: 'placed with the workshop' }, 'approved piece', true);
    },
  },
  weekly_digest: {
    agent: 'workroom',
    expects: [['airtable', 'list_workshop_updates']],
    brief: (sim, t) =>
      `It is ${t.data.today}, the morning the workshop's weekly update is due. Read it (airtable.list_workshop_updates). ` +
      `Mark pieces that have entered production ("in_production"). Flag any piece projected to miss its promised day (airtable.flag_late) and raise it with the operator. ` +
      `If this week's update has not arrived, say so to the operator. Open pieces: ${JSON.stringify(t.data.open_pieces)}`,
    offline: (sim, t, s) => {
      s.call('airtable', 'list_workshop_updates', { limit: 1 });
      const update = t.hidden.update as any;
      if (!update) {
        if (!s.slip(sim.ctx.cfg.offline.mistake_rate * 3)) {
          s.flag('operator', 'routine', 'workshop', `The workshop's update for ${t.data.today} has not arrived.`);
          s.call('house', 'note_rule_gap', { situation: 'The workshop missed its weekly update', what_i_did: 'Told the operator; no rule says who chases the workshop or by when.' });
        }
        return;
      }
      for (const p of update.started as any[]) {
        s.act('airtable', 'update_piece', { piece_id: p.piece_id, house_status: 'in_production', note: `started ${p.started}` }, 'workshop update');
      }
      for (const p of update.projected as any[]) {
        if (p.late && !sim.piece(p.piece_id).late_flagged_at && !s.slip(sim.ctx.cfg.offline.mistake_rate)) {
          s.act('airtable', 'flag_late', { piece_id: p.piece_id, projected_arrival: p.projected_arrival, note: 'workshop projects late' }, 'late');
          s.flag('operator', 'routine', 'lateness', `Piece ${p.piece_id} projected ${p.projected_arrival}, promised ${p.promised}.`, p.member_id, p.piece_id);
        }
      }
    },
  },
  hold_piece: {
    agent: 'workroom',
    expects: [['airtable', 'update_piece']],
    brief: (sim, t) => `${t.memberId} has not answered for ${t.data.days} days. House rule: the piece goes on hold. Set piece ${t.pieceId} to "hold" (airtable.update_piece).`,
    offline: (sim, t, s) => {
      s.act('airtable', 'update_piece', { piece_id: t.pieceId, house_status: 'hold', note: 'silence rule' }, 'silence', true);
    },
  },
  capacity_check: {
    agent: 'workroom',
    expects: [['airtable', 'capacity_forecast']],
    brief: (sim, t) =>
      `Monthly capacity check. Read the forecast (airtable.capacity_forecast). The workshop allocation is ${sim.ctx.cfg.capacity.monthly_garment_allocation} garments a month; ` +
      `the house must warn the operator ${sim.ctx.cfg.capacity.warn_days_ahead} days before any month reaches it (airtable.log_capacity_warning and an operator flag).`,
    offline: (sim, t, s) => {
      const f = s.call('airtable', 'capacity_forecast', {});
      const alloc = sim.ctx.cfg.capacity.monthly_garment_allocation;
      for (const m of (f.result as any[]) ?? []) {
        const daysAhead = (Date.parse(`${m.month}-01T00:00:00Z`) - sim.now()) / DAY;
        if (m.garments >= alloc && daysAhead <= sim.ctx.cfg.capacity.warn_days_ahead + 31 && !s.slip(sim.ctx.cfg.offline.mistake_rate)) {
          s.act('airtable', 'log_capacity_warning', { month: m.month, garments: m.garments, note: 'allocation will be reached' }, 'capacity');
          s.flag('operator', 'routine', 'capacity', `${m.month}: ${m.garments} garments planned against ${alloc}.`);
        }
      }
    },
  },
  courier_delay: {
    agent: 'workroom',
    expects: [['airtable', 'flag_late']],
    brief: (sim, t) => `The courier reports a delay on piece ${t.pieceId} for ${t.memberId}: new arrival ${t.data.projected}, promised ${t.data.promised}. Flag it (airtable.flag_late) and raise it with the operator if it misses the promise.`,
    offline: (sim, t, s) => {
      if (t.data.late) {
        s.act('airtable', 'flag_late', { piece_id: t.pieceId, projected_arrival: t.data.projected, note: 'courier delay' }, 'courier');
        s.flag('operator', 'routine', 'lateness', `Courier delay: ${t.pieceId} now ${t.data.projected}.`, t.memberId, t.pieceId);
      }
    },
  },
  // ─────────────────────────── The Table ───────────────────────────
  plan_dinner: {
    agent: 'table',
    expects: [['calendar', 'book_event']],
    brief: (sim, t) =>
      `Plan the ${t.data.dinner} on ${t.data.date}. Book it (calendar.book_event, kind "dinner") and draft one invitation per member, each addressed only to that member ` +
      `(kind "dinner_invitation"). Published rule: each member may bring ${sim.ctx.cfg.rules.dinner_guest_allowance} guest. Members: ${JSON.stringify(t.data.members)}`,
    offline: (sim, t, s) => {
      s.act('calendar', 'book_event', { kind: 'dinner', starts_at: `${t.data.date}T19:30`, title: String(t.data.dinner) }, 'dinner');
      for (const m of t.data.members as { id: string; to: string }[]) {
        s.draft({ to: m.to, member_id: m.id, kind: 'dinner_invitation', subject: 'An evening at the house', body: `${salutation(sim, m.id)}\n\nWe would be delighted to see you on ${t.data.date}, with a guest if you wish.\n\nThe house` });
      }
    },
  },
  occasion_guarantee: {
    agent: 'table',
    expects: [['calendar', 'book_event']],
    brief: (sim, t) =>
      `Occasion guarantee. ${t.memberId}'s piece ${t.pieceId} is projected to arrive ${t.data.projected}, but his ${t.data.occasion} is on ${t.data.occasion_at}. ` +
      `Run the guarantee timeline: book the express courier and workshop priority (calendar.book_event, kind "courier", piece_id ${t.pieceId}) so the piece arrives with time for a fitting, ` +
      `and tell the operator what it costs (express about $${sim.ctx.cfg.costs.occasion_guarantee_express_usd}).`,
    offline: (sim, t, s) => {
      s.act('calendar', 'book_event', { kind: 'courier', member_id: t.memberId, piece_id: t.pieceId, starts_at: iso(sim.now() + 2 * HOUR), title: `Express + priority: ${t.pieceId}` }, 'occasion guarantee', true);
      s.flag('operator', 'urgent', 'occasion', `Occasion guarantee for ${t.memberId}: express booked for ${t.pieceId}, about $${sim.ctx.cfg.costs.occasion_guarantee_express_usd}.`, t.memberId, t.pieceId);
    },
  },
  // ─────────────────────────── The Door ───────────────────────────
  applicant_brief: {
    agent: 'door',
    expects: [['attio', 'draft_note']],
    brief: (sim, t) =>
      `A new application arrived (${t.data.applicant_id}). Read it (attio.get_applicant) and write a one-page brief for Nick (attio.draft_note, kind "applicant_brief"): ` +
      `who he is, what he would want from the house, anything that bears on discretion. No recommendation to admit; Nick decides.`,
    offline: (sim, t, s) => {
      const a = s.call('attio', 'get_applicant', { applicant_id: t.data.applicant_id }).result as any;
      s.call('attio', 'draft_note', {
        subject_id: t.data.applicant_id, kind: 'applicant_brief',
        text: `${a?.name}: ${a?.summary}. ${a?.following ? 'Large public following: discretion terms need care.' : ''}`,
      });
    },
  },
  draft_agreement: {
    agent: 'door',
    expects: [['docusign', 'create_envelope_draft']],
    brief: (sim, t) =>
      `Nick admitted ${t.data.applicant_id}. Prepare the membership agreement as a draft envelope (docusign.create_envelope_draft, template "membership_agreement"). ` +
      `${t.data.promotional ? 'Terms include a promotional piece: also prepare template "promotional_agreement".' : ''} Nick sends it.`,
    offline: (sim, t, s) => {
      s.call('docusign', 'create_envelope_draft', { subject_id: t.data.applicant_id, template: 'membership_agreement' });
      if (t.data.promotional) s.call('docusign', 'create_envelope_draft', { subject_id: t.data.applicant_id, template: 'promotional_agreement' });
    },
  },
  // ─────────────────────── The Counting House ───────────────────────
  new_member_billing: {
    agent: 'counting_house',
    expects: [['stripe', 'create_invoice']],
    brief: (sim, t) => `${t.memberId} has joined as a ${t.data.tier}. Raise his annual fee of $${t.data.fee} (stripe.create_invoice, kind "annual_fee"). Money needs Nick's sign-off at your level.`,
    offline: (sim, t, s) => {
      s.act('stripe', 'create_invoice', { member_id: t.memberId, amount_usd: t.data.fee, kind: 'annual_fee' }, 'new member');
    },
  },
  month_close: {
    agent: 'counting_house',
    expects: [['xero', 'monthly_results']],
    brief: (sim, t) =>
      `Close ${t.data.month}. Read the results against the model (xero.monthly_results), post the month's revenue journal (xero.post_journal), ` +
      `and give Nick a three-line summary (house.flag_for_human, topic "results").`,
    offline: (sim, t, s) => {
      const r = s.call('xero', 'monthly_results', { month: t.data.month }).result as any;
      s.act('xero', 'post_journal', { month: t.data.month, account: 'membership_revenue', amount_usd: r?.revenue_usd ?? 0, memo: 'monthly recognition' }, 'month close');
      s.flag('nick', 'routine', 'results', `${t.data.month}: contribution $${r?.contribution_usd} vs model $${r?.model_contribution_usd}.`);
    },
  },
  recovery_credit: {
    agent: 'counting_house',
    expects: [['stripe', 'issue_credit']],
    brief: (sim, t) => `Recovery policy: credit ${t.memberId} one free month ($${t.data.amount}) after ${t.data.failure} (stripe.issue_credit). Money needs Nick's sign-off at your level.`,
    offline: (sim, t, s) => {
      s.act('stripe', 'issue_credit', { member_id: t.memberId, amount_usd: t.data.amount, reason: String(t.data.failure) }, 'recovery');
    },
  },
  investor_update: {
    agent: 'counting_house',
    expects: [['carta', 'get_cap_table']],
    brief: (sim, t) => `Quarterly investor pipeline review. Read the cap table (carta.get_cap_table), note pipeline status (attio.add_note, kind "investor", subject "pipeline"), and summarise for Nick.`,
    offline: (sim, t, s) => {
      s.call('carta', 'get_cap_table', {});
      s.act('attio', 'add_note', { subject_id: 'pipeline', kind: 'investor', text: `Quarter review ${t.data.quarter}: pipeline unchanged.` }, 'investor');
      s.flag('nick', 'routine', 'results', `Investor pipeline ${t.data.quarter}: no change.`);
    },
  },
  // ─────────────────────────── The Referee ───────────────────────────
  scoreboard: {
    agent: 'referee',
    expects: [['airtable', 'publish_scoreboard']],
    brief: (sim, t) =>
      `Publish the weekly scoreboard for week ${t.data.week} (airtable.publish_scoreboard). The engine has computed the scores; you add one or two lines of plain commentary. ` +
      `Scores: ${JSON.stringify(t.data.scores)}`,
    offline: (sim, t, s) => {
      s.call('airtable', 'publish_scoreboard', { week: t.data.week, commentary: `House score to date ${(t.data.scores as any).house_score_to_date}.` });
    },
  },
};

/** Did the agent do the task (directly, or by proposing it to a person)? */
export function taskDone(def: TaskDef, calls: RecordedCall[]): boolean {
  return def.expects.some(([tool, action]) =>
    calls.some(
      (c) =>
        (c.tool === tool && c.action === action && c.result.ok) ||
        (c.tool === 'house' && c.action === 'propose_action' && c.result.ok && c.args.tool === tool && c.args.action === action),
    ),
  );
}

export const startOfToday = (sim: Sim) => startOfDay(sim.now());
