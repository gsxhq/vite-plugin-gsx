import { defineConfig, loadEnv, createLogger } from "vite";
import { gsx, devFallback } from "@gsxhq/vite-plugin-gsx";

// Example dev config for the default (with-`gsx dev`) mode: Vite is the front
// door and proxies non-Vite routes to the Go server, while `gsx dev` owns
// generation, the Go rebuild, and reload timing. `gsx()` takes no options here —
// it receives codegen events from `gsx dev` over HTTP. For standalone Vite (no
// `gsx dev`), pass `gsx({ daemon: true })` and run your own .go watcher.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const goPort = env.GO_PORT || "7777";
  const vitePort = parseInt(env.VITE_PORT || "5173", 10);
  const fallback = devFallback({ target: `http://localhost:${goPort}` });
  const logger = createLogger();
  const baseError = logger.error;
  logger.error = (msg, opts) => {
    if (typeof msg === "string" && msg.includes("http proxy error")) return;
    baseError(msg, opts);
  };

  return {
    clearScreen: false,
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
      strictPort: true,
      proxy: {
        "^(?!/__vite/|/__dev).*": {
          target: `http://localhost:${goPort}`,
          changeOrigin: true,
          configure: fallback.configureProxy,
        },
      },
    },
  };
});
