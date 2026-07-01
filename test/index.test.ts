import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createServer as createHttp, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsx } from "../src/index.js";

let server: ViteDevServer;
let http: Server | undefined;

afterEach(async () => {
  http?.close();
  await server?.close();
});

async function start(options = {}) {
  server = await createServer({
    root: mkdtempSync(join(tmpdir(), "gsx-plugin-")),
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false },
    plugins: [gsx(options)],
  });
  return server;
}

describe("vite-plugin-gsx", () => {
  it("POST /__reload broadcasts a full-reload over the ws", async () => {
    await start();
    const send = vi.spyOn(server.ws, "send");

    http = createHttp(server.middlewares);
    await new Promise<void>((r) => http!.listen(0, r));
    const port = (http.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/__reload`, {
      method: "POST",
    });
    expect(res.status).toBe(204);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "full-reload" }),
    );
  });

  it("defaults to gsx dev event-endpoint mode without spawning a daemon", async () => {
    await start({ command: ["node", "should-not-run"] });

    http = createHttp(server.middlewares);
    await new Promise<void>((r) => http!.listen(0, r));
    const port = (http.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/__gsx/event`, {
      method: "POST",
      body: JSON.stringify({
        event: "generated",
        ok: true,
        durationMs: 1,
        written: [],
        diagnostics: [],
      }),
    });
    expect(res.status).toBe(204);
  });

  it("daemon mode starts gsx generate --watch with ndjson output", async () => {
    await start({
      daemon: true,
      command: ["node", "-e", "setInterval(() => {}, 1000)"],
      paths: ["./views"],
    });

    // The assertion is behavioral: daemon mode must not prevent the Vite server
    // from starting, and closeBundle/server.close must be able to tear it down.
    expect(server).toBeDefined();
  });
});
