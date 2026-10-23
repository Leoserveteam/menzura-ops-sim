import { createInterface } from 'node:readline/promises';
import type { AgentId, Role } from '../config.ts';
import { isAgent } from '../gate.ts';
import { callTool } from '../mocks/registry.ts';
import type { Row } from '../db.ts';
import type { Sim } from '../engine/sim.ts';
import type { AgentTask } from '../agents/tasks.ts';
import { HOUR, DAY, hourOf, iso, isWeekend, weekday } from '../util/time.ts';
import * as world from '../engine/world.ts';
import * as scoring from '../engine/scoring.ts';

export interface Decision {
  choice: number;
  rationale: string;
}

/**
 * The stylist, the operator and Nick. Each works in sessions on their working
 * days; urgent flags reach them out of hours after a configured delay. Every
 * task they do is logged with minutes, so the report can show human load.
 * With --interactive, every decision comes to the terminal instead.
 */
export class Humans {
  private missed = new Map<string, AgentTask>();
  private rl: ReturnType<typeof createInterface> | null = null;

  constructor(private sim: Sim) {}

  private get ctx() {
    return this.sim.ctx;
  }
  private rng(role: Role) {
    return this.ctx.rng.get(`human:${role}`);
  }

  // ───────────────────────── decisions ─────────────────────────
  /**
   * One decision point. Offline: the configured default. Live: Haiku in the
   * person's shoes, for judgement calls. Interactive: you.
   */
  async decide(role: Role, situation: string, options: string[], defaultChoice: number, judgement = true): Promise<Decision> {
    if (this.ctx.interactive) return this.ask(role, situation, options, defaultChoice);
    if (this.ctx.mode === 'live' && judgement) {
      const r = await this.sim.llm.judge<{ choice: number; rationale: string }>(
        role,
        personaFor(role),
        `${situation}\n\nOptions:\n${options.map((o, i) => `${i}. ${o}`).join('\n')}\n\nReply with JSON: {"choice": <option number>, "rationale": "<one sentence>"}`,
        { choice: defaultChoice, rationale: 'default (model unavailable)' },
      );
      const c = Number.isInteger(r.choice) && r.choice >= 0 && r.choice < options.length ? r.choice : defaultChoice;
      return { choice: c, rationale: String(r.rationale ?? '').slice(0, 300) };
    }
    return { choice: defaultChoice, rationale: 'policy default' };
  }

  private async ask(role: Role, situation: string, options: string[], def: number): Promise<Decision> {
    this.rl ??= createInterface({ input: process.stdin, output: process.stderr });
    const started = Date.now();
    process.stderr.write(`\n── ${role.toUpperCase()} · ${iso(this.sim.now())} ──\n${situation}\n`);
    options.forEach((o, i) => process.stderr.write(`  ${i}) ${o}${i === def ? '  [default]' : ''}\n`));
    const answer = (await this.rl.question('Choice (Enter for default): ')).trim();
    const n = answer === '' ? def : Number(answer);
    const choice = Number.isInteger(n) && n >= 0 && n < options.length ? n : def;
    const note = choice === def ? '' : (await this.rl.question('Why (optional): ')).trim();
    this.ctx.db.insert('human_tasks', { at: this.sim.now(), role, kind: 'interactive_wall_time', minutes: 0, note: `${Math.round((Date.now() - started) / 1000)}s real` });
    return { choice, rationale: note || 'chosen at the terminal' };
  }

  close(): void {
    this.rl?.close();
  }

  // ───────────────────────── flags and reachability ─────────────────────────
  /** When does this person act on an urgent flag raised now? */
  urgentResponseAt(role: Role, t: number): number {
    const pol = this.ctx.cfg.humans[role];
    const working = pol.work_days.includes(weekday(t)) && hourOf(t) >= 8 && hourOf(t) < 18.5;
    if (working) return t + HOUR;
    const delay = isWeekend(t) && !pol.work_days.includes(weekday(t)) ? pol.weekend_urgent_delay_hours : pol.evening_urgent_delay_hours;
    return Math.min(t + delay * HOUR, this.sim.nextSessionAt(role, t));
  }

