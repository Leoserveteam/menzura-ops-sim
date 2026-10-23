import type { HouseConfig } from '../config.ts';
import type { SimContext } from '../context.ts';
import { addMonths, dateOf, iso, monthOf } from '../util/time.ts';

/** What the house knows about a member: never the behaviour profile label, never a score. */
export function memberCard(ctx: SimContext, memberId: string, lines: number) {
  const m = ctx.db.get('SELECT * FROM members WHERE id = ?', memberId);
  if (!m) return { error: `No member ${memberId}` };
  const attrs = Object.fromEntries(
    ctx.db.all('SELECT key, value FROM attio_attributes WHERE member_id = ? ORDER BY updated_at DESC LIMIT 20', memberId).map((r) => [r.key, r.value]),
  );
  const notes = ctx.db
    .all(`SELECT kind, text, created_at FROM attio_notes WHERE subject_id = ? AND status = 'final' ORDER BY created_at DESC LIMIT ?`, memberId, lines)
    .map((n) => `${dateOf(n.created_at)} [${n.kind}] ${n.text}`);
  const profile = ctx.cfg.members.profiles[m.profile];
  return {
    id: m.id,
    name: m.name,
    tier: m.tier,
    line: m.line,
    contact: profile.via_assistant ? `Through his assistant only (${m.assistant_email})` : m.email,
    member_since: dateOf(m.joined_at),
    agreed_proposal_day: m.proposal_day,
    usual_delivery_day: m.delivery_day,
    status: m.status,
    pause_months_used: m.paused_months,
    attributes: attrs,
    recent_lines: notes,
  };
}

export function pieceCostUsd(cfg: HouseConfig, line: string, garments = 1): number {
  const c = cfg.costs;
  const wholesale = line === 'heritage' ? c.heritage_agbada_wholesale_ngn / c.fx.NGN_per_USD : c.boardroom_suit_wholesale_cad / c.fx.CAD_per_USD;
  return Math.round((wholesale + c.cloth_uplift_usd) * garments);
}

/**
 * Garments per production month: pieces already planned, plus the monthly
 * pieces not yet booked for members active or due to join (a piece made in
 * month X is delivered in month X+1), plus Principals' further commissions.
 */
export function capacityForecast(ctx: SimContext) {
  const now = monthOf(ctx.now());
  const alloc = ctx.cfg.capacity.monthly_garment_allocation;
  return [0, 1, 2, 3].map((i) => addMonths(now, i)).map((month) => {
    const booked = ctx.db.scalar<number>(
      `SELECT COALESCE(SUM(garments), 0) FROM pieces WHERE production_month = ? AND house_status != 'hold'`,
      month,
    );
    const delivery = addMonths(month, 1);
    const members = ctx.db.all(`SELECT id, tier FROM members WHERE status = 'active' AND first_round_month <= ?`, delivery);
    const haveMonthly = new Set(
      ctx.db.all(`SELECT member_id FROM pieces WHERE kind = 'monthly' AND production_month = ?`, month).map((r) => r.member_id),
    );
    let expected = 0;
    for (const m of members) {
      if (haveMonthly.has(m.id)) continue;
      const extras = ctx.db.get(`SELECT value FROM attio_attributes WHERE member_id = ? AND key = 'extra_commission_months'`, m.id)?.value ?? '';
      expected += extras.split(',').includes(delivery) ? 2 : 1;
    }
    const pipeline = Object.entries(ctx.cfg.members.growth_base_case)
      .filter(([m]) => m > now && m < month)
      .reduce((s, [, n]) => s + n, 0);
    const garments = booked + expected + pipeline;
    return { month, booked, expected_recurring: expected + pipeline, garments, allocation: alloc, at_or_over: garments >= alloc };
  });
}

export function monthlyResults(ctx: SimContext, month: string) {
  const tiers = ctx.cfg.membership.tiers;
  const active = ctx.db.all(`SELECT tier FROM members WHERE first_round_month <= ? AND status != 'left'`, month);
  const revenue = active.reduce((s, m) => s + tiers[m.tier as 'member' | 'principal'].fee_usd / 12, 0);
  const modelContribution = active.reduce((s, m) => s + tiers[m.tier as 'member' | 'principal'].contribution_usd / 12, 0);
  const pieces = ctx.db.scalar<number>(`SELECT COALESCE(SUM(cost_usd), 0) FROM pieces WHERE production_month = ?`, month);
  const other = ctx.db.scalar<number>(`SELECT COALESCE(SUM(usd), 0) FROM costs WHERE substr(datetime(at/1000, 'unixepoch'), 1, 7) = ?`, month);
  const credits = -ctx.db.scalar<number>(
    `SELECT COALESCE(SUM(amount_usd), 0) FROM stripe_invoices WHERE kind = 'credit' AND substr(datetime(created_at/1000, 'unixepoch'), 1, 7) = ?`,
    month,
  );
  const contribution = revenue - pieces - other - credits;
  return {
    month,
    members: active.length,
    revenue_usd: Math.round(revenue),
    piece_costs_usd: Math.round(pieces),
    other_costs_usd: Math.round(other),
    credits_usd: Math.round(credits),
    contribution_usd: Math.round(contribution),
    model_contribution_usd: Math.round(modelContribution),
    variance_usd: Math.round(contribution - modelContribution),
    as_of: iso(ctx.now()),
  };
}
