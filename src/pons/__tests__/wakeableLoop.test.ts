import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeableLoop } from "../wakeableLoop";
afterEach(() => vi.useRealTimers());
describe("wakeable ingestion scheduling", () => {
  it("coalesces a head burst, never overlaps ticks, and enforces the start budget", async () => {
    vi.useFakeTimers();
    let finish!: (r: {delay:number;failed:boolean})=>void;
    const tick = vi.fn(() => new Promise<{delay:number;failed:boolean}>(resolve => { finish=resolve; }));
    const loop = new WakeableLoop(tick); loop.start();
    await vi.advanceTimersByTimeAsync(1);
    for(let i=0;i<100;i++) loop.wake();
    expect(tick).toHaveBeenCalledTimes(1);
    finish({delay:5000,failed:false}); await vi.advanceTimersByTimeAsync(998);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(2);
    loop.stop(); finish({delay:5000,failed:false});
  });
  it("headers do not bypass provider-failure backoff", async () => {
    vi.useFakeTimers();
    const tick=vi.fn(async()=>({delay:5000,failed:true}));
    const loop=new WakeableLoop(tick); loop.start(); await vi.advanceTimersByTimeAsync(1);
    for(let i=0;i<4;i++){loop.wake();await vi.advanceTimersByTimeAsync(1000);}
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);expect(tick).toHaveBeenCalledTimes(2);loop.stop();
  });
});
