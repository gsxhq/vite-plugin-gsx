import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer as createHttp, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import {
  devFallback,
  backendUp,
  readLogTail,
  serveBackendDown,
  type DevFallback,
} from "../src/dev-fallback.js";

// fakeUpstream starts an http server answering /healthz with the given status.
function fakeUpstream(status: number): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createHttp((req, res) => {
      if (req.url === "/healthz") {
        res.statusCode = status;
        res.end("ok");
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ url: `http://localhost:${port}`, close: () => srv.close() });
    });
  });
}

describe("backendUp", () => {
  it("true when healthz is 200", async () => {
    const up = await fakeUpstream(200);
    expect(await backendUp(up.url)).toBe(true);
    up.close();
  });
  it("false when healthz is 503", async () => {
    const up = await fakeUpstream(503);
    expect(await backendUp(up.url)).toBe(false);
    up.close();
  });
  it("true when healthz is 404 (reachable, < 500)", async () => {
    const up = await fakeUpstream(404);
    expect(await backendUp(up.url)).toBe(true);
    up.close();
  });
  it("false when the upstream is unreachable", async () => {
    expect(await backendUp("http://localhost:1")).toBe(false);
  });
});

describe("readLogTail", () => {
  it("returns the tail of the log file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsxlog-"));
    const f = join(dir, "dev.log");
    writeFileSync(f, "line1\nline2\nBOOT ERROR xyz\n");
    expect(readLogTail(f)).toContain("BOOT ERROR xyz");
  });
  it("returns a note when the file is missing", () => {
    expect(readLogTail("/no/such/file.log")).toContain("unavailable");
  });
});

describe("serveBackendDown", () => {
  it("writes 503 + HTML to an HTTP response", () => {
    let status = 0;
    let body = "";
    const res: any = {
      headersSent: false,
      writeHead(s: number) { status = s; },
      end(s: string) { body = s; },
    };
    serveBackendDown(res, "<html>INTERSTITIAL</html>");
    expect(status).toBe(503);
    expect(body).toContain("INTERSTITIAL");
  });
  it("destroys a socket-like response (no writeHead)", () => {
    let destroyed = false;
    const sock: any = { destroy() { destroyed = true; } };
    serveBackendDown(sock, "<html></html>");
    expect(destroyed).toBe(true);
  });
});

describe("devFallback factory", () => {
  let upstream: { url: string; close: () => void };
  let server: ViteDevServer;
  let http: Server | undefined;
  beforeEach(async () => {
    upstream = await fakeUpstream(200);
  });
  afterEach(async () => {
    http?.close();
    await server?.close();
    upstream.close();
  });

  it("plugin serves /__dev/status with {up, log}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsxlog-"));
    const logFile = join(dir, "dev.log");
    writeFileSync(logFile, "hello from the dev log\n");
    const fb = devFallback({ target: upstream.url, logFile });

    server = await createServer({
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false },
      plugins: [fb.plugin],
    });
    http = createHttp(server.middlewares);
    await new Promise<void>((r) => http!.listen(0, r));
    const port = (http.address() as { port: number }).port;

    const resp = await fetch(`http://localhost:${port}/__dev/status`);
    const json = (await resp.json()) as { up: boolean; log: string };
    expect(json.up).toBe(true);
    expect(json.log).toContain("hello from the dev log");
  });

  it("configureProxy registers an error handler that serves the interstitial", () => {
    const fb = devFallback({ target: upstream.url });
    let handler: ((e: unknown, req: unknown, res: any) => void) | undefined;
    const proxy: any = { on(ev: string, fn: any) { if (ev === "error") handler = fn; } };
    fb.configureProxy(proxy);
    expect(handler).toBeTypeOf("function");

    let status = 0;
    let body = "";
    const res: any = { headersSent: false, writeHead(s: number) { status = s; }, end(s: string) { body = s; } };
    handler!(new Error("ECONNREFUSED"), {}, res);
    expect(status).toBe(503);
    expect(body).toContain("Backend");          // interstitial title/heading
    expect(body).toContain("/__dev/status");     // the poll target
  });
});

// statusJSON boots a middlewareMode Vite server around fb.plugin and returns
// the /__dev/status JSON body — shared by the GSX_DEV_UPSTREAM tests below.
async function statusJSON(fb: DevFallback): Promise<{ up: boolean; log: string }> {
  const server = await createServer({
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false },
    plugins: [fb.plugin],
  });
  const http = createHttp(server.middlewares);
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as { port: number }).port;
  try {
    const resp = await fetch(`http://localhost:${port}/__dev/status`);
    return (await resp.json()) as { up: boolean; log: string };
  } finally {
    http.close();
    await server.close();
  }
}

describe("devFallback target resolution (GSX_DEV_UPSTREAM)", () => {
  let upstream: { url: string; close: () => void };
  const savedEnv = process.env.GSX_DEV_UPSTREAM;

  beforeEach(async () => {
    upstream = await fakeUpstream(200);
  });
  afterEach(() => {
    upstream.close();
    if (savedEnv === undefined) delete process.env.GSX_DEV_UPSTREAM;
    else process.env.GSX_DEV_UPSTREAM = savedEnv;
  });

  it("falls back to GSX_DEV_UPSTREAM when opts.target is unset", async () => {
    process.env.GSX_DEV_UPSTREAM = upstream.url;
    const fb = devFallback({});
    const json = await statusJSON(fb);
    expect(json.up).toBe(true);
  });

  it("prefers an explicit opts.target over GSX_DEV_UPSTREAM", async () => {
    process.env.GSX_DEV_UPSTREAM = "http://localhost:1"; // deliberately unreachable
    const fb = devFallback({ target: upstream.url });
    const json = await statusJSON(fb);
    expect(json.up).toBe(true); // only true if the explicit target (not env) was probed
  });

  it("devFallback() with no opts at all also picks up GSX_DEV_UPSTREAM", async () => {
    process.env.GSX_DEV_UPSTREAM = upstream.url;
    const fb = devFallback();
    const json = await statusJSON(fb);
    expect(json.up).toBe(true);
  });
});

describe("devFallback — no target fails fast at setup, never crashes at request time", () => {
  const savedEnv = process.env.GSX_DEV_UPSTREAM;

  beforeEach(() => {
    delete process.env.GSX_DEV_UPSTREAM;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GSX_DEV_UPSTREAM;
    else process.env.GSX_DEV_UPSTREAM = savedEnv;
  });

  it("throws a descriptive error naming both sources when neither is set", () => {
    expect(() => devFallback()).toThrowError(/target/i);
    expect(() => devFallback({})).toThrowError(/GSX_DEV_UPSTREAM/);
  });

  it("does not throw when opts.target is given even without GSX_DEV_UPSTREAM", () => {
    expect(() => devFallback({ target: "http://localhost:1" })).not.toThrow();
  });

  it("a malformed-but-present target degrades the status endpoint to down, without crashing the process", async () => {
    const fb = devFallback({ target: "not-a-valid-url" });
    const json = await statusJSON(fb);
    expect(json.up).toBe(false);
  });
});
