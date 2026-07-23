# @gsxhq/vite-plugin-gsx

Vite dev plugin for [gsx](https://github.com/gsxhq/gsx). It makes Vite the dev
front door for a server-rendered gsx + Go app: it shows gsx compile errors in the
Vite error overlay and issues a full browser reload when the Go server is back up
after a rebuild.

Because gsx renders HTML **server-side**, there is no JavaScript module graph to
hot-replace. The plugin does not use Vite HMR; every change ends in a **full
page reload**, and that reload is timed to fire only once the Go server is up and
serving fresh code — so the browser tab never lands on a server that is mid-restart.

## Two ways to run

The plugin needs two things to happen on a `.gsx`/`.go` change: the `.x.go` files
get regenerated, and the browser gets told when to reload. **Who drives that** is
the choice:

- **With `gsx dev` (default, recommended).** [`gsx dev`](https://github.com/gsxhq/gsx)
  owns the whole loop — it regenerates (warm, in-process), rebuilds + restarts the
  Go server, and POSTs events to this plugin: codegen/build errors drive the
  overlay, and a reload ping fires once the server is healthy. The plugin just
  **receives** these. This is the default; `gsx()` spawns nothing.
- **Standalone (`gsx({ daemon: true })`).** No `gsx dev`. The plugin itself spawns
  a long-lived `gsx generate --watch` daemon to regenerate `.x.go` and drive the
  overlay, and **you** bring your own `.go` watcher (e.g. `wgo`) plus a Go-side
  `NotifyReload` call to trigger the browser reload. This is the v0.3.x behavior,
  kept as opt-in.

> **Requires:** the default (receive-events) mode needs a `gsx` that has the
> `gsx dev` command. If your `gsx` predates `gsx dev`, use `gsx({ daemon: true })`
> (or scaffold with `gsx init`, which wires the whole loop for you).

---

## Install

```bash
npm i -D @gsxhq/vite-plugin-gsx
```

The fastest way to get a correctly-wired project is `gsx init`, which scaffolds
the `vite.config.ts`, `.env`, and Go server for you and runs everything via
`gsx dev`. Fresh scaffolds leave the Vite port unset; `gsx dev` picks an
available front-door port and passes `VITE_PORT` / `VITE_DEV_URL` to Vite and the
Go server. The rest of this document is for understanding or hand-wiring that
setup.

### Prerequisite: `go tool gsx`

Register gsx as a Go tool in your module once:

```bash
go get -tool github.com/gsxhq/gsx/cmd/gsx
```

After this, `go tool gsx dev` / `go tool gsx generate` work without a separate
install and stay pinned to your `go.mod` version.

---

## Quick start (with `gsx dev`)

```ts
// vite.config.ts
import { defineConfig, loadEnv, createLogger } from "vite";
import { gsx, devFallback } from "@gsxhq/vite-plugin-gsx";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const goPort = env.GO_PORT || "7777";
  const vitePort = parseInt(env.VITE_PORT || "5173", 10);

  // Serve a self-recovering interstitial while the Go server is down/restarting
  // instead of showing a raw proxy error.
  const fallback = devFallback({ target: `http://localhost:${goPort}` });

  // The fallback page is the useful signal while the Go server is restarting,
  // so hide Vite's duplicate "http proxy error ... ECONNREFUSED" log line.
  const logger = createLogger();
  const baseError = logger.error;
  logger.error = (msg, opts) => {
    if (typeof msg === "string" && msg.includes("http proxy error")) return;
    baseError(msg, opts);
  };

  return {
    clearScreen: false,
    // Dev serves Vite assets under /__vite/ so app routes can own everything
    // else. Production keeps the default base because the Go server serves the
    // built manifest assets from /static.
    base: command === "serve" ? "/__vite/" : "/",
    publicDir: false,
    customLogger: logger,
    plugins: [
      gsx(),
      fallback.plugin,
      {
        name: "gsx-dev-url",
        configureServer(server) {
          server.printUrls = () => {
            server.config.logger.info(
              `\n  \x1b[32m➜\x1b[0m  Open \x1b[36mhttp://localhost:${vitePort}/\x1b[0m to view your app\n`,
            );
          };
        },
      },
    ],
    server: {
      port: vitePort,
      // `gsx dev` chooses an available VITE_PORT when one is not configured.
      // If you set VITE_PORT yourself, it is treated as explicit and gsx dev
      // exits if that port is already in use.
      strictPort: true,
      proxy: {
        // Everything except Vite's dev-asset namespace and the fallback status
        // endpoint goes to the Go server. Do not enable `ws: true`; the Go
        // server has no WebSocket, and proxying WS would capture Vite HMR.
        "^(?!/__vite/|/__dev).*": {
          target: `http://localhost:${goPort}`,
          changeOrigin: true,
          configure: fallback.configureProxy,
        },
      },
    },
  };
});
```

Then run the dev loop with **one** command:

```bash
go tool gsx dev      # or `npm run dev` if your package.json maps it
```

`gsx dev` starts Vite, builds + runs the Go server, watches `.gsx`/`.go`/`.env`,
and drives this plugin. You do **not** need `wgo`, a Taskfile, or a
`NotifyReload` call in your `main.go` — `gsx dev` owns reload timing.

When `VITE_PORT` is absent, `gsx dev` scans from 5173 upward and exports a
matching `VITE_DEV_URL`. When `VITE_PORT` is present, it is authoritative: if the
port is already in use, `gsx dev` exits before starting the Go server or watcher.

---

## How the loop works (default, with `gsx dev`)

```
edit .gsx / .go / .env
        │
        ▼
