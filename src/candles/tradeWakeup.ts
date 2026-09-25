import { Client } from "pg";

/** A notification is a coalesced wakeup, never a trade or a checkpoint. */
export function listenForTradeCommits(connectionString: string, wake: () => void, warn: (message: string) => void): () => Promise<void> {
  let stopped = false;
  let client: Client | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const connect = async () => {
    if (stopped) return;
    const next = new Client({ connectionString });
    client = next;
    const retry = () => {
      if (client !== next) return;
      client = null;
      void next.end().catch(() => undefined);
      if (!stopped && !timer) timer = setTimeout(() => { timer = null; void connect(); }, 1000);
    };
    next.on("error", () => { warn("Trade wakeup listener disconnected; reconciliation remains active"); retry(); });
    next.on("end", retry);
    next.on("notification", msg => { if (!stopped && msg.channel === "onlypump_canonical_trade") wake(); });
    try {
      await next.connect();
      await next.query("LISTEN onlypump_canonical_trade");
      if (stopped) await next.end();
      else wake(); // catch work committed before LISTEN, including reconnect gaps
    } catch { retry(); }
  };
  void connect();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    const current = client;
    client = null;
    await current?.end().catch(() => undefined);
  };
}
