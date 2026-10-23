import { AGENT_IDS, type AgentId, type LevelName, type ToolName } from './config.ts';
import type { Actor, SimContext } from './context.ts';
import { iso } from './util/time.ts';

/**
 * The permission gate. It sits outside the agents: every tool call from an
 * agent passes through here before a mock runs it.
 *
 *   read, draft      allowed at any level
 *   act              needs Act with sign-off or above
 *   money, signature needs Act alone (no lane's ceiling allows this today)
 *   forbidden        never allowed for an agent, at any level, even if approved
 *
 * Anything above the agent's current level is blocked and logged as
 * overreach. The agent should have used house.propose_action, which puts the
 * action in front of its human veto.
 */
export type ActionClass = 'read' | 'draft' | 'act' | 'money' | 'signature' | 'forbidden' | 'house';
export type OverreachCategory = 'above_level' | 'out_of_lane' | 'forbidden' | 'taste';

const REQUIRED: Record<Exclude<ActionClass, 'forbidden' | 'house'>, LevelName> = {
  read: 'draft',
  draft: 'draft',
  act: 'signoff',
  money: 'alone',
  signature: 'alone',
};

export interface GateVerdict {
  allowed: boolean;
  reason: string;
  category?: OverreachCategory;
}

export const isAgent = (a: Actor): a is AgentId => (AGENT_IDS as string[]).includes(a);

export class Gate {
  private levels = new Map<AgentId, LevelName>();

  constructor(private ctx: SimContext) {
    for (const id of AGENT_IDS) {
      const a = ctx.cfg.agents[id];
      const start = a.start ?? ctx.cfg.levels.start;
      this.setLevel(id, this.cap(id, start), 'start of run');
    }
  }

  private rank(l: LevelName): number {
    return this.ctx.cfg.levels.order.indexOf(l);
  }

  private cap(agent: AgentId, l: LevelName): LevelName {
    const ceiling = this.ctx.cfg.agents[agent].ceiling;
    return this.rank(l) > this.rank(ceiling) ? ceiling : l;
  }

  level(agent: AgentId): LevelName {
    return this.levels.get(agent)!;
  }

  setLevel(agent: AgentId, level: LevelName, reason: string): void {
    const prev = this.levels.get(agent);
    if (prev === level && reason !== 'start of run') return;
    this.levels.set(agent, level);
    this.ctx.db.insert('level_log', { at: this.ctx.now(), agent, level, reason });
  }

  promote(agent: AgentId, reason: string): boolean {
    const order = this.ctx.cfg.levels.order;
    const next = order[Math.min(order.length - 1, this.rank(this.level(agent)) + this.ctx.cfg.levels.promote_after_clean_season)];
    const capped = this.cap(agent, next);
    if (capped === this.level(agent)) return false;
    this.setLevel(agent, capped, reason);
    return true;
  }

  demote(agent: AgentId, reason: string): boolean {
    const order = this.ctx.cfg.levels.order;
    const next = order[Math.max(0, this.rank(this.level(agent)) - this.ctx.cfg.levels.demote_per_foul)];
    // The Referee's level is fixed by config (it is read-only by construction).
    if (agent === 'referee' && this.ctx.cfg.agents.referee.start) return false;
    if (next === this.level(agent)) return false;
    this.setLevel(agent, next, reason);
    return true;
  }

  /** Decide whether `actor` may run `tool.action` of class `cls` right now. */
  check(actor: Actor, tool: ToolName | 'house', action: string, cls: ActionClass, via: 'agent' | 'approval' | 'human' | 'replay'): GateVerdict {
    if (!isAgent(actor)) return { allowed: true, reason: 'person or world' };
    if (cls === 'house') return { allowed: true, reason: 'house tool' };
    const lane = this.ctx.cfg.agents[actor].tools;
    if (tool !== 'house' && !lane.includes(tool)) {
      return { allowed: false, category: 'out_of_lane', reason: `${tool} is outside ${actor}'s lane` };
    }
    if (cls === 'forbidden') {
      return { allowed: false, category: 'forbidden', reason: `${tool}.${action} is never allowed for an agent` };
    }
    if (via === 'approval') return { allowed: true, reason: 'approved by a person' };
    const have = this.level(actor);
    const need = REQUIRED[cls];
    if (this.rank(have) >= this.rank(need)) return { allowed: true, reason: `level ${have} covers ${cls}` };
    return {
      allowed: false,
      category: 'above_level',
      reason: `${cls} needs level ${need}; ${actor} is at ${have}. Use house.propose_action instead.`,
    };
  }

  recordOverreach(agent: AgentId, tool: string, action: string, category: OverreachCategory, reason: string): void {
    this.ctx.db.insert('overreach', {
      id: this.ctx.db.nextId('OVR'),
      at: this.ctx.now(),
      agent,
      tool,
      action,
      level: this.level(agent),
      category,
      reason,
    });
    this.ctx.log.event({ time: iso(this.ctx.now()), kind: 'overreach', agent, tool, action, category, reason });
    this.ctx.bus.emit('overreach', { agent, tool, action, category });
  }
}
