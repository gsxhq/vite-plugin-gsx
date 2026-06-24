import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { createServer as createHttp, type Server } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsx } from "../src/index.js";

const fakeGsx = fileURLToPath(
  new URL("./fixtures/fake-gsx.mjs", import.meta.url),
);

let root: string;
let server: ViteDevServer;
let http: Server | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gsx-plugin-"));
});
afterEach(async () => {
  http?.close();
  await server?.close();
});

async function start(command: string[], generateOnStart = false) {
  server = await createServer({
    root,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false },
    plugins: [gsx({ command, generateOnStart })],
  });
  return server;
}

describe("vite-plugin-gsx", () => {
  it("POST /__reload broadcasts a full-reload over the ws", async () => {
    await start(["node", fakeGsx]);
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

  it("a failing generate on a .gsx change sends an error overlay payload", async () => {
    await start(["node", fakeGsx, "--mode=fail"]);
    const send = vi.spyOn(server.ws, "send");

    const gsxFile = join(root, "foo.gsx");
    writeFileSync(gsxFile, "package x\n");
    server.watcher.emit("change", gsxFile);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    }, { timeout: 2000 });
  });

  it("a successful generate on change does NOT broadcast a reload", async () => {
    await start(["node", fakeGsx]); // --mode=ok
    const send = vi.spyOn(server.ws, "send");

    const gsxFile = join(root, "foo.gsx");
    writeFileSync(gsxFile, "package x\n");
    server.watcher.emit("change", gsxFile);

    // Wait past the debounce window and the generate.
    await new Promise((r) => setTimeout(r, 400));
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "full-reload" }),
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("ignores non-.gsx file changes", async () => {
    await start(["node", fakeGsx]);
    const other = join(root, "notes.txt");
    writeFileSync(other, "hi");
    server.watcher.emit("change", other);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(root, "gsx-ran.log"))).toBe(false);
  });

  it("generateOnStart runs one generate at startup", async () => {
    await start(["node", fakeGsx], true);
    await vi.waitFor(
      () => expect(existsSync(join(root, "gsx-ran.log"))).toBe(true),
      { timeout: 2000 },
    );
    expect(readFileSync(join(root, "gsx-ran.log"), "utf8").trim()).toBe("ok");
  });
});
