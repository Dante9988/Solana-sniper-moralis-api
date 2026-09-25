import type { PrismaClient } from "@prisma/client";
import { loadMoonPayConfig } from "./config";
import { MoonPayOrderService } from "./orderService";

/** Recover missed events even when the customer's browser is closed. Bounded, single-flight. */
export function startMoonPayRecovery(db: PrismaClient): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const config = loadMoonPayConfig();
      if (!config) return;
      const orders = await db.moonPayOrder.findMany({
        where: { environment: config.environment, OR: [{ status: { in: ["PENDING", "SUBMITTED", "UNCERTAIN"] } }, { status: "COMPLETED", cryptoTransactionId: null }] },
        orderBy: { lastReconciledAt: { sort: "asc", nulls: "first" } }, take: 20,
      });
      const service = new MoonPayOrderService(db, config);
      for (const order of orders) { if (stopped) break; await service.reconcile(order); }
    } catch {
      // Do not leak config keys or provider response bodies through background logs.
      console.error("[moonpay] recovery unavailable; will retry");
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
