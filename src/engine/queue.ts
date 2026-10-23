export interface SimEvent {
  at: number;
  seq: number;
  type: string;
  payload: any;
}

/** Binary-heap priority queue ordered by time, then insertion order (stable, so runs repeat). */
export class EventQueue {
  private heap: SimEvent[] = [];
  private seq = 0;

  push(at: number, type: string, payload: any = {}): void {
    const ev = { at, seq: this.seq++, type, payload };
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p], h[i])) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }

  pop(): SimEvent | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l], h[m])) m = l;
        if (r < h.length && less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }

  get size(): number {
    return this.heap.length;
  }
}

function less(a: SimEvent, b: SimEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}
