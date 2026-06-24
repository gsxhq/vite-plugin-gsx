import { readFileSync } from "node:fs";
import { relative } from "node:path";
import picomatch from "picomatch";
import type { Plugin, ViteDevServer } from "vite";
import { resolveOptions, type GsxOptions } from "./options.js";
import { runGenerate } from "./generate.js";
import { toViteError } from "./diagnostics.js";

export type { GsxOptions };

export function gsx(options: GsxOptions = {}): Plugin {
  return {
    name: "vite-plugin-gsx",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      const opts = resolveOptions(options, server.config.root);
      const isMatch = picomatch(opts.watch);
      const logger = server.config.logger;

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

      // 2. Run gsx generate; show or clear the overlay. Never broadcasts a
      //    reload — that is the Go-POST's job, so we only reload once the new
      //    binary is up.
      async function generate() {
        const result = await runGenerate({
          command: opts.command,
          paths: opts.paths,
          cwd: opts.cwd,
        });
        if (result.ok) return;
        const err = toViteError(result.diagnostics, readSource);
        if (err) {
          for (const d of result.diagnostics) {
            logger.error(`[vite-plugin-gsx] ${d.file}: ${d.message}`, {
              timestamp: true,
            });
          }
          server.ws.send({ type: "error", err });
        }
      }

      // 3. Debounced watcher over the .gsx globs.
      let timer: ReturnType<typeof setTimeout> | undefined;
      function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void generate(), opts.debounce);
      }
      // Watch globs are relative to cwd; chokidar reports absolute paths, so
      // match on the path relative to cwd (no string munging).
      function onChange(file: string) {
        if (isMatch(relative(opts.cwd, file))) schedule();
      }
      server.watcher.on("change", onChange);
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);

      // 4. Initial generate so .x.go exist on first boot.
      if (opts.generateOnStart) void generate();
    },
  };
}

function readSource(file: string): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export default gsx;
