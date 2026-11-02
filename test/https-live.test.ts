import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createServer as createHttpServer, type Server } from "node:http";
import { request, type RequestOptions } from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionOptions } from "node:tls";
import WebSocket from "ws";
import { gsx } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url));
const ca = fixture("ca.pem");
const token = "https-integration-test";
let server: ViteDevServer | undefined;
let upstream: Server | undefined;
let dir: string | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.close();
  server = undefined;
  if (upstream) await new Promise<void>((resolve, reject) => upstream!.close((err) => err ? reject(err) : resolve()));
  upstream = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllEnvs();
});

async function startServer(): Promise<number> {
  dir = mkdtempSync(join(tmpdir(), "gsx-https-"));
  writeFileSync(join(dir, "dev.log"), "backend over HTTP, front door over HTTPS\n");
  upstream = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin }));
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("expected an upstream TCP listener");

  vi.stubEnv("GSX_DEV_TOKEN", token);
  server = await createServer({
    configFile: false,
    root: dir,
    base: "/__vite/",
    logLevel: "silent",
    plugins: gsx({ devLog: join(dir, "dev.log") }),
    server: {
      host: "127.0.0.1",
      port: 0,
      https: { cert: fixture("localhost.pem"), key: fixture("localhost-key.pem") },
      proxy: {
        "/app": { target: `http://127.0.0.1:${upstreamAddress.port}`, changeOrigin: false },
      },
    },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("expected a Vite TLS listener");
  return address.port;
}

function httpsRequest(port: number, path: string, options: RequestOptions = {}, body?: unknown) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", servername: "localhost", port, path, ca, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("HTTPS request timed out")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

type Frame = { type: string; event?: string; data?: unknown; path?: string };

function nextFrame(ws: WebSocket, matches: (frame: Frame) => boolean): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("WSS closed before the expected frame"));
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(String(data)) as Frame;
      if (matches(frame)) { cleanup(); resolve(frame); }
    };
    const timer = setTimeout(() => onError(new Error("WSS frame timed out")), 3000);
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function connectHmr(port: number, options: WebSocket.ClientOptions & Pick<ConnectionOptions, "servername"> = {}): Promise<WebSocket> {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/__vite/`, "vite-hmr", { ca, servername: "localhost", ...options });
  sockets.push(ws);
  await nextFrame(ws, (frame) => frame.type === "connected");
  return ws;
}

describe("native Vite HTTPS front door", () => {
  it("serves plugin control routes over trusted TLS and carries status, commands and reloads over WSS", async () => {
    const port = await startServer();
    const ws = await connectHmr(port);
    const status = { event: "status", phase: "building", server: { healthy: true, port: "7777" } };
    const pushed = nextFrame(ws, (frame) => frame.type === "custom" && frame.event === "gsx:status");
    const [posted, pushedFrame] = await Promise.all([
      httpsRequest(port, "/__gsx/event", { method: "POST" }, status),
      pushed,
    ]);
    expect(posted.status).toBe(204);
    expect(pushedFrame).toEqual({ type: "custom", event: "gsx:status", data: status });

    const pulled = nextFrame(ws, (frame) => frame.type === "custom" && frame.event === "gsx:status");
    ws.send(JSON.stringify({ type: "custom", event: "gsx:status-request", data: {} }));
    expect(await pulled).toEqual({ type: "custom", event: "gsx:status", data: status });

    ws.send(JSON.stringify({ type: "custom", event: "gsx:cmd", data: { cmd: "rebuild" } }));
    const commands = await httpsRequest(port, "/__gsx/cmd?wait=1", { headers: { "x-gsx-token": token } });
    expect(commands.status).toBe(200);
    expect(commands.headers["x-gsx"]).toBe(token);
    expect(JSON.parse(commands.body)).toEqual({ cmds: ["rebuild"] });

    const log = await httpsRequest(port, "/__gsx/log");
    expect(log.status).toBe(200);
    expect(log.body).toBe("backend over HTTP, front door over HTTPS\n");
    const reloaded = nextFrame(ws, (frame) => frame.type === "full-reload");
    const [reloadResponse, reloadFrame] = await Promise.all([
      httpsRequest(port, "/__reload", { method: "POST" }),
      reloaded,
    ]);
    expect(reloadResponse.status).toBe(204);
    expect(reloadFrame).toEqual({ type: "full-reload", path: "*" });
  }, 15000);

  it("keeps the Go upstream on HTTP and preserves the browser Host and Origin", async () => {
    const port = await startServer();
    const response = await httpsRequest(port, "/app", {
      headers: { host: `localhost:${port}`, origin: `https://localhost:${port}` },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ host: `localhost:${port}`, origin: `https://localhost:${port}` });
  });

  it("rejects an untrusted CA for HTTPS control requests and WSS", async () => {
    const port = await startServer();
    await expect(httpsRequest(port, "/__gsx/cmd?wait=0", { ca: undefined })).rejects.toMatchObject({
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    await expect(connectHmr(port, { ca: undefined })).rejects.toMatchObject({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  });

  it("rejects a hostname missing from the certificate for HTTPS control requests and WSS", async () => {
    const port = await startServer();
    await expect(httpsRequest(port, "/__gsx/cmd?wait=0", { servername: "wrong.test" })).rejects.toMatchObject({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    await expect(connectHmr(port, { servername: "wrong.test" })).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
});
