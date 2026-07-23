import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ConfigEnv, Plugin, ViteDevServer } from "vite";
import { resolveOptions, type GsxOptions } from "./options.js";
import { toViteError, type GsxDiagnostic, type ViteError } from "./diagnostics.js";
import { PanelChannel } from "./panel.js";

export type { GsxOptions };

// gsx apps have no vite index.html (HTML streams from the Go server), so
// transformIndexHtml never fires. The panel is instead delivered as an
// explicit entry import: `import "virtual:gsx-devpanel"` in the app's client
// entry. This id resolves to the built panel client in dev (so it's
// transformed by vite → a real import.meta.hot) and to an empty module in
// prod builds (the main plugin below is serve-only, so without this resolver
// a `vite build` of that import would fail to resolve).
const PANEL_VIRTUAL_ID = "virtual:gsx-devpanel";
const PANEL_NOOP_ID = "\0gsx-devpanel-noop";

function panelPlugin(): Plugin {
  let command: ConfigEnv["command"] | undefined;
  let warnedMissingClient = false;
  return {
    name: "vite-plugin-gsx:panel",
    config(_config, env) {
      command = env.command;
    },
    resolveId(id) {
      if (id !== PANEL_VIRTUAL_ID) return null;
      if (command === "build") return PANEL_NOOP_ID;
      const clientPath = fileURLToPath(new URL("./client.js", import.meta.url));
      if (existsSync(clientPath)) return clientPath;
      if (!warnedMissingClient) {
        warnedMissingClient = true;
        this.warn(
          `[gsx] panel client not built (${clientPath}); run \`npm run build\` in @gsxhq/vite-plugin-gsx. Serving an empty module instead.`,
        );
      }
      return PANEL_NOOP_ID;
    },
    load(id) {
      if (id === PANEL_NOOP_ID) return "export {}";
      return null;
    },
  };
}

