import fs from "node:fs";
import http from "node:http";
import type { Plugin } from "vite";

export interface DevFallbackOptions {
  /** Go upstream origin, e.g. "http://localhost:7777". */
  target: string;
  /** Combined dev log to tail in the interstitial. Default "tmp/dev.log". */
  logFile?: string;
  /** Backend liveness endpoint. Default "/healthz". */
  healthPath?: string;
  /** Status endpoint to register. Default "/__dev/status". */
  statusPath?: string;
}

export interface DevFallback {
  /** Registers GET <statusPath> → { up, log }. */
  plugin: Plugin;
  /** Vite proxy `configure` hook: serves the interstitial on a proxy error. */
  configureProxy: (proxy: any) => void;
}

// devFallback returns a Vite plugin + a proxy configure hook that together turn
// a down/restarting Go backend into a self-recovering interstitial instead of a
// raw proxy error. Dev-only.
export function devFallback(opts: DevFallbackOptions): DevFallback {
  const logFile = opts.logFile ?? "tmp/dev.log";
  const healthPath = opts.healthPath ?? "/healthz";
  const statusPath = opts.statusPath ?? "/__dev/status";
  const html = interstitial(statusPath);

  const plugin: Plugin = {
    name: "vite-plugin-gsx:dev-fallback",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(statusPath, async (_req, res) => {
        const up = await backendUp(opts.target, healthPath);
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ up, log: readLogTail(logFile) }));
      });
    },
  };

  const configureProxy = (proxy: any) => {
    proxy.on("error", (_err: unknown, _req: unknown, res: any) => {
      serveBackendDown(res, html);
    });
  };

  return { plugin, configureProxy };
}

// backendUp resolves true once the backend answers healthPath with a non-5xx
// status (up AND ready). A 5xx, transport error, or timeout is treated as down.
export function backendUp(target: string, healthPath = "/healthz"): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get(new URL(healthPath, target), { timeout: 800 }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      finish(code >= 200 && code < 500);
    });
    req.on("error", () => finish(false));
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
  });
}

// readLogTail returns the last maxBytes of logFile, or a short note if unreadable.
export function readLogTail(logFile: string, maxBytes = 20000): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(logFile, "r");
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch (e) {
    return `(${logFile} unavailable: ${(e as Error).message})`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// serveBackendDown writes the interstitial on a proxy error. A failed WS upgrade
// passes a net.Socket (no writeHead) — destroy it; the client reconnects.
export function serveBackendDown(res: any, html: string): void {
  if (typeof res.writeHead !== "function") {
    try {
      res.destroy();
    } catch {
      /* socket already gone */
    }
    return;
  }
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(503, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
  }
  res.end(html);
}

// interstitial builds the dark recovery page. It carries @vite/client (so a
// clean restart's /__reload push reloads it) and polls statusPath every 1s,
// reloading when the backend is up.
function interstitial(statusPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backend restarting…</title>
<script type="module" src="/@vite/client"></script>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body { font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #0b0d10; color: #e6e6e6; display: flex; flex-direction: column; }
  header { padding: 16px 20px; border-bottom: 1px solid #23262b; flex: none; }
  h1 { font-size: 15px; margin: 0 0 6px; }
  #status { color: #f0b429; }
  .hint { color: #6b7280; font-size: 12px; margin-top: 4px; }
  pre { margin: 0; padding: 16px 20px; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: #c9d1d9; background: #0b0d10; flex: 1 1 auto; min-height: 0; overflow: auto; }
</style>
</head>
<body>
<header>
  <h1>Backend unavailable</h1>
  <div id="status">checking…</div>
  <div class="hint">Vite is up; waiting on the Go server. This page reloads automatically when it returns. Tail of the dev log below.</div>
</header>
<pre id="log">loading…</pre>
<script>
(function () {
  var statusEl = document.getElementById("status");
  var logEl = document.getElementById("log");
  var tries = 0;
  function poll() {
    tries++;
    fetch("${statusPath}", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      if (s.log) { logEl.textContent = s.log; logEl.scrollTop = logEl.scrollHeight; }
      if (s.up) { statusEl.textContent = "back up — reloading…"; location.reload(); return; }
      statusEl.textContent = "Go server down — retrying (attempt " + tries + ", " + new Date().toLocaleTimeString() + ")";
      setTimeout(poll, 1000);
    }).catch(function (e) {
      statusEl.textContent = "dev status check failed: " + e;
      setTimeout(poll, 1000);
    });
  }
  poll();
})();
</script>
</body>
</html>`;
}
