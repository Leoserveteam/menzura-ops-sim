import type { Db } from '../db.ts';

export class BudgetExceededError extends Error {
  constructor(public spent: number, public cap: number) {
    super(`Budget reached: $${spent.toFixed(2)} of $${cap.toFixed(2)}. The run stopped here.`);
  }
}

/** Real API spend for this run. Offline runs always read $0. */
export class Budget {
  spent = 0;
  calls = 0;
  cachedCalls = 0;
  stoppedAt: number | null = null;

  constructor(readonly capUsd: number, private db: Db, private now: () => number) {}

  get remaining(): number {
    return Math.max(0, this.capUsd - this.spent);
  }

  /** Call before every model call. */
  ensure(estimateUsd = 0): void {
    if (this.spent + estimateUsd >= this.capUsd) {
      this.stoppedAt ??= this.now();
      throw new BudgetExceededError(this.spent, this.capUsd);
    }
  }

  record(model: string, usd: number, kind: string, usage: { input?: number; output?: number; cacheRead?: number } = {}, cached = false): void {
    this.spent += usd;
    this.calls++;
    if (cached) this.cachedCalls++;
    this.db.insert('spend', {
      at: this.now(), model, usd, kind, input_tokens: usage.input, output_tokens: usage.output, cache_read_tokens: usage.cacheRead, cached: cached ? 1 : 0,
    });
  }
}
