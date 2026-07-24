import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { resolveOptions, resolveDevPanel } from "../src/options.js";

describe("resolveOptions", () => {
  it("applies all defaults when user passes nothing", () => {
    const r = resolveOptions({}, "/proj");
    expect(r.daemon).toBe(false);
    expect(r.command).toEqual(["go", "tool", "gsx", "generate"]);
    expect(r.paths).toEqual(["."]);
    expect(r.watch).toEqual(["**/*.gsx"]);
    expect(r.cwd).toBe("/proj");
    expect(r.reloadEndpoint).toBe("/__reload");
    expect(r.debounce).toBe(50);
    expect(r.generateOnStart).toBe(true);
    expect(r.devPanel).toEqual({ enabled: true, key: "d" });
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
        daemon: true,
        generateOnStart: false,
      },
      "/proj",
    );
    expect(r.command).toEqual(["go", "run", "./cmd/gsx", "generate"]);
    expect(r.paths).toEqual(["./views"]);
    expect(r.cwd).toBe("/elsewhere");
    expect(r.reloadEndpoint).toBe("/__reload2");
    expect(r.debounce).toBe(120);
    expect(r.daemon).toBe(true);
    expect(r.generateOnStart).toBe(false);
  });
});

describe("resolveDevPanel", () => {
  it("defaults to enabled, key 'd'", () => {
    expect(resolveDevPanel(undefined)).toEqual({ enabled: true, key: "d" });
  });

  it("true is equivalent to the default", () => {
    expect(resolveDevPanel(true)).toEqual({ enabled: true, key: "d" });
  });

  it("false disables the panel", () => {
    expect(resolveDevPanel(false)).toEqual({ enabled: false, key: "d" });
  });

  it("{ key } enables with a custom key", () => {
    expect(resolveDevPanel({ key: "k" })).toEqual({ enabled: true, key: "k" });
  });

  it("lowercases the key", () => {
    expect(resolveDevPanel({ key: "K" })).toEqual({ enabled: true, key: "k" });
  });

  it("{} with no key falls back to the default key", () => {
    expect(resolveDevPanel({})).toEqual({ enabled: true, key: "d" });
  });

  it("an invalid key (not a single a-z/0-9 char) falls back to 'd' silently", () => {
    expect(resolveDevPanel({ key: "shift" })).toEqual({ enabled: true, key: "d" });
    expect(resolveDevPanel({ key: "" })).toEqual({ enabled: true, key: "d" });
    expect(resolveDevPanel({ key: "!" })).toEqual({ enabled: true, key: "d" });
    expect(resolveDevPanel({ key: "-" })).toEqual({ enabled: true, key: "d" });
  });
});

describe("resolveOptions devPanel plumbing", () => {
  it("threads devPanel through resolveOptions", () => {
    expect(resolveOptions({ devPanel: false }, "/proj").devPanel).toEqual({
      enabled: false,
      key: "d",
    });
    expect(resolveOptions({ devPanel: { key: "K" } }, "/proj").devPanel).toEqual({
      enabled: true,
      key: "k",
    });
  });
});

describe("resolveOptions devLogPath", () => {
  const savedEnv = process.env.GSX_DEV_LOG;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GSX_DEV_LOG;
    else process.env.GSX_DEV_LOG = savedEnv;
  });

  it("is null with no option and no env var", () => {
    delete process.env.GSX_DEV_LOG;
    expect(resolveOptions({}, "/proj").devLogPath).toBeNull();
  });

  it("devLog: false disables it even with the env var set", () => {
    process.env.GSX_DEV_LOG = "/abs/env.log";
    expect(resolveOptions({ devLog: false }, "/proj").devLogPath).toBeNull();
  });

  it('devLog: "" is treated as disabled, not resolved to the root directory', () => {
    delete process.env.GSX_DEV_LOG;
    expect(resolveOptions({ devLog: "" }, "/proj").devLogPath).toBeNull();
  });

  it("a relative devLog option resolves against root", () => {
    delete process.env.GSX_DEV_LOG;
    expect(resolveOptions({ devLog: "custom.log" }, "/proj").devLogPath).toBe(
      resolve("/proj", "custom.log"),
    );
  });

  it("the devLog option overrides the env var", () => {
    process.env.GSX_DEV_LOG = "/abs/env.log";
    expect(resolveOptions({ devLog: "custom.log" }, "/proj").devLogPath).toBe(
      resolve("/proj", "custom.log"),
    );
  });

  it("an absolute GSX_DEV_LOG (the gsx dev contract) passes through resolve() unchanged", () => {
    process.env.GSX_DEV_LOG = "/abs/env.log";
    expect(resolveOptions({}, "/proj").devLogPath).toBe("/abs/env.log");
  });

  it("a relative GSX_DEV_LOG resolves against root, same as the option path", () => {
    process.env.GSX_DEV_LOG = "relative/env.log";
    expect(resolveOptions({}, "/proj").devLogPath).toBe(resolve("/proj", "relative/env.log"));
  });

  it("an empty-string GSX_DEV_LOG is treated as disabled", () => {
    process.env.GSX_DEV_LOG = "";
    expect(resolveOptions({}, "/proj").devLogPath).toBeNull();
  });
});
