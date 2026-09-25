import { WebSocket } from "ws";
import { resolveWsEndpoints } from "./rpcEndpoints";

/** Headers are scheduling hints only. HTTP range validation owns every canonical write. */
export function startHeadWakeup(wake: () => void, log: (message: string) => void, env = process.env): () => void {
  const endpoints = resolveWsEndpoints(env);
  if (!endpoints.length || env.PONS_HEAD_WAKEUP === "false") return () => undefined;
  let stopped = false, index = 0, attempt = 0;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFrame = Date.now();
  const connect = () => {
    if (stopped) return;
    const endpoint = endpoints[index % endpoints.length];
    const ws = new WebSocket(endpoint.url, { handshakeTimeout: 5000, maxPayload: 256_000 });
    socket = ws; lastFrame = Date.now();
    let subscription: string | null = null;
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })));
    ws.on("message", raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.id === 1) {
          if (m.result !== "0x1237") { ws.close(); return; }
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
        } else if (m.id === 2) {
          if (typeof m.result !== "string") { ws.close(); return; }
          subscription = m.result;
          log(`head wakeup subscribed via ${endpoint.label}; canonical ingestion remains checkpointed HTTP`);
          wake();
        } else if (m.method === "eth_subscription" && m.params?.subscription === subscription && /^0x[0-9a-f]+$/i.test(m.params?.result?.number ?? "")) {
          lastFrame = Date.now(); attempt = 0; wake();
        }
      } catch { /* malformed headers cannot affect canonical state */ }
    });
    ws.on("error", () => ws.terminate()); // never log the credential-bearing URL
    ws.on("close", () => {
      if (stopped || socket !== ws) return;
      socket = null; index++;
      log(`head wakeup disconnected from ${endpoint.label}; HTTP polling continues`);
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)));
    });
  };
  const health = setInterval(() => { if (Date.now() - lastFrame > 30_000) socket?.terminate(); }, 5000);
  connect();
  return () => { stopped = true; clearInterval(health); if (timer) clearTimeout(timer); socket?.terminate(); };
}
