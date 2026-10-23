import { EventEmitter } from 'node:events';
import type { AgentId, HouseConfig, Policies, Profile, Role } from '../config.ts';
import { AGENT_IDS, ROLES } from '../config.ts';
import type { SimContext } from '../context.ts';
import { Db, type Row } from '../db.ts';
import { Gate } from '../gate.ts';
import { ContentGuard } from '../guard/content.ts';
import { RunLog } from '../log.ts';
import { RngStreams } from '../util/rng.ts';
import { DAY, HOUR, atTime, dateOf, iso, parseTime, startOfDay, weekday } from '../util/time.ts';
import { Budget, BudgetExceededError } from './budget.ts';
import { EventQueue, type SimEvent } from './queue.ts';
import { TASKS, taskDone, Standin, type AgentTask, type TaskKind } from '../agents/tasks.ts';
import type { AgentRunner } from '../agents/runner.ts';
import { Humans } from '../people/humans.ts';
import { Members } from '../people/members.ts';
import type { PeopleLlm } from '../people/llm.ts';
import * as world from './world.ts';
import * as scoring from './scoring.ts';
import * as scripted from './scripted.ts';
import { wireReactions } from './react.ts';

export interface SimOptions {
  cfg: HouseConfig;
  runDir: string;
  seed: number;
  policies: Policies;
  budgetUsd: number;
  mode: 'offline' | 'live';
  interactive: boolean;
  start?: string;     // override prologue start
  end?: string;       // override end
  runnerFactory: (sim: Sim) => AgentRunner;
  llmFactory: (sim: Sim) => PeopleLlm;
  quiet?: boolean;
}

export interface RunOutcome {
  completed: boolean;
  stoppedReason?: string;
  endedAt: number;
}

export class Sim {
  readonly ctx: SimContext;
  readonly queue = new EventQueue();
  readonly runner: AgentRunner;
  readonly humans: Humans;
  readonly members: Members;
  readonly llm: PeopleLlm;
  readonly startT: number;
  readonly endT: number;
  readonly scoredStartT: number;
  /** Ten days after the year ends, so December rounds can finish and close. */
  readonly horizonT: number;
  private t: number;
  private taskSeq = 0;
  readonly opts: SimOptions;

  constructor(opts: SimOptions) {
    this.opts = opts;
    const { cfg } = opts;
    this.startT = parseTime(opts.start ?? cfg.sim.prologue_start);
    this.endT = parseTime(opts.end ?? cfg.sim.end) + DAY - 1;
    this.scoredStartT = parseTime(cfg.sim.scored_start);
    this.horizonT = this.endT + 10 * DAY;
    this.t = this.startT;
    const db = new Db(`${opts.runDir}/sim.db`);
    const log = new RunLog(opts.runDir);
    const ctx = {
      cfg,
      db,
      log,
      rng: new RngStreams(opts.seed),
      content: new ContentGuard(cfg.privacy.denylist_file, cfg.privacy.member_domain),
      policies: opts.policies,
      bus: new EventEmitter(),
      mode: opts.mode,
      interactive: opts.interactive,
      now: () => this.t,
    } as unknown as SimContext;
    ctx.budget = new Budget(opts.budgetUsd, db, ctx.now);
    ctx.gate = new Gate(ctx);
    this.ctx = ctx;
    this.llm = opts.llmFactory(this);
    this.runner = opts.runnerFactory(this);
    this.humans = new Humans(this);
    this.members = new Members(this);
    wireReactions(this);
  }

  now(): number {
    return this.t;
  }