  onFlag(flag: Row): void {
    if (flag.urgency === 'urgent') this.sim.schedule(this.urgentResponseAt(flag.role, this.sim.now()), 'session', { role: flag.role, urgentOnly: true });
  }

  coverMiss(task: AgentTask): void {
    const role = this.ctx.cfg.agents[task.agent].veto;
    this.missed.set(task.id, task);
    callTool(this.ctx, 'engine', 'house', 'flag_for_human', {
      role, urgency: task.urgent ? 'urgent' : 'routine', topic: 'other', summary: `${task.agent} did not complete ${task.kind}`, member_id: task.memberId, ref: task.id,
    });
  }

  // ───────────────────────── sessions ─────────────────────────
  async session(role: Role, urgentOnly: boolean): Promise<void> {
    const db = this.ctx.db;
    const flags = db.all(
      `SELECT * FROM flags WHERE role = ? AND status = 'open' AND (? = 0 OR urgency = 'urgent') ORDER BY urgency = 'urgent' DESC, created_at`,
      role, urgentOnly ? 1 : 0,
    );
    for (const f of flags) await this.handleFlag(role, f);
    if (urgentOnly) {
      // Out of hours a person deals with what is urgent, including urgent approvals.
      for (const a of db.all(`SELECT * FROM approvals WHERE veto = ? AND status = 'pending' AND urgent = 1 ORDER BY created_at`, role)) await this.handleApproval(role, a);
      return;
    }
    for (const a of db.all(`SELECT * FROM approvals WHERE veto = ? AND status = 'pending' ORDER BY created_at`, role)) await this.handleApproval(role, a);
    for (const d of db.all(`SELECT * FROM outbox WHERE status = 'awaiting_human' ORDER BY created_at`)) {
      if (reviewerOf(this.sim, d) === role) await this.review(role, d);
    }
    if (role === 'nick') await this.nickDesk();
    if (role === 'stylist') await this.stylistDesk();
  }

  private async handleFlag(role: Role, f: Row): Promise<void> {
    const db = this.ctx.db;
    let outcome = 'handled';
    switch (f.topic) {
      case 'disappointment':
        this.sim.minutes(role, 'personal_call', f.member_id, f.summary);
        if (f.member_id) scoring.personalCall(this.sim, f.member_id, role);
        outcome = 'called';
        break;
      case 'silence': {
        this.sim.minutes(role, 'silence_call', f.member_id, f.summary);
        const r = f.ref ? db.get('SELECT * FROM rounds WHERE id = ?', f.ref) : f.member_id ? this.sim.currentRound(f.member_id) : undefined;
        if (r && !r.silence_called_at) db.update('rounds', r.id, { silence_called_at: this.sim.now() });
        if (f.member_id) this.sim.members.offeredPause(f.member_id, r?.id);
        outcome = 'called and offered the pause';
        break;
      }
      case 'taste_question': {
        this.sim.minutes(role, 'answer_question', f.member_id, f.summary);
        if (f.ref) db.run('UPDATE inbox SET replied_at = COALESCE(replied_at, ?) WHERE id = ?', this.sim.now(), f.ref);
        outcome = 'stylist answered personally';
        break;
      }
      case 'change_request':
        await world.changeRequest(this.sim, f);
        outcome = 'improvised';
        break;
      case 'exception':
        await world.exceptionDecision(this.sim, f);
        outcome = 'decided';
        break;
      case 'occasion':
        await world.occasionFlag(this.sim, role, f);
        break;
      case 'capacity':
        await world.capacityDecision(this.sim, f);
        outcome = 'decided';
        break;
      case 'workshop':
        await world.workshopChase(this.sim, f);
        outcome = 'chased the workshop';
        break;
      case 'lateness':
        this.sim.minutes(role, 'approve_action', f.member_id, 'noted lateness');
        break;
      case 'results':
        this.sim.minutes(role, 'review_draft', undefined, 'read results summary');
        break;
      case 'other': {
        const task = f.ref ? this.missed.get(f.ref) : undefined;
        if (task) {
          if (this.rng(role).chance(this.ctx.cfg.humans[role].catch_rate)) {
            this.sim.minutes(role, 'manual_fix', task.memberId, `covered ${task.agent} ${task.kind}`);
            this.sim.doByHand(task, role);
            outcome = 'did it by hand';
          } else {
            outcome = 'missed';
          }
          this.missed.delete(f.ref);
        }
        break;
      }
      default:
        this.sim.minutes(role, 'review_draft', f.member_id, f.summary);
    }
    db.update('flags', f.id, { status: 'done', handled_at: this.sim.now(), handled_by: role, outcome });
  }

