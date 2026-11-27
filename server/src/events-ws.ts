import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { serve } from "@hono/node-server";
import type { Duplex } from "node:stream";
import type { HobEvent } from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";
import { validCookie } from "./http.ts";

const HEARTBEAT_MS = 25_000;

export interface UpgradeEndpoint {
  handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}

export function createEventsUpgrade(runtime: HobRuntime): UpgradeEndpoint {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const handle = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pendingError = () => undefined;
    socket.on("error", pendingError);
    const reject = (status: string) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const cookie = req.headers.cookie?.split(";").map((s) => s.trim()).find((s) => s.startsWith("hob="))?.slice(4);
    if (!validCookie(runtime.config, cookie)) return reject("401 Unauthorized");
    const origin = req.headers.origin;
    const forwardedHeader = req.headers["x-forwarded-host"];
    const forwardedHost = (Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader)?.split(",")[0].trim();
    try { if (origin && ![req.headers.host, forwardedHost].includes(new URL(origin).host)) return reject("403 Forbidden"); }
    catch { return reject("403 Forbidden"); }
    const clientId = requestUrl.searchParams.get("clientId") ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("error", pendingError);
      const detach = runtime.push.attachClient(clientId);
      const unsubscribe = runtime.bus.subscribe((event: HobEvent) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event), () => undefined);
      });
      let alive = true;
      ws.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; }
        alive = false;
        ws.ping();
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        detach();
      };
      ws.on("close", cleanup);
      ws.on("error", () => ws.close());
    });
  };
  return {
    handle,
    close: () => { for (const client of wss.clients) client.terminate(); wss.close(); },
  };
}

export function attachEventsWebSocket(server: ReturnType<typeof serve>, runtime: HobRuntime): () => void {
  const endpoint = createEventsUpgrade(runtime);
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { return; }
    if (pathname !== "/api/events/ws") return;
    endpoint.handle(req, socket, head);
  };
  server.on("upgrade", upgrade);
  return () => { server.off("upgrade", upgrade); endpoint.close(); };
}
