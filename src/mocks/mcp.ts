import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AgentId } from '../config.ts';
import type { SimContext } from '../context.ts';
import { callTool, defsFor, type CallResult } from './registry.ts';

export interface RecordedCall {
  tool: string;
  action: string;
  args: Record<string, unknown>;
  result: CallResult;
}

/**
 * One in-process MCP server per mock service in the agent's lane, plus the
 * house server. No ports, no network. Every call is routed through callTool,
 * so the permission gate and the JSONL log see it.
 */
export function laneServers(ctx: SimContext, agent: AgentId, onCall: (c: RecordedCall) => void): Record<string, McpSdkServerConfigWithInstance> {
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};
  const tools = [...ctx.cfg.agents[agent].tools, 'house' as const];
  for (const t of tools) {
    servers[t] = createSdkMcpServer({
      name: t,
      version: '0.1.0',
      alwaysLoad: true,
      tools: defsFor(t).map((d) =>
        tool(d.action, d.description, d.shape, async (args: Record<string, unknown>) => {
          const result = callTool(ctx, agent, d.tool, d.action, args, 'agent');
          onCall({ tool: d.tool, action: d.action, args, result });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.ok ? result.result ?? { ok: true } : { error: result.error }) }],
            isError: !result.ok,
          };
        }),
      ),
    });
  }
  return servers;
}

/** Fully-qualified tool names the SDK exposes for a lane, e.g. mcp__gmail__create_draft. */
export function laneToolNames(ctx: SimContext, agent: AgentId): string[] {
  return [...ctx.cfg.agents[agent].tools, 'house' as const].flatMap((t) => defsFor(t).map((d) => `mcp__${t}__${d.action}`));
}
