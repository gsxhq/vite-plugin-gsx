import { createServer as createViteServer, type InlineConfig } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Parallel Vite servers must not delete or rebuild another server's optimizer cache.
export async function createServer(config: InlineConfig = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "gsx-vite-cache-"));
  try {
    const server = await createViteServer({ ...config, cacheDir });
    const close = server.close.bind(server);
    server.close = async () => {
      try {
        await close();
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    };
    return server;
  } catch (error) {
    rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