gsx dev: warm-regenerate .x.go → rebuild + restart the Go server (build-then-swap:
        a broken build keeps the last-good server up)
        │
        ├─ POST /__gsx/event  → this plugin: ok:false → Vite error overlay
        │                                     ok:true  → overlay cleared
        ▼
gsx dev: waits until the Go server answers /healthz, then
        │
        └─ POST /__reload     → this plugin: server.ws.send({ type: "full-reload" })
        ▼
browser reloads, fetching fresh HTML from the rebuilt Go server
```

**Key invariant:** the reload is timed by `gsx dev` (after the server is healthy),
not by the file-change event — so the browser never loads a page from a server
that is still mid-restart. The error overlay is event-driven and carries the
error text in the POST body, so it works even when no dev log file is written.

---

## Standalone mode (`gsx({ daemon: true })`)

Use this when you are **not** running `gsx dev` — Vite is your only long-lived dev
process. The plugin spawns one `gsx generate --watch --format=ndjson` daemon and
reads its NDJSON event stream to drive the overlay. You supply the two pieces
`gsx dev` would otherwise handle: a `.go` watcher and a Go-side reload ping.

```ts
plugins: [gsx({ daemon: true }), fallback.plugin]
```

### A `.go` watcher (rebuild + restart the Go binary)

The plugin only regenerates `.x.go`; it does not build or run your server.

```bash
go tool wgo -file=.go go build -o tmp/app ./cmd/app :: tmp/app
```

### A Go boot hook (trigger the browser reload)

After your server boots (including after a `wgo` restart), POST `/__reload` so the
browser reloads. The endpoint is the plugin's `reloadEndpoint` (default
`/__reload`). gsx's `github.com/gsxhq/vite` helper provides `vite.NotifyReload`:

```go
vite.NotifyReload(os.Getenv("VITE_DEV_URL")) // dev-only; no-op when unset
```

### A Vite client script in your layout

The browser needs Vite's client script to receive the full-reload signal. Inject
it in your root layout, gated on a dev boolean you control (for example
`VITE_DEV_URL != ""`). The path depends on your Vite dev `base`:

```gsx
// If base is the default "/":
if dev { <script type="module" src="/@vite/client"></script> }