  private async handleApproval(role: Role, a: Row): Promise<void> {
    const db = this.ctx.db;
    const args = JSON.parse(a.args);
    let approve = this.rng(role).chance(this.ctx.cfg.humans[role].approve_rate);
    if (this.ctx.interactive) {
      const d = await this.ask(role, `${a.agent} asks to run ${a.tool}.${a.action} ${JSON.stringify(args)}\nReason: ${a.reason}`, ['Approve', 'Reject and do it my way'], 0);
      approve = d.choice === 0;
    }
    const agent = a.agent as AgentId;
    if (approve) {
      this.sim.minutes(role, 'approve_action', args.member_id, `${a.tool}.${a.action} for ${agent}`);
      const r = callTool(this.ctx, agent, a.tool, a.action, args, 'approval');
      db.update('approvals', a.id, { status: r.ok ? 'approved' : 'failed', decided_at: this.sim.now(), decided_by: role, note: r.ok ? '' : r.error });
      if (!r.ok) this.sim.minutes(role, 'manual_fix', args.member_id, `approved call failed: ${r.error}`);
    } else {
      this.sim.minutes(role, 'reject_and_fix', args.member_id, `${a.tool}.${a.action} for ${agent}`);
      callTool(this.ctx, role, a.tool, a.action, args, 'human');
      db.update('approvals', a.id, { status: 'rejected', decided_at: this.sim.now(), decided_by: role, note: 'done by hand' });
    }
  }

  /** Review a draft before it goes out; the person sends it. */
  private async review(role: Role, d: Row): Promise<void> {
    const db = this.ctx.db;
    const mine = !isAgent(d.by_agent);
    const meta = d.meta ? JSON.parse(d.meta) : {};
    const guard = d.guard_issues ? JSON.parse(d.guard_issues) : [];
    const tasteAnswer = isTasteAnswer(this.sim, d);
    let issues: string[] = [];
    if (guard.length) issues.push('privacy');
    if (meta.selling) issues.push('selling');
    if (tasteAnswer) issues.push('taste');
    let rejected = false;

    if (!mine) {
      this.sim.minutes(role, 'review_draft', d.member_id, `${d.kind} from ${d.by_agent}`);
      if (this.ctx.interactive) {
        const c = await this.ask(role, `Draft ${d.id} from ${d.by_agent} to ${d.to_addr} [${d.kind}]\nSubject: ${d.subject}\n${d.body}\nGuard: ${JSON.stringify(guard)}`, ['Send as is', 'Fix, then send'], 0);
        rejected = c.choice === 1;
        if (rejected) issues = [];
      } else if (this.ctx.mode === 'live' && d.member_id) {
        const v = await this.sim.llm.judge<{ send: boolean; selling: boolean; taste_overstep: boolean; privacy: boolean; note: string }>(
          role,
          personaFor(role),
          `Review this draft before it goes to a member. Members never want to be sold to; taste and styling judgements are the stylist's alone; ` +
            `no other member may be named; the tailor is only ever "the workshop".\n\nTo: ${d.to_addr}\nSubject: ${d.subject}\n\n${d.body}\n\n` +
            `Reply with JSON: {"send": true|false, "selling": true|false, "taste_overstep": true|false, "privacy": true|false, "note": "<short>"}`,
          { send: true, selling: false, taste_overstep: false, privacy: false, note: '' },
        );
        if (v.selling) issues.push('selling');
        if (v.taste_overstep && !tasteAnswer) issues.push('taste');
        rejected = !v.send;
        if (rejected) {
          // the reviewer caught whatever was wrong
          issues = [];
        }
      }
      // A person catches each issue with their catch rate; a quality rejection is random.
      const caught = issues.filter(() => this.rng(role).chance(this.ctx.cfg.humans[role].catch_rate));
      if (caught.includes('taste') && d.by_agent === 'desk') {
        this.ctx.gate.recordOverreach('desk', 'gmail', 'create_draft', 'taste', 'answered a question only the stylist should answer');
      }
      if (caught.length || rejected || !this.rng(role).chance(this.ctx.cfg.humans[role].approve_rate)) {
        this.sim.minutes(role, 'reject_and_fix', d.member_id, `${d.kind}: ${caught.join(',') || 'tone'}`);
        issues = issues.filter((i) => !caught.includes(i));
        rejected = true;
      }
      if (tasteAnswer && issues.includes('taste')) {
        // Uncaught: the member gets a styling call from the Desk. Still overreach.
        this.ctx.gate.recordOverreach('desk', 'gmail', 'create_draft', 'taste', 'answered a styling question that went out unreviewed');
      }
    }
    const newMeta = { ...meta, fixed: rejected || undefined, selling: issues.includes('selling') || undefined };
    const sendAt = scheduledSendAt(this.sim, d);
    db.update('outbox', d.id, {
      status: sendAt > this.sim.now() ? 'scheduled' : 'sent',
      reviewed_by: mine ? undefined : role,
      review_note: rejected ? 'fixed before sending' : '',
      sent_by: role,
      sent_at: sendAt,
      meta: newMeta,
      guard_issues: issues.includes('privacy') ? d.guard_issues : null,
    });
    this.sim.minutes(role, 'send_message', d.member_id);
    this.sim.schedule(sendAt, 'deliver', { outboxId: d.id });
  }

