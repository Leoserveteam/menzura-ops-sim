import type { RecordedCall } from '../mocks/mcp.ts';
import type { Sim } from '../engine/sim.ts';
import { TASKS, Standin, type AgentTask } from './tasks.ts';
import { iso } from '../util/time.ts';

export interface RunResult {
  calls: RecordedCall[];
  transcript: string;
  summary: string;
  usd: number;
  tokensIn: number;
}

export interface AgentRunner {
  run(task: AgentTask): Promise<RunResult>;
}

export function renderCalls(calls: RecordedCall[]): string {
  return calls
    .map((c) => `- ${c.tool}.${c.action} ${JSON.stringify(c.args).slice(0, 400)}\n  → ${c.result.ok ? JSON.stringify(c.result.result ?? {}).slice(0, 200) : `ERROR ${c.result.error}`}`)
    .join('\n');
}

/**
 * Offline stand-ins: scripted, deterministic, zero cost. They do each task the
 * canonical way, with seeded slips (overreach, missed urgency, a sales tone) so
 * the engine, the gate and the report have something to catch.
 */
export class OfflineRunner implements AgentRunner {
  constructor(private sim: Sim) {}

  async run(task: AgentTask): Promise<RunResult> {
    const s = new Standin(this.sim, task.agent, true);
    TASKS[task.kind].offline(this.sim, task, s);
    const summary = `${task.agent} ${task.kind}: ${s.calls.length} tool calls`;
    const transcript =
      `# ${task.id} · ${task.agent} · ${task.kind}\n\nSim time: ${iso(this.sim.now())}  ·  OFFLINE STAND-IN (scripted, not a model)\n\n` +
      `## Task\n${TASKS[task.kind].brief(this.sim, task)}\n\n## Tool calls\n${renderCalls(s.calls)}\n`;
    return { calls: s.calls, transcript, summary, usd: 0, tokensIn: 0 };
  }
}