export function gsx(options: GsxOptions = {}): Plugin[] {
  // Shared ref so both configureServer and closeBundle can reach the child.
  let daemonChild: ReturnType<typeof spawn> | null = null;

  const main: Plugin = {
    name: "vite-plugin-gsx",
    apply: "serve",
    // Called by Vite's pluginContainer.close() → environment.close() → server.close(),
    // which runs even in middlewareMode (where httpServer is null).
    closeBundle() {
      daemonChild?.kill();
      daemonChild = null;
    },
    configureServer(server: ViteDevServer) {
      const opts = resolveOptions(options, server.config.root);
      const logger = server.config.logger;

      const panel = new PanelChannel(logger, (p) => server.ws.send(p as any));
      server.ws.on("gsx:cmd", (d: unknown) => panel.intake(d));
      server.middlewares.use("/__gsx/cmd", panel.cmdMiddleware);

      // 1. /__reload endpoint — external trigger (the Go server after boot).
      server.middlewares.use(opts.reloadEndpoint, (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        server.ws.send({ type: "full-reload", path: "*" });
        res.statusCode = 204;
        res.end();
      });

      // Shared handler: apply one `generated` event to the browser (overlay state).
      // Reused by both the daemon stdout loop (opts.daemon) and POST /__gsx/event.
      let errorShown = false;
      let currentErrorPayload: { type: "error"; err: ViteError } | null = null;
      const loggedDiagnostics = new Set<string>();
      server.ws.on("connection", (client: any) => {
        if (currentErrorPayload) client.send(JSON.stringify(currentErrorPayload));
        const replay = panel.replayPayload();
        if (replay) client.send(replay);
      });
      const applyEvent = (ev: any) => {
        if (panel.applyStatus(ev)) return;
        if (ev.event !== "generated") {
          if (ev.event === "error") {
            logger.error(`[gsx] ${ev.message}`, { timestamp: true });
          }
          return;
        }
        if (!ev.ok) {
          const diagnostics = (ev.diagnostics ?? []) as GsxDiagnostic[];
          if (isBuildOnly(diagnostics) && currentErrorPayload) return;
          for (const d of diagnostics) {
            const key = diagnosticKey(d);
            if (loggedDiagnostics.has(key)) continue;
            loggedDiagnostics.add(key);
            for (const line of diagnosticLogLines(d)) {
              logger.error(line, { timestamp: true });
            }
          }
          const err = toViteError(diagnostics, readSource);
          if (err) {
            errorShown = true;
            currentErrorPayload = { type: "error", err };
            server.ws.send(currentErrorPayload);
          }
        } else {
          // Clear the current overlay state. gsx dev triggers the actual reload
          // via POST /__reload once the server is back up; in daemon mode we keep
          // the legacy recovery reload so standalone Vite still recovers.
          currentErrorPayload = null;
          loggedDiagnostics.clear();
          if (!errorShown) return;
          errorShown = false;
          if (opts.daemon) server.ws.send({ type: "full-reload", path: "*" });
        }
      };

      // 2. Receive codegen events from `gsx dev` (default path).
      server.middlewares.use("/__gsx/event", (req: any, res: any) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            applyEvent(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            /* ignore malformed bodies */
          }
          res.statusCode = 204;
          res.end();
        });
      });

      // 3. Optionally spawn gsx generate --watch daemon and consume its NDJSON stdout.
      //    On generated ok:false → show error overlay.
      //    On generated ok:true after a shown error → full-reload (recovery).
      //    Normal ok:true does NOT reload — that is the Go-POST's job. The one
      //    exception is RECOVERY: when ok:true follows a shown error overlay, we
      //    broadcast a reload ourselves — otherwise the overlay is stuck (the Go
      //    server never restarted during a pre-build error).
      if (opts.daemon) {
        const [bin, ...daemonArgs] = [
          ...opts.command,
          "--watch",
          "--format=ndjson",
          ...opts.paths,
        ];
        if (!bin) {
          logger.error("[gsx] empty command option", {
            timestamp: true,
          });
          return;
        }
        const child = spawn(bin, daemonArgs, { cwd: opts.cwd });
        // unref so the daemon doesn't prevent Vite's process from exiting if
        // closeBundle/httpServer.close hasn't fired yet (belt-and-suspenders).
        child.unref();
        daemonChild = child;

        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => {
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          applyEvent(ev);
        });
        child.stderr.on("data", (b) => logger.info(String(b)));
        child.on("exit", (code) =>
          logger.warn(`[gsx] gsx --watch exited (${code})`),
        );
        child.on("error", (err) => {
          logger.error(
            `[gsx] could not start "gsx generate --watch" (${[bin, ...daemonArgs].join(" ")}): ${err.message}. Is the gsx \`tool\` directive in go.mod (go get -tool github.com/gsxhq/gsx/cmd/gsx) and is Go installed?`,
            { timestamp: true },
          );
        });
        // Also handle non-middlewareMode servers (belt-and-suspenders alongside closeBundle).
        server.httpServer?.on("close", () => {
          child.kill();
          daemonChild = null;
        });
      }
    },
  };

  return [main, panelPlugin()];
}

function readSource(file: string): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function diagnosticLogLines(d: GsxDiagnostic): string[] {
  const out = [`[gsx] ${d.severity || "diagnostic"} ${d.file || "unknown"}`];
  const lines = String(d.message ?? "").split(/\r?\n/);
  for (const line of lines) {
    const text = line.trimEnd();
    if (text !== "") out.push(`[gsx]   ${text}`);
  }
  return out;
}

function diagnosticKey(d: GsxDiagnostic): string {
  return JSON.stringify({
    file: d.file,
    severity: d.severity,
    message: d.message,
    line: d.range?.start?.line,
    col: d.range?.start?.col,
  });
}

function isBuildOnly(diags: GsxDiagnostic[]): boolean {
  return diags.length > 0 && diags.every((d) => d.file === "build");
}

export default gsx;

export { devFallback } from "./dev-fallback.js";
export type { DevFallbackOptions, DevFallback } from "./dev-fallback.js";
