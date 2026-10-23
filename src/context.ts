import { EventEmitter } from 'node:events';
import type { AgentId, HouseConfig, Policies } from './config.ts';
import type { Db } from './db.ts';
import type { RunLog } from './log.ts';
import type { RngStreams } from './util/rng.ts';
import type { ContentGuard } from './guard/content.ts';
import type { Gate } from './gate.ts';
import type { Budget } from './engine/budget.ts';

export type Actor = AgentId | 'stylist' | 'operator' | 'nick' | 'world' | 'engine';

/** Everything a run shares. One instance per run. */
export interface SimContext {
  cfg: HouseConfig;
  db: Db;
  log: RunLog;
  rng: RngStreams;
  content: ContentGuard;
  gate: Gate;
  budget: Budget;
  policies: Policies;
  bus: EventEmitter;
  mode: 'offline' | 'live';
  interactive: boolean;
  now(): number;
}
