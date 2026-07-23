import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { PanelChannel } from "../src/panel.js";

let warns: string[];
let sent: any[];
let chan: PanelChannel;
let srv: Server;
let base: string;

beforeEach(async () => {
  warns = [];
  sent = [];
  chan = new PanelChannel(
    { warn: (m: string) => warns.push(m) },
    (p) => sent.push(p),
  );
  srv = createServer((req, res) => chan.cmdMiddleware(req, res));
  await new Promise<void>((r) => srv.listen(0, r));
  const addr = srv.address() as { port: number };
  base = `http://localhost:${addr.port}`;
});

afterEach(async () => {
  await new Promise((r) => srv.close(r));
});

describe("cmdMiddleware", () => {
  it("204 + x-gsx header when idle", async () => {
    const resp = await fetch(`${base}/?wait=0`);
    expect(resp.status).toBe(204);
    expect(resp.headers.get("x-gsx")).toBe("1");
  });

  it("returns intaken commands as JSON, x-gsx stamped", async () => {
    chan.intake({ cmd: "rebuild" });
    const resp = await fetch(`${base}/?wait=5`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-gsx")).toBe("1");
    expect(await resp.json()).toEqual({ cmds: ["rebuild"] });
  });

  it("resolves a hanging poll when a command arrives", async () => {
    const pending = fetch(`${base}/?wait=10`);
    await new Promise((r) => setTimeout(r, 50));
    chan.intake({ cmd: "restart-server" });
    const resp = await pending;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ cmds: ["restart-server"] });
  });

  it("rejects non-GET with 405 (still stamped)", async () => {
    const resp = await fetch(`${base}/`, { method: "POST" });
    expect(resp.status).toBe(405);
    expect(resp.headers.get("x-gsx")).toBe("1");
  });
});

describe("intake validation", () => {
  it("drops unknown commands with a warning", async () => {
    chan.intake({ cmd: "rm-rf" });
    chan.intake("garbage");
    chan.intake(null);
    expect(warns.length).toBe(3);
    const resp = await fetch(`${base}/?wait=0`);
    expect(resp.status).toBe(204); // nothing queued
  });
});

describe("status", () => {
  const status = { event: "status", phase: "idle", server: { healthy: true, port: "7777" }, frontDoor: { state: "up", restarts: 0 } };

  it("applyStatus caches, broadcasts, and claims the event", () => {
    expect(chan.applyStatus(status)).toBe(true);
    expect(sent).toEqual([{ type: "custom", event: "gsx:status", data: status }]);
    const replay = JSON.parse(chan.replayPayload()!);
    expect(replay).toEqual({ type: "custom", event: "gsx:status", data: status });
  });

  it("ignores non-status events and replays null before any status", () => {
    expect(chan.applyStatus({ event: "generated", ok: true })).toBe(false);
    expect(chan.applyStatus(null)).toBe(false);
    expect(chan.replayPayload()).toBeNull();
    expect(sent).toEqual([]);
  });
});
