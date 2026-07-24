import { existsSync, readFileSync, promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import { isIP } from "node:net";
import { normalizePath, type ConfigEnv, type Plugin, type ViteDevServer } from "vite";
import { resolveOptions, resolveDevPanel, type GsxOptions, type DevPanelSetting } from "./options.js";
import { toViteError, type GsxDiagnostic, type ViteError } from "./diagnostics.js";
import { PanelChannel } from "./panel.js";

export type { GsxOptions };

// Faithful port of vite's own host-check semantics — NOT an approximation.
// Ported from the installed vite@6.4.3 dist
// (node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:32262-32338):
// `isHostAllowedWithoutCache` (the pure predicate) and the `hostCheckMiddleware`
// call site around it. We can't reuse vite's own `hostCheckMiddleware`
// (it's not exported), so this mirrors its logic byte-for-byte in spirit:
// file:/extension: protocols always pass; a bracketed literal is checked as
// an IPv6 address; the port is stripped before matching; a bare IPv4 literal
// always passes; `localhost`/`*.localhost` always pass; then vite's own
// precomputed `additionalAllowedHosts` (server.host / hmr.host / origin
// hostname — an internal ResolvedConfig field, not in vite's public types,
// but reading it directly means we see exactly the value vite computed for
// THIS server rather than re-deriving it and risking drift) and finally the
// user's `server.allowedHosts` list, including its leading-dot wildcard
// form. No caching layer (vite's is a perf optimization irrelevant here).
const FILE_OR_EXTENSION_PROTOCOL_RE = /^(?:file|.+-extension):/i;

function additionalAllowedHosts(server: ViteDevServer): string[] {
  return (
    (server.config as unknown as { additionalAllowedHosts?: string[] }).additionalAllowedHosts ?? []
  );
}

function isHostAllowedForDevLog(server: ViteDevServer, hostHeader: string | undefined): boolean {
  const allowedHosts = server.config.server.allowedHosts;
  if (allowedHosts === true) return true;
  if (!hostHeader) return false;
  if (FILE_OR_EXTENSION_PROTOCOL_RE.test(hostHeader)) return true;
  const trimmedHost = hostHeader.trim();
  if (trimmedHost[0] === "[") {
    const endIpv6 = trimmedHost.indexOf("]");
    if (endIpv6 < 0) return false;
    return isIP(trimmedHost.slice(1, endIpv6)) === 6;
  }
  const colonPos = trimmedHost.indexOf(":");
  const hostname = colonPos === -1 ? trimmedHost : trimmedHost.slice(0, colonPos);
  if (isIP(hostname) === 4) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  for (const extra of additionalAllowedHosts(server)) {
    if (extra === hostname) return true;
  }
  for (const allowed of allowedHosts ?? []) {
    if (allowed === hostname) return true;
    if (allowed[0] === "." && (allowed.slice(1) === hostname || hostname.endsWith(allowed))) return true;
  }
  return false;
}

// gsx apps have no vite index.html (HTML streams from the Go server), so
// transformIndexHtml never fires. The panel is instead delivered as an
// explicit entry import: `import "virtual:gsx-devpanel"` in the app's client
// entry. This id resolves to a small wrapper module in dev (which imports the
// built panel client, so it's transformed by vite → a real import.meta.hot)
// and to an empty module in prod builds AND whenever devPanel is disabled
// (the main plugin below is serve-only, so without this resolver a
// `vite build` of that import would fail to resolve). devPanel:false only
// turns off the UI — it does not touch /__gsx/cmd or the daemon/event
// endpoints in the main plugin, which stay registered regardless (see
// configureServer below).
const PANEL_VIRTUAL_ID = "virtual:gsx-devpanel";
const PANEL_NOOP_ID = "\0gsx-devpanel-noop";
const PANEL_WRAPPER_ID = "\0gsx-devpanel-wrapper";

// vite's own FS_PREFIX ("/@fs/") joined with a forward-slash absolute path —
// mirrors what vite itself does internally (FS_PREFIX isn't part of vite's
// public API, so the literal is pinned here). A plain template concat of the
// raw OS path breaks on win32: fileURLToPath yields `C:\Users\...\client.js`,
// and `/@fs${that}` is not a valid specifier.
//
// NOTE: vite's own exported `normalizePath` only strips backslash separators
// when the *executing* process itself is win32 (it's `path.posix.normalize
// (isWindows ? slash(id) : id)` — isWindows := process.platform === "win32"),
// which is correct for vite's own use (it never normalizes a path string
// produced by some *other* host) but not sufficient here in isolation: our
// input always comes from this same process's own fileURLToPath/import.meta.url,
// so a win32-shaped string only ever occurs when *this* process is already on
// win32 — meaning the separator swap is unconditionally safe (never a
// legitimate POSIX filename with a literal backslash). We do that swap
// ourselves first so the result is deterministic on every host, then still
// run it through vite's normalizePath for its (host-independent) posix path
// collapsing.
export function fsImportSpecifier(absPath: string): string {
  return posix.join("/@fs", normalizePath(absPath.replace(/\\/g, "/")));
}

// clientPath is injectable for tests exercising the missing-file fallback;
// production callers always rely on the default (derived from this module's
// own location). devPanel defaults to the enabled/key:"d" setting so callers
// that only care about the client-file fallback (tests) don't need to pass it.
// devPanel is expected pre-validated (key lowercased, single a-z/0-9 char) —
// the gsx() factory always builds it via resolveDevPanel; a caller
// constructing panelPlugin directly with a hand-rolled object bypasses that
// validation.
export function panelPlugin(
  clientPath?: string,
  devPanel: DevPanelSetting = resolveDevPanel(undefined),
): Plugin {
  const resolvedClientPath =
    clientPath ?? fileURLToPath(new URL("./client.js", import.meta.url));
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
      if (!devPanel.enabled) return PANEL_NOOP_ID;
      if (existsSync(resolvedClientPath)) return PANEL_WRAPPER_ID;
      if (!warnedMissingClient) {
        warnedMissingClient = true;
        this.warn(
          `[gsx] panel client not built (${resolvedClientPath}); run \`npm run build\` in @gsxhq/vite-plugin-gsx. Serving an empty module instead.`,
        );
      }
      return PANEL_NOOP_ID;
    },
    load(id) {
      if (id === PANEL_NOOP_ID) return "export {}";
      if (id === PANEL_WRAPPER_ID) {
        // Goes through vite's normal pipeline like any other import — the
        // `/@fs/<path>` specifier is vite's own scheme for serving an
        // arbitrary absolute filesystem path, and the client module it
        // points at keeps a real import.meta.hot from vite's transform.
        return `import { init } from "${fsImportSpecifier(resolvedClientPath)}";\ninit({ key: ${JSON.stringify(devPanel.key)} });\n`;
      }
      return null;
    },
  };
}