  // ───────────────────────── lookups ─────────────────────────
  member(id: string): Row {
    const m = this.ctx.db.get('SELECT * FROM members WHERE id = ?', id);
    if (!m) throw new Error(`no member ${id}`);
    return m;
  }
  profile(id: string): Profile {
    return this.ctx.cfg.members.profiles[this.member(id).profile];
  }
  round(id: string): Row {
    const r = this.ctx.db.get('SELECT * FROM rounds WHERE id = ?', id);
    if (!r) throw new Error(`no round ${id}`);
    return r;
  }
  piece(id: string): Row {
    const p = this.ctx.db.get('SELECT * FROM pieces WHERE id = ?', id);
    if (!p) throw new Error(`no piece ${id}`);
    return p;
  }
  pieceRound(pieceId: string | null): string | undefined {
    return pieceId ? this.piece(pieceId).round_id ?? undefined : undefined;
  }
  pieceForRound(roundId: string): Row | undefined {
    return this.ctx.db.get(`SELECT * FROM pieces WHERE round_id = ? AND kind = 'monthly'`, roundId);
  }
  activeMembers(): Row[] {
    return this.ctx.db.all(`SELECT * FROM members WHERE status IN ('active', 'paused') ORDER BY id`);
  }
  /** Where the house writes to: the assistant for members who speak only through him. */
  addressOf(memberId: string): string {
    const m = this.member(memberId);
    return this.profile(memberId).via_assistant ? m.assistant_email : m.email;
  }
  /** The round whose month is current for a member (for attributing fouls). */
  currentRound(memberId: string): Row | undefined {
    const month = iso(this.t).slice(0, 7);
    return (
      this.ctx.db.get(`SELECT * FROM rounds WHERE member_id = ? AND month = ?`, memberId, month) ??
      this.ctx.db.get(`SELECT * FROM rounds WHERE member_id = ? AND closed = 0 ORDER BY month LIMIT 1`, memberId)
    );
  }

  // ───────────────────────── scheduling ─────────────────────────
  schedule(at: number, type: string, payload: any = {}): void {
    if (at > this.horizonT) return;
    this.queue.push(Math.max(at, this.t), type, payload);
  }

  task(agent: AgentId, kind: TaskKind, o: { memberId?: string; roundId?: string; pieceId?: string; data?: Record<string, unknown>; hidden?: Record<string, unknown>; at?: number; urgent?: boolean } = {}): void {
    const task: AgentTask = {
      id: `T${String(++this.taskSeq).padStart(5, '0')}`,
      agent,
      kind,
      memberId: o.memberId,
      roundId: o.roundId,
      pieceId: o.pieceId,
      data: o.data ?? {},
      hidden: o.hidden ?? {},
      urgent: o.urgent,
      createdAt: this.t,
    };
    if (TASKS[kind].agent !== agent) throw new Error(`task ${kind} belongs to ${TASKS[kind].agent}, not ${agent}`);
    this.schedule(o.at ?? this.t, 'agent', { task });
  }

  private async runTask(task: AgentTask): Promise<void> {
    const def = TASKS[task.kind];
    const res = await this.runner.run(task);
    const done = taskDone(def, res.calls);
    const interest = scoring.transcriptInterest(this, task, res.calls, done);
    const path = this.ctx.log.transcript(`${task.id}-${task.agent}-${task.kind}`, res.transcript);
    this.ctx.db.insert('transcripts', {
      id: task.id, at: this.t, agent: task.agent, task_kind: task.kind, member_id: task.memberId, path,
      usd: res.usd, tokens_in: res.tokensIn, interest, summary: res.summary.slice(0, 300),
    });
    if (!done) {
      this.ctx.db.insert('agent_misses', { at: this.t, agent: task.agent, task_kind: task.kind, member_id: task.memberId, detail: res.summary.slice(0, 200) });
      this.humans.coverMiss(task);
    }
  }

  /** A person (or a stand-in) does an agent's task by hand. */
  doByHand(task: AgentTask, role: Role): void {
    const s = new Standin(this, role, false);
    TASKS[task.kind].offline(this, task, s);
  }

  // ───────────────────────── bookkeeping ─────────────────────────
  logEvent(kind: string, detail: unknown = {}, isScripted = false, memberId?: string): void {
    this.ctx.db.insert('event_log', { at: this.t, kind, scripted: isScripted ? 1 : 0, member_id: memberId, detail });
    this.ctx.log.event({ time: iso(this.t), kind, scripted: isScripted, member: memberId, detail });
  }

  minutes(role: Role, kind: string, memberId?: string, note?: string, override?: number): void {
    const m = override ?? this.ctx.cfg.humans.minutes[kind] ?? 5;
    this.ctx.db.insert('human_tasks', { at: this.t, role, kind, minutes: m, member_id: memberId, note });
  }

