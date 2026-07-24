import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { gsx } from "../src/index.js";

// A REAL vite dev server (real HTTP + real HMR WebSocket upgrade — not a
// fakeServer/wsHandlers stand-in) driven by a REAL WebSocket client speaking
// vite's actual "vite-hmr" subprotocol and wire format. This is the only way
// to catch the class of bug the fakes structurally can't: vite's per-client
// `.send` is overloaded (`.send(payload)` vs `.send(event, data?)`), and a
// hand-rolled fake that doesn't reproduce that overload dispatch will accept
// a caller that gets the argument shape wrong. See panel.test.ts's and
// event-endpoint.test.ts's `fakeWrappedClient()` for the fixed unit-level
// mocks — this test is the end-to-end backstop above them.
let server: ViteDevServer | undefined;
let socket: WebSocket | undefined;

afterEach(async () => {
  socket?.close();
  socket = undefined;
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

// Connects a real WebSocket to vite's HMR endpoint, waits past the initial
// `{"type":"connected"}` handshake frame every vite client receives, and
// resolves once genuinely ready to send/receive application messages.
function connectHmr(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/`, "vite-hmr");
    ws.addEventListener("error", reject);
    ws.addEventListener("message", function onFirst(ev) {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "connected") {
        ws.removeEventListener("message", onFirst);
        resolve(ws);
      }
    });
  });
}

function nextCustomEvent(ws: WebSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => {
    ws.addEventListener("message", function onMsg(ev) {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "custom" && msg.event === event) {
        ws.removeEventListener("message", onMsg);
        resolve(msg.data);
      }
    });
  });
}

describe("gsx:status-request over a real HMR WebSocket", () => {
  it("replies with a correctly-shaped gsx:status custom-event frame, not the mis-nested one the raw-send bug produced", async () => {
    const port = await startServer();

    // Prime the cache the same way gsx dev would, over a real HTTP POST.
    const primed = await fetch(`http://localhost:${port}/__gsx/event`, {
      method: "POST",
      body: JSON.stringify({
        event: "status",
        phase: "building",
        server: { healthy: true, port: "7777" },
        frontDoor: { state: "up", restarts: 0 },
      }),
    });
    expect(primed.status).toBe(204);

    socket = await connectHmr(port);
    const reply = nextCustomEvent(socket, "gsx:status");

    // Exactly what client.ts's real `hot.send("gsx:status-request", {})`
    // produces on the wire (vite's browser client: `hmrClient.send({type:
    // "custom", event, data})` → `ws.send(JSON.stringify(...))`).
    socket.send(JSON.stringify({ type: "custom", event: "gsx:status-request", data: {} }));

    const data = await reply;
    expect(data).toEqual({
      event: "status",
      phase: "building",
      server: { healthy: true, port: "7777" },
      frontDoor: { state: "up", restarts: 0 },
    });
  });

  it("is a silent no-op before any status has ever been posted (no frame, no crash)", async () => {
    const port = await startServer();
    socket = await connectHmr(port);

    let sawAnyMessage = false;
    socket.addEventListener("message", () => {
      sawAnyMessage = true;
    });
    socket.send(JSON.stringify({ type: "custom", event: "gsx:status-request", data: {} }));

    // Nothing to await for a negative case — give the server a tick to have
    // (not) replied, then confirm silence.
    await new Promise((r) => setTimeout(r, 200));
    expect(sawAnyMessage).toBe(false);
  });
});
