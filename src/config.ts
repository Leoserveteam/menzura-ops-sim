import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type LevelName = 'draft' | 'signoff' | 'alone';
export type Role = 'stylist' | 'operator' | 'nick';
export type AgentId = 'desk' | 'record' | 'workroom' | 'table' | 'door' | 'counting_house' | 'referee';
export type ToolName =
  | 'gmail' | 'calendar' | 'drive' | 'attio' | 'airtable' | 'stripe' | 'xero' | 'carta' | 'docusign';
export type PolicyKey = 'recovery' | 'applicant_following' | 'exceptions';
export type Variant = 'A' | 'B';
export type Policies = Record<PolicyKey, Variant>;

export interface AgentConfig {
  name: string;
  does: string;
  tools: ToolName[];
  ceiling: LevelName;
  veto: Role;
  start?: LevelName;
}

export interface HumanPolicy {
  work_days: number[];
  sessions: string[];
  weekend_urgent_delay_hours: number;
  evening_urgent_delay_hours: number;
  approve_rate: number;
  catch_rate: number;
}

export interface Profile {
  label: string;
  via_assistant: boolean;
  reply_median_hours: number;
  answer: { approve: number; swap: number; hold: number };
  patience_hours: number;
  chase_after_late_days: number;
  fit_ok: number;
  question_rate: number;
  selling_sensitivity: number;
}

export interface InitialMember {
  id: string;
  name: string;
  tier: 'member' | 'principal';
  line: 'boardroom' | 'heritage';
  profile: string;
  proposal_day: number;
  delivery_day: number;
}

export interface ScriptedEvent {
  id: string;
  at?: string;
  member?: string;
  [k: string]: unknown;
}

export interface HouseConfig {
  sim: { seed: number; prologue_start: string; scored_start: string; end: string };
  models: {
    house: string;
    people: string;
    house_effort: 'low' | 'medium' | 'high';
    people_effort: 'low' | 'medium' | 'high';
    pricing_usd_per_mtok: Record<string, { input: number; output: number; cache_read: number; cache_write: number }>;
  };
  limits: {
    agent_call_max_tokens: number;
    people_prompt_max_tokens: number;
    agent_max_turns: number;
    people_max_output_tokens: number;
    agent_record_lines_in_context: number;
  };
  membership: {
    tiers: Record<'member' | 'principal', { fee_usd: number; pieces: number; contribution_usd: number; portrait_session_usd: number }>;
    lines: string[];
  };
  costs: {
    fx: { CAD_per_USD: number; NGN_per_USD: number };
    boardroom_suit_wholesale_cad: number;
    heritage_agbada_wholesale_ngn: number;
    cloth_uplift_usd: number;
    portrait_usage_rate: number;
    occasion_guarantee_usd_per_member_year: number;
    occasion_guarantee_express_usd: number;
    alteration_usd: number;
    extra_dinner_guest_usd: number;
    local_alteration_rush_usd: number;
    promotional_piece_usd: number;
  };
  capacity: { monthly_garment_allocation: number; warn_days_ahead: number };
  rules: {
    status_note_on_production: boolean;
    status_note_on_ship: boolean;
    status_note_within_days: number;
    plan_months_ahead: number;
    production_days: { boardroom: number; heritage: number };
    shipping_days: number;
    booking_cutoff_buffer_days: number;
    desk_proposal_lead_days: number;
    silence_call_days: number;
    silence_hold_days: number;
    pause_max_months_per_year: number;
    answer_record_within_days: number;
    alteration_book_within_days: number;
    portrait_offer_within_days: number;
    personal_call_within_hours: number;
    urgent_flag_within_hours: number;
    record_line_grace_days: number;
    round_close_days_after_month: number;
    dinner_guest_allowance: number;
    exceptions_decided_by: Role;
    covered_situations: string[];
  };
  agents: Record<AgentId, AgentConfig>;
  levels: { order: LevelName[]; start: LevelName; promote_after_clean_season: number; demote_per_foul: number };
  humans: Record<Role, HumanPolicy> & { minutes: Record<string, number> };
  members: {
    profiles: Record<string, Profile>;
    initial: InitialMember[];
    growth_base_case: Record<string, number>;
    new_member_mix: { principal_share: number; heritage_share: number; profiles: string[] };
  };
  satisfaction: {
    start: number;
    monthly_regression: number;
    moment_hit: number;
    moment_miss: Record<string, number>;
    foul: number;
    gesture: number;
    selling_tone: number;
    personal_call_on_time: number;
    dinner_attended: number;
    exception_granted: number;
    exception_denied: number;
    exception_precedent_denied: number;
    discretion_breach_all_members: number;
    occasion_missed: number;
    occasion_saved: number;
    rush_change_granted: number;
    change_declined: number;
    recovery: Record<Variant, number>;
    renewal_illustration: { midpoint: number; steepness: number };
  };
  policies: Record<PolicyKey, { default: Variant; A: string; B: string }>;
  scripted_events: ScriptedEvent[];
  random_events: Record<string, { p?: number; p_per_month?: number; days?: [number, number] }>;
  dinners: { events: { id: string; date: string }[]; plan_days_ahead: number; attend_rate: number };
  offline: { mistake_rate: number; overreach_rate: number; urgent_miss_rate: number; taste_answer_rate: number };
  privacy: { denylist_file: string; member_domain: string };
}

export const AGENT_IDS: AgentId[] = ['desk', 'record', 'workroom', 'table', 'door', 'counting_house', 'referee'];
export const ROLES: Role[] = ['stylist', 'operator', 'nick'];

export function loadConfig(path = 'config/house.yaml'): HouseConfig {
  const cfg = parse(readFileSync(path, 'utf8')) as HouseConfig;
  validateConfig(cfg);
  return cfg;
}

export function defaultPolicies(cfg: HouseConfig): Policies {
  return {
    recovery: cfg.policies.recovery.default,
    applicant_following: cfg.policies.applicant_following.default,
    exceptions: cfg.policies.exceptions.default,
  };
}

/** Parses "recovery=B,exceptions=B" on top of the defaults. */
export function parsePolicies(cfg: HouseConfig, spec?: string): Policies {
  const p = defaultPolicies(cfg);
  if (!spec) return p;
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!(k in p) || (v !== 'A' && v !== 'B')) throw new Error(`Bad --policy entry "${part}". Use e.g. recovery=B`);
    p[k as PolicyKey] = v;
  }
  return p;
}

function validateConfig(cfg: HouseConfig): void {
  for (const m of cfg.members.initial) {
    if (!m.name.startsWith('SIM-')) throw new Error(`Member ${m.id} name must start with "SIM-": ${m.name}`);
    if (!cfg.members.profiles[m.profile]) throw new Error(`Member ${m.id} has unknown profile ${m.profile}`);
  }
  for (const id of AGENT_IDS) {
    const a = cfg.agents[id];
    if (!a) throw new Error(`Missing agent config: ${id}`);
    if (!cfg.levels.order.includes(a.ceiling)) throw new Error(`Agent ${id} has bad ceiling ${a.ceiling}`);
  }
}
