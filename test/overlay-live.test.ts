import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import WebSocket from "ws";
import { gsx } from "../src/index.js";

// A REAL vite dev server: vite buffers an `error` payload sent while no client
// is connected and replays it to the next one, whatever happened since. The
// overlay must reflect the plugin's current error, never that buffer.
let server: ViteDevServer | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await server?.close();
  server = undefined;
});

async function startServer(): Promise<number> {
  server = await createServer({
    root: process.cwd(),
    logLevel: "silent",
    server: { port: 0 },
    plugins: gsx({ generateOnStart: false }),
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real net.Server address");
  }
  return address.port;
}

const post = (port: number, ev: unknown) =>
  fetch(`http://localhost:${port}/__gsx/event`, { method: "POST", body: JSON.stringify(ev) });

const errorEvent = (message: string) => ({
  event: "generated",
  ok: false,
  durationMs: 1,
  written: [],
  diagnostics: [
    { file: "app.gsx", severity: "error", message, range: { start: { line: 1, col: 1 }, end: { line: 1, col: 2 } } },
  ],
});
const okEvent = { event: "generated", ok: true, durationMs: 1, written: [], diagnostics: [] };
// Primes the status cache so gsx:status-request always gets a reply.
const statusEvent = { event: "status", phase: "idle", server: { healthy: true, port: "7777" } };

// A connected client recording every error message it receives.
async function connect(port: number): Promise<{ ws: WebSocket; errors: string[] }> {
  const errors: string[] = [];
  const ws = new WebSocket(`ws://localhost:${port}/`, "vite-hmr");
  sockets.push(ws);
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "error") errors.push(msg.err.message);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return { ws, errors };
}

// Frames on one socket arrive in order, so once the status reply is in,
// everything the server sent this client before it has arrived too.
function barrier(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.addEventListener("message", function onMsg(ev) {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "custom" && msg.event === "gsx:status") {
        ws.removeEventListener("message", onMsg);
        resolve();
      }
    });
    ws.send(JSON.stringify({ type: "custom", event: "gsx:status-request", data: {} }));
  });
}

describe("error overlay over a real HMR WebSocket", () => {
  it("does not show an error fixed before any client connected", async () => {
    const port = await startServer();
    await post(port, statusEvent);
    await post(port, errorEvent("stale"));
    await post(port, okEvent);

    const tab = await connect(port);
    await barrier(tab.ws);
    expect(tab.errors).toEqual([]);
  });

  it("shows the current error exactly once to a client that connects after it", async () => {
    const port = await startServer();
    await post(port, statusEvent);
    await post(port, errorEvent("first"));
    await post(port, errorEvent("current"));

    const tab = await connect(port);
    await barrier(tab.ws);
    expect(tab.errors).toEqual(["current"]);
  });

  it("sends a new error to connected clients", async () => {
    const port = await startServer();
    await post(port, statusEvent);
    const tab = await connect(port);
    await barrier(tab.ws);

    await post(port, errorEvent("live"));
    await barrier(tab.ws);
    expect(tab.errors).toEqual(["live"]);
  });
});
