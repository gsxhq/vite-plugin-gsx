import { describe, it, expect } from "vitest";
import { resolveOptions } from "../src/options.js";

describe("resolveOptions", () => {
  it("applies all defaults when user passes nothing", () => {
    const r = resolveOptions({}, "/proj");
    expect(r.command).toEqual(["go", "tool", "gsx", "generate"]);
    expect(r.paths).toEqual(["."]);
    expect(r.watch).toEqual(["**/*.gsx"]);
    expect(r.cwd).toBe("/proj");
    expect(r.reloadEndpoint).toBe("/__reload");
    expect(r.debounce).toBe(50);
    expect(r.generateOnStart).toBe(true);
  });

  it("normalizes a string watch into an array", () => {
    const r = resolveOptions({ watch: "src/**/*.gsx" }, "/proj");
    expect(r.watch).toEqual(["src/**/*.gsx"]);
  });

  it("honors overrides, including generateOnStart:false and a custom command", () => {
    const r = resolveOptions(
      {
        command: ["go", "run", "./cmd/gsx", "generate"],
        paths: ["./views"],
        cwd: "/elsewhere",
        reloadEndpoint: "/__reload2",
        debounce: 120,
        generateOnStart: false,
      },
      "/proj",
    );
    expect(r.command).toEqual(["go", "run", "./cmd/gsx", "generate"]);
    expect(r.paths).toEqual(["./views"]);
    expect(r.cwd).toBe("/elsewhere");
    expect(r.reloadEndpoint).toBe("/__reload2");
    expect(r.debounce).toBe(120);
    expect(r.generateOnStart).toBe(false);
  });
});
