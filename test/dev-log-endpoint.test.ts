import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, promises as fsp } from "node:fs";
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

// /__gsx/log is registered from configureServer's returned post-hook (see
// src/index.ts), not synchronously — mirrors how vite itself drives plugins:
// invoke the returned function once configureServer has run.
function configure(plugin: any, server: any) {
  const postHook = plugin.configureServer(server);
  if (typeof postHook === "function") postHook();
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
    configure(gsx()[0] as any, s);
    expect(s.handlers["/__gsx/log"]).toBeUndefined();
  });

  it("is absent with devLog: false even when the env var is set", () => {
    process.env.GSX_DEV_LOG = "/tmp/whatever.log";
    const s = fakeServer();
    configure(gsx({ devLog: false })[0] as any, s);
    expect(s.handlers["/__gsx/log"]).toBeUndefined();
  });

  it("serves the log named by GSX_DEV_LOG, tail-capped, with a start offset header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsx-devlog-"));
    const logPath = join(dir, "dev.log");
    writeFileSync(logPath, "hello backend\nline two\n");
    process.env.GSX_DEV_LOG = logPath;
    const s = fakeServer();
    configure(gsx()[0] as any, s);
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
    configure(gsx({ devLog: "custom.log" })[0] as any, s);
    const { res } = await get(s.handlers["/__gsx/log"]!);
    expect(res.statusCode).toBe(200);
    expect(res.end.mock.calls[0][0].toString()).toBe("custom");
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors bytesRead across a stat->read truncation race instead of serving NUL padding", async () => {
    // Reproduces the exact race: gsx dev restarts truncate+rewrite [dev].log
    // via os.Create between the handler's stat() and read() calls. We
    // monkey-patch fsp.open so the wrapped handle's first stat() call
    // truncates the real file as a side effect right after reading its
    // (soon-stale) size — the handler then reads against a real, already-
    // shrunk file, exactly like the live race.
    const dir = mkdtempSync(join(tmpdir(), "gsx-devlog-race-"));
    const logPath = join(dir, "dev.log");
    writeFileSync(logPath, "0123456789"); // 10 bytes
    process.env.GSX_DEV_LOG = logPath;

    const realOpen = fsp.open;
    let statCalls = 0;
    const openSpy = vi.spyOn(fsp, "open").mockImplementation(async (...args: any[]): Promise<any> => {
      const real = await (realOpen as any)(...args);
      return {
        stat: async () => {
          const result = await real.stat();
          statCalls++;
          if (statCalls === 1) {
            // The race: something else truncates + rewrites the file right
            // after this stat resolves (gsx dev's os.Create on restart).
            writeFileSync(logPath, "ab");
          }
          return result;
        },
        read: (...a: any[]) => real.read(...a),
        close: () => real.close(),
      };
    });

    try {
      const s = fakeServer();
      configure(gsx()[0] as any, s);
      const h = s.handlers["/__gsx/log"]!;

      const { res, headers } = await get(h);
      expect(res.statusCode).toBe(200);
      const body = res.end.mock.calls[0][0] as Buffer;
      // Must be exactly the post-truncation content — no NUL padding out to
      // the pre-race (stale, larger) size.
      expect(body.toString()).toBe("ab");
      expect(body.length).toBe(2);
      // Coherent with the file actually served: offset 0 of a 2-byte file.
      expect(headers["x-gsx-log-start"]).toBe("0");
    } finally {
      openSpy.mockRestore();
      delete process.env.GSX_DEV_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recomputes a coherent x-gsx-log-start (not the stale pre-race offset) when a tail request races a shrink", async () => {
    // Same race, but with a `tail` narrow enough that the pre-race start is
    // non-zero (5) — proving the offset is recomputed against the file's
    // post-race size, not left pointing at a position past the new EOF.
    const dir = mkdtempSync(join(tmpdir(), "gsx-devlog-race2-"));
    const logPath = join(dir, "dev.log");
    writeFileSync(logPath, "0123456789"); // 10 bytes; tail=5 -> stale start=5
    process.env.GSX_DEV_LOG = logPath;

    const realOpen = fsp.open;
    let statCalls = 0;
    const openSpy = vi.spyOn(fsp, "open").mockImplementation(async (...args: any[]): Promise<any> => {
      const real = await (realOpen as any)(...args);
      return {
        stat: async () => {
          const result = await real.stat();
          statCalls++;
          if (statCalls === 1) writeFileSync(logPath, "ab"); // shrinks to 2 bytes
          return result;
        },
        read: (...a: any[]) => real.read(...a),
        close: () => real.close(),
      };
    });

    try {
      const s = fakeServer();
      configure(gsx()[0] as any, s);
      const h = s.handlers["/__gsx/log"]!;

      const { res, headers } = await get(h, "/?tail=5");
      expect(res.statusCode).toBe(200);
      const body = res.end.mock.calls[0][0] as Buffer;
      expect(body.toString()).toBe("ab");
      // The stale pre-race start (5) is past the new 2-byte file's EOF —
      // coherent reporting recomputes against the post-race size (0).
      expect(headers["x-gsx-log-start"]).toBe("0");
    } finally {
      openSpy.mockRestore();
      delete process.env.GSX_DEV_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("400s a malformed ?tail= instead of silently coercing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsx-devlog-tail-"));
    const logPath = join(dir, "dev.log");
    writeFileSync(logPath, "0123456789");
    process.env.GSX_DEV_LOG = logPath;
    try {
      const s = fakeServer();
      configure(gsx()[0] as any, s);
      const h = s.handlers["/__gsx/log"]!;

      // Fractional: floor-after-check used to let this through as tail=0.
      expect((await get(h, "/?tail=0.5")).res.statusCode).toBe(400);
      // Negative: no valid tail is negative.
      expect((await get(h, "/?tail=-5")).res.statusCode).toBe(400);
      // Non-numeric.
      expect((await get(h, "/?tail=abc")).res.statusCode).toBe(400);
      // Scientific notation — Number() would accept it; the integer-literal
      // regex must not.
      expect((await get(h, "/?tail=1e3")).res.statusCode).toBe(400);

      // A plain non-negative integer, including 0, is honored.
      const zero = await get(h, "/?tail=0");
      expect(zero.res.statusCode).toBe(200);
      expect(zero.res.end.mock.calls[0][0].toString()).toBe("");
      expect(zero.headers["x-gsx-log-start"]).toBe("10");
    } finally {
      delete process.env.GSX_DEV_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims leading UTF-8 continuation bytes at a mid-character tail cut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsx-devlog-utf8-"));
    const logPath = join(dir, "dev.log");
    const content = "héllo"; // 'é' is 2 bytes (0xC3 0xA9); full buffer is 6 bytes
    writeFileSync(logPath, content, "utf8");
    process.env.GSX_DEV_LOG = logPath;
    try {
      const s = fakeServer();
      configure(gsx()[0] as any, s);
      const h = s.handlers["/__gsx/log"]!;

      // Byte layout: h(1) c3(1) a9(1) l l o -> 6 bytes total.
      // tail=4 cuts at byte offset 2, landing mid-'é' on its continuation
      // byte (0xA9) — must be trimmed forward to the next rune boundary.
      const { res, headers } = await get(h, "/?tail=4");
      expect(res.statusCode).toBe(200);
      const body = res.end.mock.calls[0][0] as Buffer;
      expect(body.toString("utf8")).toBe("llo");
      expect(headers["x-gsx-log-start"]).toBe(String(Buffer.byteLength(content) - 3));
    } finally {
      delete process.env.GSX_DEV_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('devLog: "" is disabled, not an EISDIR 500 from resolving to the root directory', () => {
    delete process.env.GSX_DEV_LOG;
    const s = fakeServer();
    configure(gsx({ devLog: "" })[0] as any, s);
    expect(s.handlers["/__gsx/log"]).toBeUndefined();
  });
});
