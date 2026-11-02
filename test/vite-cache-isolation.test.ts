import { expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "./vite-test-server.js";

it("keeps concurrent server caches independent and removes them on close", async () => {
  const servers = await Promise.all([0, 1].map(() => createServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false },
  })));
  try {
    const [first, second] = servers;
    expect(first!.config.cacheDir).not.toBe(second!.config.cacheDir);
    const marker = join(second!.config.cacheDir, "owned-by-second");
    writeFileSync(marker, "second");
    await first!.close();
    expect(existsSync(first!.config.cacheDir)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("second");
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
  for (const server of servers) expect(existsSync(server.config.cacheDir)).toBe(false);
}, 15000);
