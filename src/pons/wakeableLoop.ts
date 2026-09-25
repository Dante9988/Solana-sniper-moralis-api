/** Bounded scheduler: one in-flight tick, one pending wake, at most one start/sec. */
export class WakeableLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private pending = false;
  private lastStart = 0;
  private blockedUntil = 0;
  constructor(private readonly tick: () => Promise<{ delay: number; failed: boolean }>, private readonly minIntervalMs = 1000) {}
  start(): void { this.schedule(0); }
  wake(): void {
    if (this.stopped) return;
    this.pending = true;
    if (this.running) return;
    this.schedule(Math.max(0, this.lastStart + this.minIntervalMs - Date.now(), this.blockedUntil - Date.now()));
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }
  private async run(): Promise<void> {
    if (this.stopped || this.running) return;
    this.timer = null;
    this.running = true; this.pending = false; this.lastStart = Date.now();
    let result = { delay: 5000, failed: true };
    try { result = await this.tick(); } finally {
      this.running = false;
      this.blockedUntil = result.failed ? Date.now() + result.delay : 0;
      if (this.pending && !result.failed) this.wake();
      else this.schedule(result.delay);
    }
  }
}
