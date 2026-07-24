import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, build, type ViteDevServer, type Logger } from "vite";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gsx, panelPlugin } from "../src/index.js";

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

const clientDistPath = fileURLToPath(new URL("../dist/client.js", import.meta.url));

describe("virtual:gsx-devpanel (serve, panel enabled)", () => {
  it("default: resolves to a wrapper that imports the built client and calls init with key 'd'", async () => {
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
    // The wrapper imports the real client module (vite may rewrite the raw
    // /@fs/<abs path> specifier to a root-relative one when the file happens
    // to sit inside the served root, as it does here) and calls init() with
    // the resolved key — it does not inline the panel code itself.
    expect(result!.code).toMatch(/from "[^"]*\/client\.js"/);
    expect(result!.code).toContain(`init({ key: "d", autoShow: 3000 })`);
  });

  it("custom key: the wrapper passes it through to init()", async () => {
    const builtGsx = await loadBuiltGsx();
    server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { port: 0 },
      plugins: builtGsx({ devPanel: { key: "k" }, generateOnStart: false }),
    });
    await server.listen();

    const result = await server.transformRequest("virtual:gsx-devpanel");
    expect(result).not.toBeNull();
    expect(result!.code).toContain(`init({ key: "k", autoShow: 3000 })`);
  });

  it("custom autoShow: the wrapper passes it through to init()", async () => {
    const builtGsx = await loadBuiltGsx();
    server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { port: 0 },
      plugins: builtGsx({ devPanel: { autoShow: false }, generateOnStart: false }),
    });
    await server.listen();

    const result = await server.transformRequest("virtual:gsx-devpanel");
    expect(result).not.toBeNull();
    expect(result!.code).toContain(`init({ key: "d", autoShow: false })`);
  });

  it("the imported client module itself still gets a real HMR context", async () => {
    const builtGsx = await loadBuiltGsx();
    server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { port: 0 },
      plugins: builtGsx({ generateOnStart: false }),
    });
    await server.listen();

    // Proof the HMR transform actually runs for the client module the wrapper
    // imports: vite's client-injection plugin rewrites `import.meta.hot` into
    // a `createHotContext(...)` call during transformRequest. The raw file on
    // disk (dist/client.js) contains neither `createHotContext` nor a
    // rewritten `import.meta.hot` — only vite's dev transform produces it.
    const result = await server.transformRequest(`/@fs${clientDistPath}`);
    expect(result).not.toBeNull();
    expect(result!.code).toContain("createHotContext");
    expect(result!.code).toContain("function init(opts)");
  });
});

describe("virtual:gsx-devpanel (serve, devPanel: false)", () => {
  it("resolves to the empty noop module even in a running dev server", async () => {
    server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { port: 0 },
      plugins: gsx({ devPanel: false, generateOnStart: false }),
    });
    await server.listen();

    const result = await server.transformRequest("virtual:gsx-devpanel");
    expect(result).not.toBeNull();
    expect(result!.code).toContain("export {}");
    expect(result!.code).not.toContain("init(");
  });

  // The /__gsx/cmd endpoint (and its x-gsx header) is unrelated to whether
  // the panel UI is shown — gsx dev's front-door respawn verification
  // depends on that endpoint existing regardless. Covered end-to-end in
  // test/index.test.ts.
});

describe("virtual:gsx-devpanel (missing dist/client.js)", () => {
  it("warns once and falls back to the noop module across repeated resolves, and still serves fine", async () => {
    const missingClientPath = join(
      mkdtempSync(join(tmpdir(), "gsx-panel-missing-")),
      "client.js",
    );
    expect(existsSync(missingClientPath)).toBe(false);

    const warn = vi.fn();
    const logger: Logger = {
      info: vi.fn(),
      warn,
      warnOnce: vi.fn(),
      error: vi.fn(),
      clearScreen: vi.fn(),
      hasErrorLogged: vi.fn(() => false),
      hasWarned: false,
    };

    server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      customLogger: logger,
      server: { port: 0 },
      plugins: [panelPlugin(missingClientPath)],
    });
    await server.listen();

    // Call resolveId directly (bypassing the module graph's per-id cache)
    // several times to prove the warning is emitted exactly once, not once
    // per resolve.
    const container = server.pluginContainer;
    const first = await container.resolveId("virtual:gsx-devpanel", undefined);
    const second = await container.resolveId("virtual:gsx-devpanel", undefined);
    const third = await container.resolveId("virtual:gsx-devpanel", undefined);

    for (const resolved of [first, second, third]) {
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe("\0gsx-devpanel-noop");
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(missingClientPath);

    // The dev server still serves a real (empty) module for the virtual id —
    // no crash, no unhandled resolveId failure.
    const result = await server.transformRequest("virtual:gsx-devpanel");
    expect(result).not.toBeNull();
    expect(result!.code).toContain("export {}");

    // Still exactly one warning after the transformRequest above.
    expect(warn).toHaveBeenCalledTimes(1);
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
