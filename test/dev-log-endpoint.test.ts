import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsx } from "../src/index.js";

// Same minimal fake server as event-endpoint.test.ts.
function fakeServer() {
  const handlers: Record<string, Function> = {};
  return {
    config: {
      root: process.cwd(),
      logger: { error: vi.fn(), info: vi.fn() },
    },
    middlewares: { use: (path: string, fn: Function) => (handlers[path] = fn) },
    ws: { send: vi.fn(), on: vi.fn() },
    httpServer: { on: () => {} },
    handlers,
  };
}

function get(handler: Function, url = "/") {
  const req: any = { method: "GET", url };
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 0,
    setHeader: (k: string, v: string) => (headers[k] = v),
    end: vi.fn(),
  };
  return Promise.resolve(handler(req, res)).then(() => ({ res, headers }));
}

const savedEnv = process.env.GSX_DEV_LOG;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.GSX_DEV_LOG;
  else process.env.GSX_DEV_LOG = savedEnv;
});

describe("/__gsx/log", () => {
  it("is absent without GSX_DEV_LOG or the devLog option", () => {
    delete process.env.GSX_DEV_LOG;
    const s = fakeServer();
    (gsx()[0] as any).configureServer(s);
    expect(s.handlers["/__gsx/log"]).toBeUndefined();
  });

  it("is absent with devLog: false even when the env var is set", () => {
    process.env.GSX_DEV_LOG = "/tmp/whatever.log";
    const s = fakeServer();
    (gsx({ devLog: false })[0] as any).configureServer(s);
    expect(s.handlers["/__gsx/log"]).toBeUndefined();
  });

  it("serves the log named by GSX_DEV_LOG, tail-capped, with a start offset header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsx-devlog-"));
    const logPath = join(dir, "dev.log");
    writeFileSync(logPath, "hello backend\nline two\n");
    process.env.GSX_DEV_LOG = logPath;
    const s = fakeServer();
    (gsx()[0] as any).configureServer(s);
    const h = s.handlers["/__gsx/log"]!;

    const full = await get(h);
    expect(full.res.statusCode).toBe(200);
    expect(full.headers["content-type"]).toContain("text/plain");
    expect(full.headers["x-gsx-log-start"]).toBe("0");
    expect(full.res.end.mock.calls[0][0].toString()).toBe("hello backend\nline two\n");

    // ?tail=9 returns only the last 9 bytes and reports the offset.
    const tail = await get(h, "/?tail=9");
    expect(tail.res.end.mock.calls[0][0].toString()).toBe("line two\n");
    expect(tail.headers["x-gsx-log-start"]).toBe(String("hello backend\nline two\n".length - 9));

    // Non-GET is rejected.
    const post: any = { method: "POST", url: "/" };
    const postRes: any = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await h(post, postRes);
    expect(postRes.statusCode).toBe(405);

    // Missing file (log not yet created) is a 404, not a crash.
    rmSync(logPath);
    const gone = await get(h);
    expect(gone.res.statusCode).toBe(404);

    rmSync(dir, { recursive: true, force: true });
  });

  it("devLog option overrides the env var and resolves against root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsx-devlog-"));
    writeFileSync(join(dir, "custom.log"), "custom");
    process.env.GSX_DEV_LOG = "/nonexistent/env.log";
    const s = fakeServer();
    s.config.root = dir;
    (gsx({ devLog: "custom.log" })[0] as any).configureServer(s);
    const { res } = await get(s.handlers["/__gsx/log"]!);
    expect(res.statusCode).toBe(200);
    expect(res.end.mock.calls[0][0].toString()).toBe("custom");
    rmSync(dir, { recursive: true, force: true });
  });
});