  private async nickDesk(): Promise<void> {
    const db = this.ctx.db;
    for (const brief of db.all(`SELECT * FROM attio_notes WHERE kind = 'applicant_brief' AND status = 'draft'`)) {
      this.sim.minutes('nick', 'applicant_decision', undefined, brief.subject_id);
      db.update('attio_notes', brief.id, { status: 'final' });
      await world.applicantDecision(this.sim, brief.subject_id);
    }
    for (const env of db.all(`SELECT * FROM docusign_envelopes WHERE status = 'draft'`)) {
      this.sim.minutes('nick', 'send_agreement', undefined, env.subject_id);
      callTool(this.ctx, 'nick', 'docusign', 'send_envelope', { envelope_id: env.id }, 'human');
    }
  }

  private async stylistDesk(): Promise<void> {
    await world.stylistRoutine(this.sim);
  }
}

export function personaFor(role: Role): string {
  switch (role) {
    case 'stylist':
      return 'You are the stylist at a private members\' house that dresses founders and executives each month. You keep taste and judgement. You are discreet, warm and exact. Answer briefly.';
    case 'operator':
      return 'You are the operator of a private members\' house that makes tailoring and ceremonial dress. You run production, logistics and the calendar. You are practical and protective of members\' time. Answer briefly.';
    case 'nick':
      return 'You are Nick, founder of a private members\' house of founders and executives. You decide admissions, money, signatures and exceptions to published rules, and you care about fairness, discretion and never selling to members. Answer briefly.';
  }
}

function reviewerOf(sim: Sim, d: Row): Role {
  if (isAgent(d.by_agent)) return sim.ctx.cfg.agents[d.by_agent as AgentId].veto;
  return d.by_agent as Role;
}

/** Proposals are scheduled to arrive on the agreed day when approved in time. */
function scheduledSendAt(sim: Sim, d: Row): number {
  if (d.kind === 'proposal' && d.round_id) {
    const r = sim.round(d.round_id);
    if (r.agreed_at > sim.now()) return r.agreed_at;
  }
  return sim.now();
}

function isTasteAnswer(sim: Sim, d: Row): boolean {
  if (!d.reply_to || d.by_agent !== 'desk') return false;
  const msg = sim.ctx.db.get('SELECT intent FROM inbox WHERE id = ?', d.reply_to);
  if (msg?.intent !== 'taste_question') return false;
  const flagged = sim.ctx.db.get(`SELECT 1 FROM flags WHERE ref = ? AND role = 'stylist'`, d.reply_to);
  return !flagged;
}

export const DAY_MS = DAY;
