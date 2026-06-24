# @gsxhq/vite-plugin-gsx

Vite dev plugin for [gsx](https://github.com/gsxhq/gsx) — watches `.gsx` files, runs `gsx generate`, shows compile errors in the Vite overlay, and triggers a full browser reload after the Go server reboots.

Because gsx renders HTML **server-side**, there is no JavaScript module graph to hot-replace. The plugin does not use Vite HMR; instead it re-generates the `.x.go` files, waits for the Go binary to restart, and then issues a **full-reload** driven by a POST from the Go server — not by the file-change event itself. This keeps the browser tab pointing at a live server, never at stale generated code.

---

## Install

```bash
npm i -D @gsxhq/vite-plugin-gsx
```

### Prerequisite: `go tool gsx`

The default command is `go tool gsx generate`. Register the tool in your Go module once:

```bash
go get -tool github.com/gsxhq/gsx/cmd/gsx
```

After this, `go tool gsx generate` works without a separate install step and is pinned to your `go.mod` version. If you maintain a custom `cmd/gsx` in your own repo, override the command option instead (see [Options](#options)).

---

## Quick start

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { gsx } from "@gsxhq/vite-plugin-gsx";

// Example dev config: Vite is the front door and proxies non-Vite routes to the
// Go server, so the injected @vite/client socket survives Go rebuilds.
export default defineConfig({
  plugins: [
    gsx({
      // Default is ["go","tool","gsx","generate"]; override for a custom cmd/gsx:
      // command: ["go", "run", "./cmd/gsx", "generate"],
    }),
  ],
  server: {
    proxy: {
      "^(?!/@vite|/@id|/node_modules).*": {
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
```

This config is also present at [`examples/vite.config.ts`](examples/vite.config.ts) and is type-checked on every CI run (`npm run typecheck:example`).

---

## How the loop works

```
save .gsx file
    │
    ▼
vite-plugin-gsx: watcher fires
    │  debounce 50 ms
    ▼
go tool gsx generate   ← regenerates .x.go files
    │  ok → nothing broadcast (wait for Go server)
    │  err → error overlay shown in browser
    ▼
wgo / air: detects .go change, rebuilds and restarts Go binary
    │
    ▼
Go binary boots → calls NotifyViteReload(viteDevURL)
    │  POST /__reload
    ▼
vite-plugin-gsx: receives POST → server.ws.send({ type: "full-reload" })
    │
    ▼
browser tab reloads, fetches fresh HTML from the new Go server
```

**Key invariant:** the browser reload is triggered by the Go POST, not by the `.gsx` file change. The plugin does not broadcast a reload immediately after `gsx generate` succeeds — it waits for the Go server to be up and ready before reloading the browser. This prevents the browser from loading a page from a server that is still mid-restart.

---

## Project-side glue (three pieces)

The plugin handles the Vite side. Your Go project needs three corresponding pieces.

### 1. Proxy

Add the proxy block to your `vite.config.ts` (shown in the quick start above). This makes Vite the front door: asset and HMR WebSocket routes stay with Vite; everything else — your actual HTML pages — is proxied to the Go server on port 8080. The `@vite/client` WebSocket connection is maintained across Go rebuilds because it connects to Vite, not to Go.

```ts
server: {
  proxy: {
    "^(?!/@vite|/@id|/node_modules).*": {
      target: "http://localhost:8080",
      changeOrigin: true,
      ws: true,
    },
  },
},
```

### 2. `@vite/client` script in the layout

The browser needs the `@vite/client` script to receive the full-reload signal. Inject it in your root layout, gated on the dev environment variable so it never ships to production:

```gsx
component Layout(title string) {
  <head>
    <title>{title}</title>
    if dev { <script type="module" src="/@vite/client"></script> }
  </head>
}
```

The `dev` identifier resolves to `true` when gsx is generating with the dev flag (set by the plugin automatically). In production, the `if dev` branch is omitted and the script tag is never emitted.

### 3. `NotifyViteReload` — Go boot hook

After your Go server starts (or restarts after a wgo rebuild), call `NotifyViteReload` with the Vite dev server URL. This fires a POST to `/__reload`, which the plugin receives and forwards to the browser as a full-reload.

```go
// NotifyViteReload pokes the Vite dev server after this binary boots so any
// browser tab holding an @vite/client socket reloads. Dev-only: no-ops when
// VITE_DEV_URL is unset.
func NotifyViteReload(viteDevURL string) {
    if viteDevURL == "" {
        return
    }
    go func() {
        ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
        defer cancel()
        for range 10 {
            req, err := http.NewRequestWithContext(ctx, http.MethodPost, viteDevURL+"/__reload", nil)
            if err != nil {
                return
            }
            if resp, err := http.DefaultClient.Do(req); err == nil {
                resp.Body.Close()
                return
            }
            select {
            case <-ctx.Done():
                return
            case <-time.After(150 * time.Millisecond):
            }
        }
    }()
}
```

Pass `os.Getenv("VITE_DEV_URL")` (e.g. `http://localhost:5173`) when starting the server in dev mode. In production, leave `VITE_DEV_URL` unset and the function is a no-op.

### `wgo` for Go rebuilds

The plugin only regenerates `.x.go` files; it does not rebuild or restart the Go binary. Use `wgo` (or `air`) to watch `.go` files and rebuild:

```bash
go tool wgo -file=.go go build -o tmp/app ./cmd/app :: tmp/app
```

`wgo` rebuilds and restarts `tmp/app` on any `.go` change, including the `.x.go` files that `gsx generate` just wrote. After restart, the new binary calls `NotifyViteReload` and the browser reloads.

---

## Options

All options are optional. Omit them entirely to use the defaults.

| Option | Type | Default | Description |
|---|---|---|---|
| `command` | `string[]` | `["go","tool","gsx","generate"]` | Command and leading args to invoke gsx. Override with `["go","run","./cmd/gsx","generate"]` for a local binary. |
| `paths` | `string[]` | `["."]` | Path args passed to `generate`. Narrows which packages are regenerated. |
| `watch` | `string \| string[]` | `"**/*.gsx"` | Glob(s) whose changes trigger regeneration. Relative to the Vite config root. |
| `cwd` | `string` | Vite config root | Working directory for the generate command. |
| `reloadEndpoint` | `string` | `"/__reload"` | HTTP endpoint the Go server POSTs to trigger a full browser reload. |
| `debounce` | `number` | `50` | Debounce window in milliseconds for rapid saves before running generate. |
| `generateOnStart` | `boolean` | `true` | Run an initial `gsx generate` when the Vite dev server starts, so `.x.go` files exist from the first boot. |

---

## Notes

- **Dev-only.** The plugin sets `apply: "serve"` and is excluded from production builds. It has no effect on `vite build`.
- **Production generation.** Run `gsx generate` in CI or via a `//go:generate` directive. The plugin is not involved.
- **Full-reload only.** gsx renders HTML server-side, so there is no JavaScript module graph to partially update. Every change results in a full page reload, not a component-level HMR update.
