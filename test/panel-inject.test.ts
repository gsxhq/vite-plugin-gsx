import { describe, it, expect } from "vitest";
import { createServer } from "vite";
import { gsx } from "../src/index.js";

describe("panel injection", () => {
  it("injects the panel script into index.html", async () => {
    const server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { port: 0 },
      plugins: [gsx({ generateOnStart: false })],
    });
    await server.listen();
    try {
      const html = await server.transformIndexHtml("/", "<html><head></head><body></body></html>");
      expect(html).toContain("/__gsx/panel.js");
    } finally {
      await server.close();
    }
  });
});
