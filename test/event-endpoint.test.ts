import { describe, it, expect, vi } from "vitest";
import { gsx } from "../src/index.js";

// Minimal fake Vite dev server capturing ws.send + middleware registration.
function fakeServer() {
  const handlers: Record<string, Function> = {};
  const wsHandlers: Record<string, Function> = {};
  const sent: any[] = [];
  const errors: string[] = [];
  return {
    sent,
    errors,
    config: {
      root: process.cwd(),
      logger: {
        error: vi.fn((msg: string) => errors.push(msg)),
        info: vi.fn(),
      },
    },
    middlewares: { use: (path: string, fn: Function) => (handlers[path] = fn) },
    ws: {
      send: (msg: any) => sent.push(msg),
      on: (event: string, fn: Function) => (wsHandlers[event] = fn),
    },
    httpServer: { on: () => {} },
    handlers,
    wsHandlers,
  };
}

function call(handler: Function, body: any) {
  const req: any = { method: "POST" };
  const chunks: Buffer[] = [];
  req.on = (ev: string, cb: any) => {
    if (ev === "data") cb(Buffer.from(JSON.stringify(body)));
    if (ev === "end") cb();
    return req;
  };
  const res: any = { statusCode: 0, end: vi.fn() };
  return Promise.resolve(handler(req, res)).then(() => res);
}

describe("/__gsx/event", () => {
  it("does NOT spawn a daemon by default and registers the event endpoint", () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);
    expect(s.handlers["/__gsx/event"]).toBeTypeOf("function");
  });

  it("sends an error overlay on ok:false, then clears on ok:true", async () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);
    const h = s.handlers["/__gsx/event"]!;

    await call(h, {
      event: "generated",
      ok: false,
      durationMs: 1,
      written: [],
      diagnostics: [
        {
          file: "app.gsx",
          range: { start: { line: 3, col: 5 }, end: { line: 3, col: 9 } },
          severity: "error",
          message: "boom",
        },
      ],
    });
    expect(s.sent.some((m) => m.type === "error")).toBe(true);

    s.sent.length = 0;
    await call(h, { event: "generated", ok: true, durationMs: 1, written: ["a.x.go"], diagnostics: [] });
    // ok-after-error does not itself reload (gsx dev posts /__reload); it just
    // resets the latch. No new error overlay is sent.
    expect(s.sent.some((m) => m.type === "error")).toBe(false);
  });

  it("logs diagnostics with one header format and indented details", async () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);
    const h = s.handlers["/__gsx/event"]!;

    await call(h, {
      event: "generated",
      ok: false,
      durationMs: 1,
      written: [],
      diagnostics: [
        {
          file: "build",
          range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
          severity: "error",
          message: "# hello-gsx\n./main.go:69:2: undefined: hello",
        },
        {
          file: "/Users/jackieli/personal/hello-gsx/main.go",
          range: { start: { line: 69, col: 2 }, end: { line: 69, col: 7 } },
          severity: "error",
          message: "undefined: hello",
        },
      ],
    });

    expect(s.errors).toEqual([
      "[gsx] error build",
      "[gsx]   # hello-gsx",
      "[gsx]   ./main.go:69:2: undefined: hello",
      "[gsx] error /Users/jackieli/personal/hello-gsx/main.go",
      "[gsx]   undefined: hello",
    ]);
  });

  it("does not repeat identical diagnostic logs until recovery", async () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);
    const h = s.handlers["/__gsx/event"]!;
    const ev = {
      event: "generated",
      ok: false,
      durationMs: 1,
      written: [],
      diagnostics: [
        {
          file: "/Users/jackieli/personal/hello-gsx/main.go",
          range: { start: { line: 69, col: 2 }, end: { line: 69, col: 7 } },
          severity: "error",
          message: "undefined: hello",
        },
      ],
    };

    await call(h, ev);
    s.errors.length = 0;
    await call(h, ev);
    expect(s.errors).toEqual([]);

    await call(h, {
      event: "generated",
      ok: true,
      durationMs: 1,
      written: ["a.x.go"],
      diagnostics: [],
    });
    await call(h, ev);
    expect(s.errors).toEqual([
      "[gsx] error /Users/jackieli/personal/hello-gsx/main.go",
      "[gsx]   undefined: hello",
    ]);
  });

  it("suppresses follow-up build logs while a source diagnostic is current", async () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);
    const h = s.handlers["/__gsx/event"]!;

    await call(h, {
      event: "generated",
      ok: false,
      durationMs: 1,
      written: [],
      diagnostics: [
        {
          file: "/Users/jackieli/personal/hello-gsx/main.go",
          range: { start: { line: 69, col: 2 }, end: { line: 69, col: 7 } },
          severity: "error",
          message: "undefined: hello",
        },
      ],
    });

    s.errors.length = 0;
    s.sent.length = 0;
    await call(h, {
      event: "generated",
      ok: false,
      durationMs: 1,
      written: [],
      diagnostics: [
        {
          file: "build",
          range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
          severity: "error",
          message: "# hello-gsx\n./main.go:69:2: undefined: hello",
        },
      ],
    });

    expect(s.errors).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it("replays the current error overlay to newly connected clients", async () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);
    const h = s.handlers["/__gsx/event"]!;

    await call(h, {
      event: "generated",
      ok: false,
      durationMs: 1,
      written: [],
      diagnostics: [
        {
          file: "app.gsx",
          range: { start: { line: 3, col: 5 }, end: { line: 3, col: 9 } },
          severity: "error",
          message: "boom",
        },
      ],
    });

    const clientSent: any[] = [];
    s.wsHandlers.connection!({ send: (msg: any) => clientSent.push(msg) });
    expect(clientSent.some((m) => JSON.parse(m).type === "error")).toBe(true);

    await call(h, {
      event: "generated",
      ok: true,
      durationMs: 1,
      written: ["a.x.go"],
      diagnostics: [],
    });

    clientSent.length = 0;
    s.wsHandlers.connection!({ send: (msg: any) => clientSent.push(msg) });
    expect(clientSent.some((m) => JSON.parse(m).type === "error")).toBe(false);
  });
});

