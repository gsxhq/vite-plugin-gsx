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

describe("cmdMiddleware — GSX_DEV_TOKEN pairing", () => {
  const TOKEN = "abc123deadbeef";
  let tchan: PanelChannel;
  let tsrv: Server;
  let tbase: string;

  beforeEach(async () => {
    tchan = new PanelChannel({ warn: () => {} }, () => {}, TOKEN);
    tsrv = createServer((req, res) => tchan.cmdMiddleware(req, res));
    await new Promise<void>((r) => tsrv.listen(0, r));
    const addr = tsrv.address() as { port: number };
    tbase = `http://localhost:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise((r) => tsrv.close(r));
  });

  it("echoes the token (not \"1\") on a correctly-authenticated request", async () => {
    const resp = await fetch(`${tbase}/?wait=0`, { headers: { "x-gsx-token": TOKEN } });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("x-gsx")).toBe(TOKEN);
  });

  it("403s a request with no x-gsx-token header, still echoing the token", async () => {
    const resp = await fetch(`${tbase}/?wait=0`);
    expect(resp.status).toBe(403);
    expect(resp.headers.get("x-gsx")).toBe(TOKEN);
  });

  it("403s a request with the wrong x-gsx-token header, still echoing the token", async () => {
    const resp = await fetch(`${tbase}/?wait=0`, { headers: { "x-gsx-token": "some-other-token" } });
    expect(resp.status).toBe(403);
    expect(resp.headers.get("x-gsx")).toBe(TOKEN);
  });

  it("returns intaken commands as JSON when the token matches", async () => {
    tchan.intake({ cmd: "rebuild" });
    const resp = await fetch(`${tbase}/?wait=5`, { headers: { "x-gsx-token": TOKEN } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-gsx")).toBe(TOKEN);
    expect(await resp.json()).toEqual({ cmds: ["rebuild"] });
  });

  it("a rejected (bad-token) request does not drain or displace the mailbox", async () => {
    tchan.intake({ cmd: "restart-server" });
    // Wrong-token hit: must be rejected before touching the mailbox.
    const rejected = await fetch(`${tbase}/?wait=0`, { headers: { "x-gsx-token": "nope" } });
    expect(rejected.status).toBe(403);
    // The queued command must still be there for the correctly-authenticated poller.
    const ok = await fetch(`${tbase}/?wait=5`, { headers: { "x-gsx-token": TOKEN } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ cmds: ["restart-server"] });
  });

  it("a rejected request does not displace an already-hanging authenticated poller", async () => {
    const pending = fetch(`${tbase}/?wait=10`, { headers: { "x-gsx-token": TOKEN } });
    await new Promise((r) => setTimeout(r, 50));
    // A bad-token hit while a legit long-poll is hanging must not resolve/displace it.
    const rejected = await fetch(`${tbase}/?wait=0`, { headers: { "x-gsx-token": "nope" } });
    expect(rejected.status).toBe(403);
    tchan.intake({ cmd: "rebuild" });
    const resp = await pending;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ cmds: ["rebuild"] });
  });
});

describe("cmdMiddleware — untokened channel (no GSX_DEV_TOKEN)", () => {
  it("ignores a stray x-gsx-token header — same behavior as no header at all", async () => {
    const resp = await fetch(`${base}/?wait=0`, { headers: { "x-gsx-token": "whatever" } });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("x-gsx")).toBe("1");
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

describe("handleStatusRequest", () => {
  const status = { event: "status", phase: "building", server: { healthy: true, port: "7777" }, frontDoor: { state: "up", restarts: 0 } };

  it("sends the cached status to the requesting client only (not a broadcast)", () => {
    chan.applyStatus(status);
    const received: string[] = [];
    const client = { send: (p: string) => received.push(p) };
    chan.handleStatusRequest(client);
    expect(received).toEqual([JSON.stringify({ type: "custom", event: "gsx:status", data: status })]);
    // Only the targeted client got it — the broadcast spy from `chan`'s
    // constructor (pushed into `sent`) only has the original applyStatus
    // broadcast, not a second one from this pull.
    expect(sent).toEqual([{ type: "custom", event: "gsx:status", data: status }]);
  });

  it("is a no-op (nothing sent, no crash) before any status has ever arrived", () => {
    const received: string[] = [];
    const client = { send: (p: string) => received.push(p) };
    chan.handleStatusRequest(client);
    expect(received).toEqual([]);
  });
});
