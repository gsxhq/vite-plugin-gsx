import { describe, it, expect, afterEach } from "vitest";
import { createServer, build, type ViteDevServer } from "vite";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsx } from "../src/index.js";

// panelPlugin's resolveId resolves the client file relative to *its own*
// module's import.meta.url. From ../src/index.ts (the import above) that's
// src/client.js, which doesn't exist — only the built dist/client.js does.
// To exercise the real serving path (dist/client.js on disk, next to
// dist/index.js) this one test loads the built plugin instead, via a
// non-literal specifier so `tsc --noEmit` (which runs before `npm run
// build` in CI) never tries to statically resolve dist/index.d.ts before
// it exists.
const distIndexUrl = new URL("../dist/index.js", import.meta.url).href;

async function loadBuiltGsx() {
  if (!existsSync(new URL("../dist/index.js", import.meta.url))) {
    throw new Error("dist/index.js not found — run `npm run build` before this test");
  }
  const mod = (await import(distIndexUrl)) as typeof import("../src/index.js");
  return mod.gsx;
}

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("virtual:gsx-devpanel (serve)", () => {
  it("resolves to the built client, transformed through vite's pipeline with a real HMR context", async () => {
    const builtGsx = await loadBuiltGsx();
    server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { port: 0 },
      plugins: builtGsx({ generateOnStart: false }),
    });
    await server.listen();

    const result = await server.transformRequest("virtual:gsx-devpanel");
    expect(result).not.toBeNull();
    // Proof the HMR transform actually ran: vite's client-injection plugin
    // rewrites `import.meta.hot` into a `createHotContext(...)` call during
    // transformRequest. The raw file on disk (dist/client.js, unbuilt-vite
    // ES module) contains neither `createHotContext` nor a rewritten
    // `import.meta.hot` — only vite's dev transform produces it.
    expect(result!.code).toContain("createHotContext");
    // Sanity: it's actually the panel client, not an empty/noop module.
    expect(result!.code).toContain("gsx-devpanel");
  });
});

describe("virtual:gsx-devpanel (build)", () => {
  it("resolves to a noop module — build succeeds and ships no panel code", async () => {
    const root = mkdtempSync(join(tmpdir(), "gsx-panel-build-"));
    writeFileSync(
      join(root, "main.js"),
      'import "virtual:gsx-devpanel";\nconsole.log("entry alive");\n',
    );

    const output = await build({
      root,
      logLevel: "silent",
      plugins: gsx({ generateOnStart: false }),
      build: {
        write: false,
        rollupOptions: { input: join(root, "main.js") },
      },
    });

    const chunks = Array.isArray(output) ? output : [output];
    const code = chunks
      .flatMap((o) => ("output" in o ? o.output : []))
      .filter((c): c is Extract<typeof c, { type: "chunk" }> => c.type === "chunk")
      .map((c) => c.code)
      .join("\n");

    expect(code).toContain("entry alive");
    // No panel markup, custom element, or hot-context wiring made it into
    // the production bundle.
    expect(code).not.toContain("gsx-devpanel");
    expect(code).not.toContain("createHotContext");
  });
});