  satisfy(memberId: string, delta: number, reason: string): void {
    const m = this.member(memberId);
    const value = Math.max(0, Math.min(100, m.satisfaction + delta));
    this.ctx.db.update('members', memberId, { satisfaction: value });
    this.ctx.db.insert('satisfaction_log', { at: this.t, member_id: memberId, delta, reason, value });
  }

  cost(kind: string, usd: number, memberId?: string, policy?: string, note?: string): void {
    this.ctx.db.insert('costs', { at: this.t, member_id: memberId, kind, usd, policy, note });
  }

  ruleGap(situation: string, raisedBy: string, improvisedBy: string, decision: string, memberId?: string): void {
    this.ctx.db.insert('rule_gaps', { id: this.ctx.db.nextId('GAP'), at: this.t, situation, raised_by: raisedBy, improvised_by: improvisedBy, decision, member_id: memberId });
  }

  isCovered(situation: string): boolean {
    return this.ctx.cfg.rules.covered_situations.includes(situation);
  }

  // ───────────────────────── the run ─────────────────────────
  async run(): Promise<RunOutcome> {
    world.setup(this);
    scripted.schedule(this);
    for (let d = startOfDay(this.startT); d <= this.horizonT; d += DAY) this.queue.push(d + 5 * 60_000, 'day', {});
    let lastMonth = '';
    try {
      for (;;) {
        const ev = this.queue.pop();
        if (!ev || ev.at > this.horizonT) break;
        this.t = ev.at;
        const month = iso(this.t).slice(0, 7);
        if (month !== lastMonth && !this.opts.quiet) {
          lastMonth = month;
          const spent = this.ctx.budget.spent;
          process.stderr.write(`  ${month}  members ${this.activeMembers().length}  spend $${spent.toFixed(2)}\n`);
        }
        await this.dispatch(ev);
      }
      scoring.finish(this);
      return { completed: true, endedAt: this.t };
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        this.logEvent('budget_stop', { spent: e.spent, cap: e.cap });
        scoring.finish(this);
        return { completed: false, stoppedReason: e.message, endedAt: this.t };
      }
      throw e;
    }
  }

  private async dispatch(ev: SimEvent): Promise<void> {
    const p = ev.payload;
    switch (ev.type) {
      case 'day':
        return world.dayTick(this);
      case 'agent':
        return this.runTask(p.task);
      case 'session':
        return this.humans.session(p.role, p.urgentOnly ?? false);
      case 'deliver':
        return this.members.deliver(p.outboxId);
      case 'inbound':
        return this.members.inbound(p);
      case 'workshop_start':
        return world.workshopStart(this, p.pieceId);
      case 'workshop_ship':
        return world.workshopShip(this, p.pieceId);
      case 'arrive':
        return world.arrive(this, p.pieceId);
      case 'fitting':
        return world.fitting(this, p.eventId);
      case 'portrait_session':
        return world.portraitSession(this, p.memberId);
      case 'check':
        return scoring.check(this, p);
      case 'scripted':
        return scripted.fire(this, p.id);
      case 'applicant':
        return world.applicantArrives(this, p);
      case 'sign':
        return world.applicantSigns(this, p.envelopeId);
      case 'dinner':
        return world.dinner(this, p.id);
      case 'gesture':
        return scoring.deliverGesture(this, p.gestureId);
      case 'close_round':
        return scoring.closeRound(this, p.roundId);
      case 'season_end':
        return scoring.seasonEnd(this, p.season);
      case 'publication':
        return scripted.publication(this, p);
      default:
        throw new Error(`unknown event ${ev.type}`);
    }
  }

  /** Schedule the next working session for a role at or after `t`. */
  nextSessionAt(role: Role, after: number): number {
    const pol = this.ctx.cfg.humans[role];
    for (let d = startOfDay(after); d < after + 10 * DAY; d += DAY) {
      if (!pol.work_days.includes(weekday(d))) continue;
      for (const s of pol.sessions) {
        const at = atTime(d, s);
        if (at >= after) return at;
      }
    }
    return after + DAY;
  }

  static agents(): AgentId[] {
    return AGENT_IDS;
  }
  static roles(): Role[] {
    return ROLES;
  }
}

export { HOUR, DAY, dateOf };
