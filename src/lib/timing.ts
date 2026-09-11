/**
 * Server-Timing, one entry per segment of the request the function is
 * responsible for. The browser reads these off the response, which is what
 * makes a single request decomposable without a tracing backend.
 *
 * Durations are milliseconds with two decimals. Anything under a tenth of a
 * millisecond is reported as it is measured and not rounded up to something
 * that looks more serious.
 */
export type Segment = { name: string; dur: number; desc?: string };

export class Stopwatch {
  private readonly t0 = performance.now();
  private last = this.t0;
  readonly segments: Segment[] = [];

  /** Closes a segment that started when the previous one ended. */
  mark(name: string, desc?: string) {
    const now = performance.now();
    this.segments.push({ name, dur: now - this.last, desc });
    this.last = now;
    return this;
  }

  /** Records a segment measured elsewhere without moving the cursor. */
  add(name: string, dur: number, desc?: string) {
    this.segments.push({ name, dur, desc });
    return this;
  }

  get elapsed() {
    return performance.now() - this.t0;
  }

  header(totalName = "fn") {
    const all = [...this.segments, { name: totalName, dur: this.elapsed }];
    return all
      .map((s) => {
        const desc = s.desc ? `;desc="${s.desc.replace(/"/g, "")}"` : "";
        return `${s.name};dur=${s.dur.toFixed(2)}${desc}`;
      })
      .join(", ");
  }
}

/**
 * What this actually knows: whether this module instance has served a request
 * before, and how long ago it was loaded. That is not the same claim as "this
 * was a cold start", which would need the platform to say so, and this file
 * does not pretend to know it.
 */
let servedOne = false;
const loadedAt = Date.now();
const instanceId = Math.random().toString(36).slice(2, 10);

export function instanceState() {
  const firstOnInstance = !servedOne;
  servedOne = true;
  return { firstOnInstance, instanceId, instanceAgeMs: Date.now() - loadedAt };
}
