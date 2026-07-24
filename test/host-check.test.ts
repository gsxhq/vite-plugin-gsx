import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createServer as createHttp, request as httpRequest, type Server, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsx } from "../src/index.js";

// A REAL vite@6.4.3 createServer + the plugin's real middleware stack — not
// a synthetic connect-style stand-in. A hand-rolled dispatcher can only
// assert what *we* believe vite's ordering/routing to be; it already missed
// a real bug once (round 1's post-hook fix 404'd every GET in a real server,
// because vite's own transformMiddleware — installed before any post-hook
// runs — treats an extension-less URL as a module request and answers 404
// itself, before the post-hook-registered /__gsx/log handler is ever
// reached). This test drives actual HTTP requests through vite's actual
// middlewares(), so it breaks the same way the real thing breaks and stays
// honest across a future vite reordering.
let viteServer: ViteDevServer | undefined;
let http: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  http?.close();
  await viteServer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  viteServer = undefined;
  http = undefined;
  dir = undefined;
});

// Node's global fetch() is WHATWG-compliant and silently drops a `Host`
// header (it's on the forbidden-request-header list) — verified: it always
// sends the real socket's authority instead, making it useless for
// DNS-rebinding-style tests. A raw node:http request has no such
// restriction, so it's the only way to actually simulate a foreign Host.
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolvePromise({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("/__gsx/log against a real vite dev server", () => {
  it("403s a foreign Host on /__gsx/log, leaves /__gsx/cmd unaffected, serves /__gsx/log for the allowed Host, and never grants a foreign-Origin ACAO", async () => {
    dir = mkdtempSync(join(tmpdir(), "gsx-hostcheck-"));
    const logPath = join(dir, "dev.log");
    writeFileSync(logPath, "hello from the backend\n");

    viteServer = await createServer({
      root: dir,
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false },
      plugins: [gsx({ devLog: logPath })],
    });

    http = createHttp(viteServer.middlewares);
    await new Promise<void>((r) => http!.listen(0, r));
    const port = (http.address() as { port: number }).port;

    // A DNS-rebinding page: the browser resolved attacker.example -> 127.0.0.1,
    // so the request is same-origin from the browser's point of view, but the
    // Host header the server sees still names the attacker's domain.
    const evilLog = await rawRequest(port, "/__gsx/log", { Host: "attacker.example" });
    expect(evilLog.status).toBe(403);

    // /__gsx/cmd is gsx dev's own server-to-server channel — it must not be
    // host-checked, and its x-gsx echo contract must survive.
    const evilCmd = await rawRequest(port, "/__gsx/cmd?wait=0", { Host: "attacker.example" });
    expect(evilCmd.status).not.toBe(403);
    expect(evilCmd.headers["x-gsx"]).toBe("1");

    // The allowed (real) Host is served normally — this is the case round 1
    // silently broke (404 from vite's own transformMiddleware).
    const goodLog = await rawRequest(port, "/__gsx/log", { Host: `localhost:${port}` });
    expect(goodLog.status).toBe(200);
    expect(goodLog.body).toBe("hello from the backend\n");
    expect(goodLog.headers["x-gsx-log-start"]).toBe("0");

    // SOP still holds even for the allowed-Host case: no CORS middleware
    // ever stamps ACAO for a foreign Origin on either route.
    const crossOrigin = await rawRequest(port, "/__gsx/log", {
      Host: `localhost:${port}`,
      Origin: "http://attacker.example",
    });
    expect(crossOrigin.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