export function gsx(options: GsxOptions = {}): Plugin[] {
  // Shared ref so both configureServer and closeBundle can reach the child.
  let daemonChild: ReturnType<typeof spawn> | null = null;
  // Resolved here (not from resolveOptions in configureServer) because
  // panelPlugin needs it at plugin-construction time, before server.config.root
  // exists.
  const devPanel = resolveDevPanel(options.devPanel);

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

      // Registered unconditionally — even when devPanel is disabled. gsx
      // dev's front-door respawn verification depends on the x-gsx header
      // this endpoint stamps, regardless of whether the panel UI is shown.
      const panel = new PanelChannel(logger, (p) => server.ws.send(p as any), process.env.GSX_DEV_TOKEN);
      server.ws.on("gsx:cmd", (d: unknown) => panel.intake(d));
      server.middlewares.use("/__gsx/cmd", panel.cmdMiddleware);

      // Backend log tail — /__gsx/log (dev panel's "read the log" source).
      // The path arrives on the dev env bus (GSX_DEV_LOG, injected by gsx dev
      // when [dev].log is set) or via the devLog option; endpoint absent when
      // neither is set. GET-only, capped: the panel polls a bounded tail, it
      // never streams the whole file.
      //
      // Registered PRE-hook, directly here alongside /__gsx/cmd — NOT from
      // configureServer's returned post-hook. A post-hook registration does
      // sit after vite's own hostCheckMiddleware in the stack (true, and
      // still the right mental model for *that* middleware), but it also
      // sits after vite's transformMiddleware, which is installed before any
      // post-hook runs. transformMiddleware's `isJSRequest` heuristic treats
      // any extension-less GET as a module request, tries to resolve
      // `/__gsx/log` as one, fails, and answers 404 itself — the request
      // never reaches a post-hook-registered handler at all. (Confirmed live
      // against a real vite@6.4.3 createServer: GET 404s, POST correctly
      // 405s from the handler, proving it's registered but unreachable for
      // GET.) So instead: register pre-hook like /__gsx/cmd, and enforce the
      // CVE-2025-24010 DNS-rebinding guard ourselves, in-handler, as a
      // faithful port of vite's own hostCheckMiddleware semantics
      // (isHostAllowedForDevLog above) rather than leaning on registration
      // order at all.
      //
      // ASYMMETRY: /__gsx/cmd and /__gsx/event stay entirely unchecked. Both
      // are gsx dev's own server-to-server calls (the front-door respawn
      // probe, codegen event POSTs) and arrive with whatever Host the gsx
      // process happens to send — host-checking them would break gsx dev
      // itself, not attackers. /__gsx/log's only consumer is the browser dev
      // panel, so unlike those two it both can and must be host-checked.
      if (opts.devLogPath) {
        const logPath = opts.devLogPath;
        const DEFAULT_TAIL = 64 << 10; // 64 KiB
        const MAX_TAIL = 1 << 20; // 1 MiB
        server.middlewares.use("/__gsx/log", async (req, res) => {
          const hostHeader = req.headers?.host;
          if (!isHostAllowedForDevLog(server, hostHeader)) {
            const hostname = hostHeader?.replace(/:\d+$/, "");
            res.statusCode = 403;
            res.setHeader("content-type", "text/plain");
            res.end(
              `Blocked request. This host (${JSON.stringify(hostname)}) is not allowed.\nTo allow this host, add ${JSON.stringify(hostname)} to \`server.allowedHosts\` in vite.config.js.`,
            );
            return;
          }
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end();
            return;
          }
          let tail = DEFAULT_TAIL;
          const t = new URL(req.url ?? "/", "http://gsx").searchParams.get("tail");
          if (t !== null) {
            // Explicit integer bounds, not Number()+floor: a permissive
            // Number() parse followed by floor lets fractional/negative
            // values ("0.5", "-5") silently through by rounding them into
            // some other in-range integer — "?tail=0.5" used to floor to 0
            // and return an empty 200 as if that had been requested on
            // purpose. Anything that isn't a plain non-negative integer
            // literal is a malformed request, not a value to coerce.
            if (!/^\d+$/.test(t)) {
              res.statusCode = 400;
              res.end();
              return;
            }
            tail = Math.min(Number.parseInt(t, 10), MAX_TAIL);
          }
          try {
            const fh = await fsp.open(logPath, "r");
            try {
              let { size } = await fh.stat();
              let start = Math.max(0, size - tail);
              let buf = Buffer.alloc(size - start);
              let { bytesRead } = await fh.read(buf, 0, buf.length, start);
              if (bytesRead < buf.length) {
                // The file changed size between stat and read — gsx dev's
                // os.Create truncates [dev].log on every dev-server restart,
                // and this stat->read window is exactly where that race
                // lands. A stable file always yields bytesRead === buf.length
                // here (we only ever ask for bytes the stat said exist), so a
                // short read is proof the size moved, not a heuristic guess.
                // Re-stat and re-read once against the now-current size so
                // the body and its x-gsx-log-start offset describe one
                // coherent file state instead of a stale offset paired with
                // freshly-truncated bytes.
                ({ size } = await fh.stat());
                start = Math.max(0, size - tail);
                buf = Buffer.alloc(size - start);
                ({ bytesRead } = await fh.read(buf, 0, buf.length, start));
              }
              let body = buf.subarray(0, bytesRead);
              if (start > 0) {
                // Cutting mid-file can land inside a multi-byte UTF-8
                // sequence; a continuation byte (10xxxxxx, i.e. top two bits
                // 10) at the very front decodes as U+FFFD under the
                // "text/plain; charset=utf-8" we declare. Drop up to 3
                // leading continuation bytes (the max a UTF-8 sequence can
                // have) so the body starts on a rune boundary, and report the
                // adjusted offset — start===0 never needs this since there's
                // nothing before it to have cut into.
                let cut = 0;
                while (cut < body.length && cut < 3 && ((body[cut] ?? 0) & 0xc0) === 0x80) cut++;
                if (cut > 0) {
                  body = body.subarray(cut);
                  start += cut;
                }
              }
              res.statusCode = 200;
              res.setHeader("content-type", "text/plain; charset=utf-8");
              // Where in the file this tail begins — non-zero tells the
              // panel the response is truncated mid-file.
              res.setHeader("x-gsx-log-start", String(start));
              res.end(body);
            } finally {
              await fh.close();
            }
          } catch (err) {
            res.statusCode = (err as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : 500;
            res.end();
          }
        });
      }

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

  return [main, panelPlugin(undefined, devPanel)];
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
