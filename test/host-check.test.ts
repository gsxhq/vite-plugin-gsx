import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsx } from "../src/index.js";

// A minimal connect-style dispatcher modeling the ordering fact Vite itself
// implements (verified against the installed vite dist,
// node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:38813-38855):
//
//   1. every plugin's configureServer hook runs (collecting any returned
//      post-hook function, but NOT yet invoking it);
//   2. THEN vite installs rejectInvalidRequestMiddleware / cors /
//      hostCheckMiddleware — as *global* (no-path) middleware, so they see
//      every request regardless of path;
//   3. only THEN are the collected post-hook functions invoked (this is
//      where a plugin's own `.use()` calls made from that returned function
//      land in the stack).
//
// Because connect dispatches in registration order, anything registered in
// step 1 sits *before* the host check and never sees it; anything
// registered in step 3 sits *after* it and is always host-checked first.
function makeConnectStack() {
  const stack: { path: string | null; fn: Function }[] = [];
  const middlewares = {
    use(pathOrFn: any, fn?: Function) {
      if (typeof pathOrFn === "function") stack.push({ path: null, fn: pathOrFn });
      else stack.push({ path: pathOrFn, fn: fn! });
    },
  };
  function pathMatches(url: string, path: string): boolean {
    if (!url.startsWith(path)) return false;
    const rest = url.slice(path.length);
    return rest === "" || rest[0] === "/" || rest[0] === "?";
  }
  function installHostCheck(allowedHost: string) {
    // Stands in for vite's real hostCheckMiddleware: a global middleware
    // that 403s any request whose Host header isn't the allowed one.
    middlewares.use(function fakeHostCheckMiddleware(req: any, res: any, next: any) {
      const host = req.headers?.host;
      if (host !== allowedHost) {
        res.statusCode = 403;
        res.end(`Blocked request. This host (${JSON.stringify(host)}) is not allowed.`);
        return;
      }
      next();
    });
  }
  function request(req: any): Promise<{ statusCode: number; body: any }> {
    return new Promise((resolveResult) => {
      const res: any = {
        statusCode: 0,
        setHeader() {},
        end(body?: any) {
          res.body = body;
          resolveResult({ statusCode: res.statusCode, body });
        },
      };
      let i = 0;
      function next() {
        if (i >= stack.length) {
          resolveResult({ statusCode: 0, body: undefined }); // fell through unhandled
          return;
        }
        const entry = stack[i++]!;
        if (entry.path !== null && !pathMatches(req.url ?? "/", entry.path)) {
          next();
          return;
        }
        entry.fn(req, res, next);
      }
      next();
    });
  }
  return { middlewares, installHostCheck, request, stackLength: () => stack.length };
}

function fakeConfig() {
  return { root: process.cwd(), logger: { error: () => {}, info: () => {} } };
}

describe("/__gsx/log sits behind vite's host check; /__gsx/cmd does not", () => {
  it("rejects a disallowed Host for /__gsx/log, still serves /__gsx/cmd, and serves /__gsx/log for the allowed Host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsx-hostcheck-"));
    const logPath = join(dir, "dev.log");
    writeFileSync(logPath, "hello from the backend\n");
    process.env.GSX_DEV_LOG = logPath;
    try {
      const conn = makeConnectStack();
      const server: any = {
        config: fakeConfig(),
        middlewares: conn.middlewares,
        ws: { send: () => {}, on: () => {} },
        httpServer: { on: () => {} },
      };

      // Step 1: run the plugin's configureServer (pre-hook registrations
      // happen synchronously; capture whatever it returns as the post-hook).
      const postHook = (gsx()[0] as any).configureServer(server);

      // Step 2: vite installs its host check as a global middleware — after
      // the hook ran, before any post-hook has been invoked.
      conn.installHostCheck("localhost:5173");

      // Step 3: vite invokes the collected post-hook(s).
      if (typeof postHook === "function") await postHook();

      // A DNS-rebinding page: browser resolves attacker.com -> 127.0.0.1, so
      // the request looks same-origin to the browser but carries a foreign
      // Host header the server can still see.
      const evilHost = { host: "attacker.example" };

      const evilLog = await conn.request({ method: "GET", url: "/__gsx/log", headers: evilHost });
      expect(evilLog.statusCode).toBe(403);

      const evilCmd = await conn.request({ method: "GET", url: "/__gsx/cmd?wait=0", headers: evilHost });
      expect(evilCmd.statusCode).not.toBe(403);

      const goodLog = await conn.request({
        method: "GET",
        url: "/__gsx/log",
        headers: { host: "localhost:5173" },
      });
      expect(goodLog.statusCode).toBe(200);
      expect(goodLog.body.toString()).toBe("hello from the backend\n");
    } finally {
      delete process.env.GSX_DEV_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
