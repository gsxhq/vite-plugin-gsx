import { describe, it, expect, afterEach } from "vitest";
import http, { type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, type ViteDevServer } from "vite";
import { devFallback } from "../src/dev-fallback.js";

// These run real requests through Vite's dev proxy (http-proxy) with
// devFallback's configureProxy, against an upstream that fails at a chosen
// point of the exchange.

type Upstream = (req: IncomingMessage, res: ServerResponse) => void;

let closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});

function listen(srv: Server): Promise<number> {
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
}

async function startUpstream(handler: Upstream): Promise<string> {
  const srv = http.createServer(handler);
  const port = await listen(srv);
  closers.push(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return `http://127.0.0.1:${port}`;
}

// closedTarget returns an origin nothing listens on.
async function closedTarget(): Promise<string> {
  const srv = http.createServer();
  const port = await listen(srv);
  await new Promise<void>((r) => srv.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

async function startVite(target: string): Promise<number> {
  const fb = devFallback({ target });
  const server: ViteDevServer = await createServer({
    logLevel: "silent",
    configFile: false,
    server: {
      middlewareMode: true,
      hmr: false,
      proxy: { "/": { target, configure: fb.configureProxy } },
    },
    plugins: [fb.plugin],
  });
  const front = http.createServer(server.middlewares);
  const port = await listen(front);
  closers.push(async () => {
    front.closeAllConnections();
    front.close();
    await server.close();
  });
  return port;
}

interface Result {
  status?: number;
  body: string;
  complete: boolean; // the response body ended normally
}

// send makes a request through the proxy, streaming `uploadBytes` of body
// slowly enough that the upstream can fail mid-upload. It resolves when the
// response ends, is cut off, or after a timeout (complete=false either way).
function send(port: number, method: string, uploadBytes = 0): Promise<Result> {
  return new Promise((resolve) => {
    const out: Result = { body: "", complete: false };
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(out);
    };
    const timer = setTimeout(done, 3000);
    const req = http.request({ host: "127.0.0.1", port, method, path: "/api", headers: uploadBytes ? { "content-length": uploadBytes } : {} });
    req.on("response", (res) => {
      out.status = res.statusCode;
      res.setEncoding("utf8");
      res.on("data", (c: string) => (out.body += c));
      res.on("end", () => {
        out.complete = res.complete;
        done();
      });
      res.on("error", done);
      res.on("aborted", done);
    });
    req.on("error", done);
    if (!uploadBytes) {
      req.end();
      return;
    }
    const chunk = Buffer.alloc(64 * 1024, "x");
    let sent = 0;
    const pump = () => {
      if (settled || req.destroyed) return;
      if (sent >= uploadBytes) return void req.end();
      sent += chunk.length;
      req.write(chunk);
      setTimeout(pump, 5);
    };
    pump();
  });
}

// resetSoon answers nothing more and sends a TCP RST after ms, the way a Go
// server closes a connection whose upload it stopped reading.
function resetSoon(req: IncomingMessage, ms = 100) {
  req.pause();
  setTimeout(() => req.socket.resetAndDestroy(), ms);
}

const upload = 4 * 1024 * 1024;

describe("devFallback proxy errors (live, through Vite's proxy)", () => {
  it("backend not listening → 503 interstitial", async () => {
    const port = await startVite(await closedTarget());
    const r = await send(port, "GET");
    expect(r.status).toBe(503);
    expect(r.body).toContain("/__dev/status");
  });

  it("full upstream response, then the upload is reset → exactly the upstream body", async () => {
    const port = await startVite(
      await startUpstream((req, res) => {
        res.writeHead(413, { "content-type": "text/plain", "content-length": 7 });
        res.end("too big");
        resetSoon(req);
      }),
    );
    const r = await send(port, "POST", upload);
    expect(r).toEqual({ status: 413, body: "too big", complete: true });
  });

  it("partial upstream body, then the upload is reset → cut off, nothing appended", async () => {
    const port = await startVite(
      await startUpstream((req, res) => {
        res.writeHead(413, { "content-type": "text/plain", "content-length": 7 });
        res.write("too");
        resetSoon(req);
      }),
    );
    const r = await send(port, "POST", upload);
    expect(r).toEqual({ status: 413, body: "too", complete: false });
  });

  it("upstream headers only, then the upload is reset → the upstream status, cut off", async () => {
    const port = await startVite(
      await startUpstream((req, res) => {
        res.writeHead(413, { "content-type": "text/plain", "content-length": 7 });
        res.flushHeaders();
        resetSoon(req);
      }),
    );
    const r = await send(port, "POST", upload);
    expect(r).toEqual({ status: 413, body: "", complete: false });
  });

  it("connected backend resets before responding → 502, not the interstitial", async () => {
    const port = await startVite(await startUpstream((req) => resetSoon(req)));
    const r = await send(port, "POST", upload);
    expect(r.status).toBe(502);
    expect(r.body).not.toContain("/__dev/status");
  });

  it("upstream dies mid-body on a GET → the response is cut off, not left hanging", async () => {
    const port = await startVite(
      await startUpstream((req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "content-length": 100 });
        res.write("partial");
        resetSoon(req, 20);
      }),
    );
    const started = Date.now();
    const r = await send(port, "GET");
    expect(r).toEqual({ status: 200, body: "partial", complete: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