// If base is "/__vite/" like the gsx init scaffold:
if dev { <script type="module" src="/__vite/@vite/client"></script> }
```

(`gsx init` + `gsx dev` handle all three of these for you, which is why the
default mode needs none of this section.)

---

## Options

All options are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `daemon` | `boolean` | `false` | Spawn a `gsx generate --watch` daemon and drive the overlay from its NDJSON, instead of receiving events from `gsx dev` over HTTP. Set `true` for standalone Vite (no `gsx dev`). |
| `command` | `string[]` | `["go","tool","gsx","generate"]` | Command + leading args for the daemon (only used when `daemon: true`). Override for a local `cmd/gsx`, e.g. `["go","run","./cmd/gsx","generate"]`. |
| `paths` | `string[]` | `["."]` | Path args passed to the daemon's `generate` (only used when `daemon: true`). |
| `cwd` | `string` | Vite config root | Working directory for the daemon command. |
| `reloadEndpoint` | `string` | `"/__reload"` | HTTP endpoint that triggers a full browser reload. `gsx dev` (or your Go `NotifyReload`) POSTs here. |
| ~~`watch`~~ | `string \| string[]` | — | **Deprecated / ignored.** The daemon owns watching. |
| ~~`debounce`~~ | `number` | — | **Deprecated / ignored.** The daemon owns debouncing. |
| ~~`generateOnStart`~~ | `boolean` | — | **Deprecated / ignored.** `gsx dev` / the daemon handle the initial generate. |

The plugin always registers `POST /__gsx/event` (the receive-events endpoint) and
`POST /__reload`, regardless of `daemon`.

---

## Dev fallback (backend-restart resilience)

`devFallback` wraps a second Vite plugin and a proxy `configure` hook that
together replace raw proxy errors (502/ECONNREFUSED) with a self-recovering
interstitial page while the Go backend is down or restarting.

**What it does:**

- Intercepts proxy errors and serves a dark-mode HTML interstitial instead of an
  empty browser error page.
- The interstitial carries Vite's client script, so the normal `/__reload` push
  reloads it when the Go server returns. No manual refresh is needed.
- It polls `/__dev/status` every second and reloads when the backend is healthy.
- `/__dev/status` tails a dev log if one is configured, so you can watch backend
  output in the browser.

**API:**

```ts
devFallback(opts: DevFallbackOptions): { plugin: Plugin; configureProxy: (proxy: any) => void }
```

| Option | Type | Default | Description |
|---|---|---|---|
| `target` | `string` | _(required)_ | Go upstream origin, e.g. `"http://localhost:7777"`. |
| `logFile` | `string` | `"tmp/dev.log"` | Dev log to tail in the interstitial. |
| `healthPath` | `string` | `"/healthz"` | Backend liveness endpoint your Go server exposes. |
| `statusPath` | `string` | `"/__dev/status"` | Status endpoint registered by the plugin. |

**About the dev log:** `gsx dev` keeps its backend log **off by default** (run
`gsx dev --log` to enable it, or `--log-file <path>`). When no log file exists,
the interstitial simply shows that the server is down without a tail — the error
**overlay** is unaffected because it is driven by the event POST, not the file. If
you want the in-page tail, run `gsx dev --log-file tmp/dev.log` and keep
`devFallback`'s default `logFile`. In standalone mode, point `logFile` at whatever
your runner writes (e.g. `… 2>&1 | tee tmp/dev.log`).

---

## Dev panel

Press **Cmd-D** / **Ctrl-D** in the browser to open a status overlay with
**Rebuild** and **Restart server** buttons, plus a live view of phase, Go
server health, last cycle, and front-door state. Since gsx apps have no Vite
`index.html`, add `import "virtual:gsx-devpanel";` to your client entry
(`gsx init` scaffolds already have it) — the id resolves to the panel client in
dev and to an empty module in production builds. It needs `gsx dev` on the
other end to act on button presses and push status (not the standalone
`daemon: true` mode). Commands ride a small mailbox this plugin drains via
long-poll — no extra port or listener.

## Notes

- **Dev-only.** The main plugin sets `apply: "serve"` and has no effect on
  `vite build`; the small always-applied companion just keeps the
  `virtual:gsx-devpanel` import resolving to an empty module in production.
- **Production generation.** Run `gsx generate` in CI or via a `//go:generate`
  directive. The plugin is not involved in production builds.
- **Full-reload only.** gsx renders HTML server-side, so there is no JS module
  graph to partially update — every change is a full page reload, never HMR.

## Releasing

Releases are one-click via the `Release` GitHub Actions workflow
(`workflow_dispatch`). It runs the test suite, bumps `package.json`, tags,
pushes to `main`, cuts a GitHub release, and publishes to npm.

Trigger from the CLI (`version` is `patch` / `minor` / `major`, or an explicit
version like `0.4.6`):

```bash
gh workflow run release.yml -f version=patch
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Or from the GitHub UI: Actions → Release → Run workflow.
