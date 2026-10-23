import type { Sim } from './sim.ts';
import * as world from './world.ts';
import * as scoring from './scoring.ts';
import { DAY, atTime, dayInMonth, iso, parseTime, addMonths } from '../util/time.ts';

/**
 * The ten scripted stress cases. Round-based ones (a fit failing twice, a piece
 * running late before a wedding) are attached when their round is created; the
 * rest fire at their configured time. The report checks that every one fired.
 */
export const REQUIRED_SCRIPTED = [
  'late_before_wedding',
  'fit_fails_twice',
  'silent_six_weeks',
  'assistant_taste_question',
  'workshop_missed_update',
  'change_finished_piece',
  'same_exception_second',
  'saturday_night_disappointment',
  'allocation_month_7',
  'applicant_with_following',
];

export function schedule(sim: Sim): void {
  for (const ev of sim.ctx.cfg.scripted_events) {
    if (ev.id === 'silent_six_weeks') {
      const from = parseTime(String(ev.from));
      const to = parseTime(String(ev.to));
      sim.ctx.db.update('members', String(ev.member), { silent_from: from, silent_to: to });
      sim.schedule(from, 'scripted', { id: ev.id });
      continue;
    }
    if (ev.id === 'allocation_month_7') {
      const month = String(ev.month);
      const first = parseTime(`${month}-01`);
      const warnBy = first - sim.ctx.cfg.capacity.warn_days_ahead * DAY;
      sim.schedule(atTime(warnBy, '23:00'), 'check', { kind: 'capacity_deadline', month });
      for (const t of [warnBy, first - 30 * DAY, first - DAY]) sim.schedule(atTime(t, '22:00'), 'check', { kind: 'allocation_probe', month });
      continue;
    }
    if (ev.at) sim.schedule(parseTime(String(ev.at)), 'scripted', { id: ev.id });
  }
}

export async function fire(sim: Sim, id: string): Promise<void> {
  const ev = sim.ctx.cfg.scripted_events.find((e) => e.id === id)!;
  const member = ev.member ? String(ev.member) : undefined;
  if (member && !sim.ctx.db.get('SELECT 1 FROM members WHERE id = ?', member)) return;
  const say = (purpose: string, fallback: string) => sim.members.write(member!, purpose, fallback);
  switch (id) {
    case 'assistant_taste_question':
      sim.logEvent(id, {}, true, member);
      await sim.members.inbound({
        memberId: member!, intent: 'taste_question',
        body: await say('As his assistant, ask the house which of his two new pieces he should wear to Thursday\'s board dinner, and whether an agbada would be right for an investiture next month.',
          'Mr Coker asks which of the two new pieces he should wear to Thursday\'s board dinner, and whether an agbada would be right for the investiture next month.'),
      });
      return;
    case 'same_exception_first':
    case 'same_exception_second':
      sim.logEvent(id, { dinner: ev.dinner }, true, member);
      world.setFlag(sim, `exception_dinner:${member}`, dinnerIdFor(sim, String(ev.dinner)));
      await sim.members.inbound({
        memberId: member!, intent: 'exception',
        body: await say(`Ask the house whether you may bring two extra guests to the dinner on ${ev.dinner} (the published allowance is one).`,
          `May I bring two more guests to the dinner on ${ev.dinner}? Old friends in town.`),
      });
      return;
    case 'saturday_night_disappointment': {
      sim.logEvent(id, {}, true, member);
      const month = iso(sim.now()).slice(0, 7);
      const r = sim.ctx.db.get('SELECT * FROM rounds WHERE member_id = ? AND month = ?', member!, month);
      const p = r ? sim.pieceForRound(r.id) : undefined;
      if (p && !p.fit_ok_at) {
        if (!p.arrive_at) sim.ctx.db.update('pieces', p.id, { arrive_at: sim.now(), house_status: 'delivered', ship_at: p.ship_at ?? sim.now() - 2 * DAY });
        world.damagedOnArrival(sim, p.id, 0.25);
      } else {
        await sim.members.inbound({ memberId: member!, intent: 'disappointment', body: 'The piece delivered tonight has a flaw in the cloth. Very disappointing.' });
        scoring.disappointment(sim, member!, 'damaged_piece', 'Saturday night complaint', r?.id, 'desk');
      }
      return;
    }
    case 'family_commission_enquiry':
      sim.logEvent(id, { garments: ev.garments }, true, member);
      world.setFlag(sim, `commission_pending:${member}`, JSON.stringify({ garments: ev.garments, for_month: ev.for_month, occasion: ev.occasion }));
      await sim.members.inbound({
        memberId: member!, intent: 'commission',
        body: await say(`Ask the house to dress your whole family (about ${ev.garments} garments, agbada and kaftan) for a family celebration abroad on ${ev.occasion}.`,
          `We have a family celebration abroad on ${ev.occasion}. Could the house dress the family? Perhaps ${ev.garments} pieces in all.`),
      });
      return;
    case 'applicant_with_following':
      world.applicantArrives(sim, { baseCase: false, following: true, joinMonth: addMonths(iso(sim.now()).slice(0, 7), 1) });
      sim.logEvent(id, {}, true);
      return;
    case 'workshop_missed_update':
      sim.logEvent(id, {}, true);
      return;
    case 'change_finished_piece':
      sim.logEvent(id, { event: ev.event }, true, member);
      await sim.members.inbound({
        memberId: member!, intent: 'change_request',
        body: await say(`Ask, a little apologetically, whether the sleeves on your finished suit could be taken up slightly before an event on ${ev.event}, three days away.`,
          `Could the sleeves on the suit be taken up a touch? I wear it on ${ev.event}.`),
      });
      return;
    case 'silent_six_weeks':
      sim.logEvent(id, { from: ev.from, to: ev.to }, true, member);
      return;
    default:
      sim.logEvent(id, {}, true, member);
  }
}

function dinnerIdFor(sim: Sim, date: string): string {
  return sim.ctx.cfg.dinners.events.find((d) => d.date === date)?.id ?? `dinner on ${date}`;
}

/** Publicity from a member with a following, under either applicant policy. */
export function publication(sim: Sim, p: { memberId: string; kind: 'promotional_piece' | 'post_breach' }): void {
  const { cfg, db } = sim.ctx;
  const others = db.all(`SELECT id FROM members WHERE id != ? AND status = 'active' ORDER BY id`, p.memberId);
  const r = sim.ctx.rng.get('following');
  if (p.kind === 'promotional_piece') {
    sim.logEvent('promotional_piece_published', {}, false, p.memberId);
    for (const o of others) sim.satisfy(o.id, cfg.satisfaction.discretion_breach_all_members, 'the house appeared in a promotional piece');
    if (others.length && r.chance(cfg.random_events.promo_exposes_member.p ?? 0)) {
      const victim = r.pick(others).id;
      scoring.foul(sim, { memberId: victim, kind: 'privacy_slip', cause: `the promotional piece for ${p.memberId} showed ${victim} at a house evening`, person: 'nick' });
    }
  } else {
    sim.logEvent('member_post_touched_house', {}, false, p.memberId);
    if (others.length) {
      const victim = r.pick(others).id;
      scoring.foul(sim, { memberId: victim, kind: 'privacy_slip', cause: `${p.memberId} posted a photo from the house that included ${victim}, despite the privacy promise`, person: `member ${p.memberId}` });
    }
  }
}

export const _u = { dayInMonth };