describe("gsx:status-request", () => {
  // Fixes a real race: vite's HMR client drops custom events that arrive
  // before a listener is registered, and the panel's own `gsx:status`
  // listener registration races the ws handshake during module load. This
  // pull (sent by the panel right after it registers its listener) targets
  // only the requesting client, complementing (not replacing) the
  // connection-time replay covered above.
  it("replies to the requesting client with the cached status, not a broadcast", async () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);

    // Cache a status the same way gsx dev would: through /__gsx/event.
    await call(s.handlers["/__gsx/event"]!, {
      event: "status",
      phase: "building",
      server: { healthy: true, port: "7777" },
      frontDoor: { state: "up", restarts: 0 },
    });
    s.sent.length = 0;

    const clientSent: any[] = [];
    const client = { send: (msg: any) => clientSent.push(msg) };
    expect(s.wsHandlers["gsx:status-request"]).toBeTypeOf("function");
    s.wsHandlers["gsx:status-request"]!({}, client);

    expect(clientSent.length).toBe(1);
    const parsed = JSON.parse(clientSent[0]);
    expect(parsed).toEqual({
      type: "custom",
      event: "gsx:status",
      data: { event: "status", phase: "building", server: { healthy: true, port: "7777" }, frontDoor: { state: "up", restarts: 0 } },
    });
    // Targeted, not broadcast: server.ws.send (the broadcast channel) saw nothing new.
    expect(s.sent).toEqual([]);
  });

  it("is a no-op before any status has ever arrived (no crash, nothing sent)", () => {
    const p = gsx();
    const s = fakeServer();
    (p[0] as any).configureServer(s);

    const clientSent: any[] = [];
    s.wsHandlers["gsx:status-request"]!({}, { send: (msg: any) => clientSent.push(msg) });
    expect(clientSent).toEqual([]);
  });
});
