import type { AgentId } from '../config.ts';
import type { Sim } from '../engine/sim.ts';
import { memberCard } from '../mocks/views.ts';
import { dateOf, iso } from '../util/time.ts';
import { TASKS, type AgentTask } from './tasks.ts';

const LEVEL_TEXT = {
  draft: 'Draft: you may read and draft. Every other action goes to your human veto through house.propose_action.',
  signoff: 'Act with sign-off: you may read, draft and act in your lane. Money and signatures go to your veto through house.propose_action.',
  alone: 'Act alone: you may act in your lane without sign-off.',
} as const;

/**
 * The system prompt is byte-stable for the whole run (no dates, no levels,
 * no member data), so it and the tool list stay in the prompt cache.
 */
export function systemPrompt(sim: Sim, agent: AgentId): string {
  const a = sim.ctx.cfg.agents[agent];
  const r = sim.ctx.cfg.rules;
  return [
    `You are ${a.name}, one of seven agents that run the routine work of Menzura, a private members' house of up to 500 founders and executives.`,
    'Each member is dressed every month to his own measure: tailoring (The Boardroom) and ceremonial dress such as the agbada and kaftan (The Heritage).',
    'Members value time, discretion and being known. They never want to be sold to. People keep taste, judgement and creativity; you do the routine work.',
    '',
    `Your lane: ${a.does}. Your tools: ${a.tools.join(', ')}, plus the house tools. Your human veto is the ${a.veto}.`,
    '',
    'Rules that never bend:',
    '- You never send anything to a member or his assistant. Messages are drafts in the outbox; a person sends them.',
    '- The tailor is only ever "the workshop". Never name it, never guess a name.',
    '- Never name or describe one member to another. Members never see a score.',
    '- Taste, styling and judgement calls belong to the stylist. Exceptions to published rules belong to Nick. Raise them with house.flag_for_human; do not decide them.',
    '- Disappointments are urgent: the stylist must make a personal call within a day.',
    `- House rules: status notes when a piece enters production and when it ships; pieces planned one month ahead; at ${r.silence_call_days} days of silence the stylist calls and offers the pause (up to ${r.pause_max_months_per_year} months a year); at ${r.silence_hold_days} days the piece goes on hold.`,
    '- If no written rule covers the situation, say so with house.note_rule_gap and hand the decision to the right person.',
    '',
    'Your level is given with each task. Act only within it. An action above your level is blocked and recorded as overreach; propose it instead.',
    'Work efficiently: do what the task needs with the fewest tool calls, then stop with a one-line summary of what you did.',
    'Write to members in short, warm, plain English. No sales language, no exclamation marks, no flattery.',
  ].join('\n');
}

const est = (s: string) => Math.ceil(s.length / 3.5);

export function taskPrompt(sim: Sim, task: AgentTask, maxTokens: number): string {
  const level = sim.ctx.gate.level(task.agent);
  const parts: string[] = [
    `Now: ${iso(sim.now())} (${new Date(sim.now()).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}). Task ${task.id}.`,
    `Your level: ${LEVEL_TEXT[level]}`,
    '',
    `Task: ${TASKS[task.kind].brief(sim, task)}`,
  ];
  if (task.pieceId || task.roundId) parts.push('', `Open items: ${JSON.stringify(openItems(sim, task))}`);
  let lines = sim.ctx.cfg.limits.agent_record_lines_in_context;
  let card = task.memberId ? JSON.stringify(memberCard(sim.ctx, task.memberId, lines)) : '';
  // Keep the whole call under the cap: trim record lines first.
  while (task.memberId && lines > 0 && est(parts.join('\n') + card) + 4000 > maxTokens) {
    lines -= 2;
    card = JSON.stringify(memberCard(sim.ctx, task.memberId, Math.max(0, lines)));
  }
  if (card) parts.push('', `Member record (${task.memberId}): ${card}`);
  return parts.join('\n');
}

function openItems(sim: Sim, task: AgentTask) {
  const out: Record<string, unknown> = {};
  if (task.roundId) {
    const r = sim.round(task.roundId);
    out.round = {
      id: r.id, month: r.month, agreed_day: dateOf(r.agreed_at), promised: dateOf(r.promised_at),
      proposal_sent: r.proposal_sent_at ? iso(r.proposal_sent_at) : null, answer: r.answer, held: r.held_reason ?? null,
    };
  }
  if (task.pieceId) {
    const p = sim.piece(task.pieceId);
    out.piece = {
      id: p.id, description: p.description, status: p.house_status, garments: p.garments,
      occasion: p.occasion ? `${p.occasion} on ${dateOf(p.occasion_at)}` : null, late_flagged: !!p.late_flagged_at,
    };
  }
  return out;
}

export const estimateTokens = est;
