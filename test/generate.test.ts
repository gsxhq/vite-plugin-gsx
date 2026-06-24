import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGenerate } from "../src/generate.js";

const fakeGsx = fileURLToPath(
  new URL("./fixtures/fake-gsx.mjs", import.meta.url),
);

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "gsx-gen-"));
});

describe("runGenerate", () => {
  it("returns ok on a clean run and invokes the command once", async () => {
    const r = await runGenerate({
      command: ["node", fakeGsx],
      paths: ["."],
      cwd,
    });
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([]);
    expect(readFileSync(join(cwd, "gsx-ran.log"), "utf8").trim()).toBe("ok");
  });

  it("parses --json diagnostics on failure", async () => {
    const r = await runGenerate({
      command: ["node", fakeGsx, "--mode=fail"],
      paths: ["."],
      cwd,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toBe("mismatched close tag");
    expect(r.diagnostics[0]!.severity).toBe("error");
  });

  it("synthesizes a diagnostic when stdout is not JSON", async () => {
    const r = await runGenerate({
      command: ["node", fakeGsx, "--mode=badjson"],
      paths: ["."],
      cwd,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.severity).toBe("error");
  });

  it("synthesizes a diagnostic from stderr on a usage/crash exit", async () => {
    const r = await runGenerate({
      command: ["node", fakeGsx, "--mode=crash"],
      paths: ["."],
      cwd,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toContain("boom");
  });

  it("returns a remediation diagnostic when the binary cannot be spawned", async () => {
    const r = await runGenerate({
      command: ["definitely-not-a-real-binary-xyz"],
      paths: ["."],
      cwd,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message.toLowerCase()).toContain("gsx");
  });
});
