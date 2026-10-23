/**
 * Seeded randomness. Each domain (workshop, members, events...) draws from its
 * own stream, so a change in one domain does not shift the dice in another.
 * That keeps policy variants comparable under the same seed.
 */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  /** Log-normal with the given median; sigma controls the spread. */
  lognormal(median: number, sigma = 0.6): number {
    return median * Math.exp(sigma * this.normal());
  }
  weighted<K extends string>(weights: Record<K, number>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [k, w] of entries) {
      if ((r -= w) <= 0) return k;
    }
    return entries[entries.length - 1][0];
  }
}

export class RngStreams {
  private streams = new Map<string, Rng>();
  constructor(private seed: number) {}
  get(domain: string): Rng {
    let r = this.streams.get(domain);
    if (!r) {
      r = new Rng(hashString(`${this.seed}:${domain}`));
      this.streams.set(domain, r);
    }
    return r;
  }
}
