import { describe, it, expect } from "vitest";
import { gsx } from "../src/index.js";

describe("scaffold", () => {
  it("exports a plugin factory with the right name", () => {
    const plugin = gsx();
    expect(plugin.name).toBe("vite-plugin-gsx");
    expect(plugin.apply).toBe("serve");
  });
});
