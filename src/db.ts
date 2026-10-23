import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Row = Record<string, any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (name LIKE 'SIM-%'),
  tier TEXT NOT NULL, line TEXT NOT NULL, profile TEXT NOT NULL,
  email TEXT NOT NULL, assistant_email TEXT,
  joined_at INTEGER NOT NULL, first_round_month TEXT NOT NULL,
  proposal_day INTEGER NOT NULL, delivery_day INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', satisfaction REAL NOT NULL,
  paused_months INTEGER NOT NULL DEFAULT 0, following INTEGER NOT NULL DEFAULT 0,
  silent_from INTEGER, silent_to INTEGER
);
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, month TEXT NOT NULL,
  agreed_at INTEGER NOT NULL, planned_start INTEGER NOT NULL, promised_at INTEGER NOT NULL,
  proposal_drafted_at INTEGER, proposal_sent_at INTEGER,
  answer TEXT, answer_received_at INTEGER, answer_recorded_at INTEGER,
  silence_flagged_at INTEGER, silence_called_at INTEGER, held_at INTEGER, held_reason TEXT,
  record_line_at INTEGER, portrait_offered_at INTEGER,
  m1 INTEGER, m2 INTEGER, m3 INTEGER, m4 INTEGER, m5 INTEGER, m6 INTEGER, m7 INTEGER,
  in_play INTEGER NOT NULL DEFAULT 1, fouled INTEGER NOT NULL DEFAULT 0, clean INTEGER,
  closed INTEGER NOT NULL DEFAULT 0, scored INTEGER NOT NULL DEFAULT 1,
  UNIQUE (member_id, month)
);
CREATE TABLE IF NOT EXISTS pieces (
  id TEXT PRIMARY KEY, round_id TEXT, member_id TEXT NOT NULL, description TEXT NOT NULL,
  line TEXT NOT NULL, garments INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'monthly',
  house_status TEXT NOT NULL DEFAULT 'proposed', house_notes TEXT,
  ordered_at INTEGER, start_at INTEGER, reported_start_at INTEGER, ship_at INTEGER, arrive_at INTEGER,
  production_note_at INTEGER, ship_note_at INTEGER, late_flagged_at INTEGER, late_note_at INTEGER,
  fitting_booked_at INTEGER, fitting_at INTEGER, fit_attempts INTEGER NOT NULL DEFAULT 0,
  fit_ok_at INTEGER, alteration_booked_at INTEGER, alteration_at INTEGER, fit_failed_at INTEGER,
  occasion TEXT, occasion_at INTEGER, express INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  production_month TEXT, script TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, by_agent TEXT NOT NULL,
  to_addr TEXT NOT NULL, member_id TEXT, round_id TEXT, piece_id TEXT, kind TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting_human',
  reviewed_by TEXT, review_note TEXT, sent_by TEXT, sent_at INTEGER, guard_issues TEXT,
  reply_to TEXT, meta TEXT, delivered INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, from_addr TEXT NOT NULL, member_id TEXT,
  round_id TEXT, kind TEXT NOT NULL, intent TEXT, body TEXT NOT NULL,
  replied_at INTEGER, handled_at INTEGER, needs_stylist INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, by_actor TEXT NOT NULL, kind TEXT NOT NULL,
  member_id TEXT, piece_id TEXT, starts_at INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'booked'
);
CREATE TABLE IF NOT EXISTS drive_files (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, by_actor TEXT NOT NULL, member_id TEXT,
  name TEXT NOT NULL, folder TEXT NOT NULL, shared_with TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS attio_attributes (
  member_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, by_actor TEXT NOT NULL,
  PRIMARY KEY (member_id, key)
);
CREATE TABLE IF NOT EXISTS attio_notes (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  created_at INTEGER NOT NULL, by_actor TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'final'
);
CREATE TABLE IF NOT EXISTS airtable_rows (
  tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, by_actor TEXT NOT NULL,
  PRIMARY KEY (tbl, id)
);
CREATE TABLE IF NOT EXISTS stripe_invoices (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, member_id TEXT, amount_usd REAL NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, by_actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS xero_journals (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, month TEXT, account TEXT NOT NULL,
  amount_usd REAL NOT NULL, memo TEXT, by_actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS carta_entries (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, holder TEXT NOT NULL, instrument TEXT NOT NULL,
  amount REAL NOT NULL, status TEXT NOT NULL, by_actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docusign_envelopes (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, subject_id TEXT NOT NULL, template TEXT NOT NULL,
  status TEXT NOT NULL, by_actor TEXT NOT NULL, sent_at INTEGER, signed_at INTEGER
);
CREATE TABLE IF NOT EXISTS applicants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (name LIKE 'SIM-%'), received_at INTEGER NOT NULL,
  summary TEXT NOT NULL, following INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL, line TEXT NOT NULL,
  profile TEXT NOT NULL, intended_join TEXT, status TEXT NOT NULL DEFAULT 'received',
  brief_at INTEGER, decided_at INTEGER, decision TEXT, member_id TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL,
  action TEXT NOT NULL, args TEXT NOT NULL, reason TEXT, veto TEXT NOT NULL, urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', decided_at INTEGER, decided_by TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS flags (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, by_actor TEXT NOT NULL, role TEXT NOT NULL,
  urgency TEXT NOT NULL, topic TEXT NOT NULL, summary TEXT NOT NULL, member_id TEXT, ref TEXT,
  status TEXT NOT NULL DEFAULT 'open', handled_at INTEGER, handled_by TEXT, outcome TEXT
);
CREATE TABLE IF NOT EXISTS disappointments (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, member_id TEXT NOT NULL, round_id TEXT, kind TEXT NOT NULL,
  detail TEXT, should_flag TEXT, flagged_at INTEGER, call_at INTEGER, deadline INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0, fouled INTEGER NOT NULL DEFAULT 0, recovery TEXT
);
CREATE TABLE IF NOT EXISTS fouls (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, member_id TEXT, round_id TEXT, kind TEXT NOT NULL,
  cause TEXT NOT NULL, responsible_agent TEXT, responsible_person TEXT, review_at INTEGER
);
CREATE TABLE IF NOT EXISTS overreach (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL,
  level TEXT NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS level_log (
  at INTEGER NOT NULL, agent TEXT NOT NULL, level TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS human_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
  minutes REAL NOT NULL, member_id TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS rule_gaps (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, situation TEXT NOT NULL, raised_by TEXT NOT NULL,
  improvised_by TEXT, decision TEXT, member_id TEXT
);
CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, member_id TEXT NOT NULL, request TEXT NOT NULL,
  decision TEXT NOT NULL, decided_by TEXT NOT NULL, precedent_of TEXT, rationale TEXT
);
CREATE TABLE IF NOT EXISTS gestures (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, season TEXT NOT NULL, chosen_at INTEGER,
  delivered_at INTEGER, description TEXT, brought_forward INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS satisfaction_log (
  at INTEGER NOT NULL, member_id TEXT NOT NULL, delta REAL NOT NULL, reason TEXT NOT NULL, value REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS costs (
  at INTEGER NOT NULL, member_id TEXT, kind TEXT NOT NULL, usd REAL NOT NULL, policy TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS spend (
  at INTEGER NOT NULL, model TEXT NOT NULL, usd REAL NOT NULL, kind TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cached INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, agent TEXT NOT NULL, task_kind TEXT NOT NULL,
  member_id TEXT, path TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER, interest REAL NOT NULL DEFAULT 0,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS event_log (
  at INTEGER NOT NULL, kind TEXT NOT NULL, scripted INTEGER NOT NULL DEFAULT 0, member_id TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS agent_misses (
  at INTEGER NOT NULL, agent TEXT NOT NULL, task_kind TEXT NOT NULL, member_id TEXT, detail TEXT
);
`;

export class Db {
  readonly raw: DatabaseSync;
  private seq = new Map<string, number>();

  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec(SCHEMA);
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.raw.prepare(sql).run(...params);
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  scalar<T = number>(sql: string, ...params: SQLInputValue[]): T {
    const row = this.get(sql, ...params);
    return (row ? Object.values(row)[0] : undefined) as T;
  }

  /** Inserts a row object; undefined values are skipped. */
  insert(table: string, row: Row): void {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const vals = keys.map((k) => normalise(row[k]));
    this.raw.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...vals);
  }

  update(table: string, id: string, patch: Row, idCol = 'id'): void {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const vals = keys.map((k) => normalise(patch[k]));
    this.raw.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`).run(...vals, id);
  }

  /** Short readable ids: OUT-0001, PIECE-0042. */
  nextId(prefix: string): string {
    const n = (this.seq.get(prefix) ?? 0) + 1;
    this.seq.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  close(): void {
    this.raw.close();
  }
}

function normalise(v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as SQLInputValue;
}
