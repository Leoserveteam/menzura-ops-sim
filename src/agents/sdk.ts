import { query } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sim } from '../engine/sim.ts';
import { agentSubprocessEnv } from '../guard/env.ts';
import { callTool } from '../mocks/registry.ts';
import { laneServers, laneToolNames, type RecordedCall } from '../mocks/mcp.ts';
import { iso } from '../util/time.ts';
import { renderCalls, type AgentRunner, type RunResult } from './runner.ts';
import { estimateTokens, systemPrompt, taskPrompt } from './prompts.ts';
import type { AgentTask } from './tasks.ts';

interface CachedRun {
  calls: { tool: string; action: string; args: Record<string, unknown> }[];
  text: string;
  usd: number;
}

/**
 * Live house agents: Claude Sonnet through the Claude Agent SDK. Each call gets
 * only its lane's in-process MCP tools (no built-in tools at all), a stable
 * system prompt, and a task prompt holding one member's record and the open
 * items. Identical calls are replayed from a disk cache through the gate.
 */
export class SdkRunner implements AgentRunner {
  private dir: string;
  private systems = new Map<string, string>();

  constructor(private sim: Sim, cacheDir: string) {
    this.dir = join(cacheDir, 'agents');
    mkdirSync(this.dir, { recursive: true });
  }

  async run(task: AgentTask): Promise<RunResult> {
    const { cfg, budget } = this.sim.ctx;
    const model = cfg.models.house;
    const system = this.systems.get(task.agent) ?? systemPrompt(this.sim, task.agent);
    this.systems.set(task.agent, system);
    const cap = cfg.limits.agent_call_max_tokens;
    const prompt = taskPrompt(this.sim, task, cap);
    const tokensIn = estimateTokens(system) + estimateTokens(prompt) + 2500; // + tool schemas
    if (tokensIn > cap) this.sim.logEvent('context_over_cap', { task: task.id, tokensIn });
    const key = createHash('sha256').update(JSON.stringify([model, system, prompt])).digest('hex');
    const file = join(this.dir, `${key}.json`);
    const header = `# ${task.id} · ${task.agent} · ${task.kind}\n\nSim time: ${iso(this.sim.now())} · model ${model} · ~${tokensIn} input tokens\n\n## Prompt\n${prompt}\n`;

    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as CachedRun;
      const calls: RecordedCall[] = cached.calls.map((c) => ({ ...c, result: callTool(this.sim.ctx, task.agent, c.tool, c.action, c.args, 'replay') }));
      budget.record(model, 0, `agent:${task.agent}`, {}, true);
      return { calls, transcript: `${header}\n## Replayed from cache\n${cached.text}\n\n## Tool calls\n${renderCalls(calls)}\n`, summary: cached.text.slice(0, 300), usd: 0, tokensIn };
    }

    budget.ensure(0.01);
    const calls: RecordedCall[] = [];
    const texts: string[] = [];
    let usd = 0;
    let usage = { input: 0, output: 0, cacheRead: 0 };
    let error = '';
    try {
      const q = query({
        prompt,
        options: {
          model,
          systemPrompt: system,
          tools: [],
          mcpServers: laneServers(this.sim.ctx, task.agent, (c) => calls.push(c)),
          allowedTools: laneToolNames(this.sim.ctx, task.agent),
          canUseTool: async (name) => ({ behavior: 'deny', message: `${name} is not available in this simulation.` }),
          maxTurns: cfg.limits.agent_max_turns,
          effort: cfg.models.house_effort,
          maxBudgetUsd: Math.max(0.01, budget.remaining),
          settingSources: [],
          persistSession: false,
          env: agentSubprocessEnv(),
        },
      });
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          for (const b of msg.message.content as any[]) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
        } else if (msg.type === 'result') {
          usd = msg.total_cost_usd ?? 0;
          for (const u of Object.values(msg.modelUsage ?? {})) {
            usage.input += u.inputTokens;
            usage.output += u.outputTokens;
            usage.cacheRead += u.cacheReadInputTokens;
          }
          if (msg.subtype !== 'success') error = msg.subtype;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    budget.record(model, usd, `agent:${task.agent}`, usage);
    if (error) this.sim.logEvent('agent_error', { task: task.id, error: error.slice(0, 300) });
    const text = texts.join('\n\n') || (error ? `(error: ${error})` : '(no text)');
    if (!error) writeFileSync(file, JSON.stringify({ calls: calls.map(({ tool, action, args }) => ({ tool, action, args })), text, usd } satisfies CachedRun));
    budget.ensure(); // stop the run if this call took it over the cap
    return {
      calls,
      transcript: `${header}\n## Agent\n${text}\n\n## Tool calls\n${renderCalls(calls)}\n\nCost $${usd.toFixed(4)} · in ${usage.input} (cache read ${usage.cacheRead}) · out ${usage.output}\n`,
      summary: texts[texts.length - 1]?.slice(0, 300) ?? error,
      usd,
      tokensIn,
    };
  }
}
