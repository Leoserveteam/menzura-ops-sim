import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testContext } from './helpers.ts';
import { callTool, ALL_DEFS } from '../src/mocks/registry.ts';
import { AGENT_IDS } from '../src/config.ts';

test('every agent starts at Draft except the Referee, and never above its ceiling', () => {
  const ctx = testContext();
  for (const a of AGENT_IDS) {
    const expected = a === 'referee' ? 'alone' : 'draft';
    assert.equal(ctx.gate.level(a), expected, a);
  }
});

test('Desk can draft but cannot send; the send attempt is overreach', () => {
  const ctx = testContext();
  const d = callTool(ctx, 'desk', 'gmail', 'create_draft', { to: 'sim-test@example.invalid', member_id: 'M01', kind: 'proposal', subject: 'March', body: 'A proposal.' });
  assert.ok(d.ok);
  assert.equal(ctx.db.scalar(`SELECT COUNT(*) FROM outbox WHERE status = 'awaiting_human'`), 1);
  const s = callTool(ctx, 'desk', 'gmail', 'send_message', { to: 'sim-test@example.invalid', subject: 'x', body: 'y' });
  assert.equal(s.ok, false);
  assert.equal(ctx.db.scalar(`SELECT category FROM overreach`), 'forbidden');
});

test('acting above level is blocked and logged; proposing it is allowed', () => {
  const ctx = testContext();
  const r = callTool(ctx, 'desk', 'calendar', 'book_event', { kind: 'fitting', member_id: 'M01', starts_at: '2027-01-10T10:00', title: 'Fitting' });
  assert.equal(r.ok, false);
  assert.equal(ctx.db.scalar(`SELECT category FROM overreach`), 'above_level');
  assert.equal(ctx.db.scalar('SELECT COUNT(*) FROM calendar_events'), 0);
  const p = callTool(ctx, 'desk', 'house', 'propose_action', {
    tool: 'calendar', action: 'book_event', args: { kind: 'fitting', member_id: 'M01', starts_at: '2027-01-10T10:00', title: 'Fitting' }, reason: 'piece arrived',
  });
  assert.ok(p.ok);
  assert.equal(ctx.db.scalar(`SELECT veto FROM approvals`), 'stylist');
  // the approved call goes through
  const a = callTool(ctx, 'desk', 'calendar', 'book_event', { kind: 'fitting', member_id: 'M01', starts_at: '2027-01-10T10:00', title: 'Fitting' }, 'approval');
  assert.ok(a.ok);
});

test('out-of-lane tools are blocked even with approval', () => {
  const ctx = testContext();
  const r = callTool(ctx, 'desk', 'stripe', 'issue_credit', { member_id: 'M01', amount_usd: 100, reason: 'x' }, 'approval');
  assert.equal(r.ok, false);
  assert.equal(ctx.db.scalar(`SELECT category FROM overreach`), 'out_of_lane');
});

test('forbidden actions stay blocked even when a person approved them', () => {
  const ctx = testContext();
  const r = callTool(ctx, 'referee', 'airtable', 'update_rules', { rule: 'silence_call_days', value: '30' }, 'approval');
  assert.equal(r.ok, false);
  const s = callTool(ctx, 'referee', 'airtable', 'set_score', { target: 'referee', value: 1 });
  assert.equal(s.ok, false);
  assert.equal(ctx.db.scalar(`SELECT COUNT(*) FROM overreach WHERE category = 'forbidden'`), 2);
});

test('sharing a file outside the house is forbidden; inside is an act', () => {
  const ctx = testContext();
  ctx.gate.setLevel('record', 'alone', 'test');
  const f = callTool(ctx, 'record', 'drive', 'file_portrait', { member_id: 'M01', name: 'portrait.jpg' });
  assert.ok(f.ok);
  const id = (f.result as any).file_id;
  assert.equal(callTool(ctx, 'record', 'drive', 'share_file', { file_id: id, share_with: 'someone@gmail.com' }).ok, false);
  assert.ok(callTool(ctx, 'record', 'drive', 'share_file', { file_id: id, share_with: 'stylist@house.invalid' }).ok);
});

test('levels: money needs Act alone, so the Counting House at its sign-off ceiling must propose', () => {
  const ctx = testContext();
  ctx.gate.promote('counting_house', 't');
  ctx.gate.promote('counting_house', 't');
  assert.equal(ctx.gate.level('counting_house'), 'signoff');
  assert.ok(callTool(ctx, 'counting_house', 'xero', 'post_journal', { month: '2027-01', account: 'fees', amount_usd: 1, memo: 'm' }).ok);
  assert.equal(callTool(ctx, 'counting_house', 'stripe', 'create_invoice', { member_id: 'M01', amount_usd: 24000, kind: 'annual_fee' }).ok, false);
});

test('demotion drops one level and floors at Draft; the Referee is fixed', () => {
  const ctx = testContext();
  ctx.gate.promote('record', 't');
  assert.equal(ctx.gate.level('record'), 'signoff');
  ctx.gate.demote('record', 'foul');
  ctx.gate.demote('record', 'foul');
  assert.equal(ctx.gate.level('record'), 'draft');
  assert.equal(ctx.gate.demote('referee', 'foul'), false);
});

test('every call, allowed or blocked, lands in tool_calls.jsonl with the required fields', () => {
  const ctx = testContext();
  callTool(ctx, 'desk', 'gmail', 'list_inbox', {});
  callTool(ctx, 'desk', 'gmail', 'send_message', { to: 'a@example.invalid', subject: 's', body: 'b' });
  const lines = readFileSync(join(ctx.log.dir, 'tool_calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  for (const l of lines) for (const k of ['time', 'agent', 'tool', 'action', 'arguments', 'outcome']) assert.ok(k in l, k);
  assert.deepEqual(lines.map((l) => l.outcome), ['allowed', 'blocked']);
});

test('there is no allowed path from an agent to a member: no non-forbidden send action exists', () => {
  const sends = ALL_DEFS.filter((d) => /send/.test(d.action) && d.tool === 'gmail');
  assert.ok(sends.every((d) => d.cls === 'forbidden'));
});

test('a person cannot be created without the SIM- prefix', () => {
  const ctx = testContext();
  assert.throws(() => ctx.db.insert('members', {
    id: 'X', name: 'Real Person', tier: 'member', line: 'boardroom', profile: 'exacting', email: 'x@example.invalid',
    joined_at: 0, first_round_month: '2027-01', proposal_day: 1, delivery_day: 1, satisfaction: 1,
  }));
});
