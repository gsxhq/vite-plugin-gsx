import { describe, it, expect } from "vitest";
import { isToggleKey, isEditable, renderStatus, buttonsDisabled } from "../src/client-logic.js";

const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: "d", metaKey: false, ctrlKey: false, altKey: false, ...over,
});

describe("isToggleKey", () => {
  it("cmd-d and ctrl-d toggle", () => {
    expect(isToggleKey(key({ metaKey: true }), false)).toBe(true);
    expect(isToggleKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isToggleKey(key({ key: "D", ctrlKey: true }), false)).toBe(true);
  });
  it("plain d, alt-d, other keys don't", () => {
    expect(isToggleKey(key(), false)).toBe(false);
    expect(isToggleKey(key({ metaKey: true, altKey: true }), false)).toBe(false);
    expect(isToggleKey(key({ key: "e", metaKey: true }), false)).toBe(false);
  });
  it("suppressed while editing", () => {
    expect(isToggleKey(key({ metaKey: true }), true)).toBe(false);
  });
});

describe("isEditable", () => {
  it("input/textarea/select and contenteditable are editable", () => {
    expect(isEditable({ tagName: "INPUT" })).toBe(true);
    expect(isEditable({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditable({ tagName: "SELECT" })).toBe(true);
    expect(isEditable({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("plain elements and null are not", () => {
    expect(isEditable({ tagName: "DIV" })).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe("renderStatus", () => {
  const status = {
    phase: "idle",
    server: { healthy: true, port: "7777" },
    lastCycle: { ok: true, errors: 0, at: "2026-07-23T10:00:00Z" },
    frontDoor: { state: "up", restarts: 1 },
  };
  it("renders the key facts", () => {
    const html = renderStatus(status);
    for (const frag of ["idle", "7777", "healthy", "up"]) {
      expect(html).toContain(frag);
    }
  });
  it("handles missing status", () => {
    expect(renderStatus(null)).toContain("waiting for status");
  });
  it("prompts to check gsx dev while no status has arrived", () => {
    expect(renderStatus(null)).toContain("waiting for status… (is gsx dev running?)");
  });
  it("escapes injected strings", () => {
    const html = renderStatus({ ...status, phase: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img");
  });
});

describe("buttonsDisabled", () => {
  it("disabled before the first status arrives, regardless of inflight", () => {
    expect(buttonsDisabled(null, false)).toBe(true);
    expect(buttonsDisabled(null, true)).toBe(true);
  });
  it("disabled while a command is inflight, once status has arrived", () => {
    expect(buttonsDisabled({ phase: "idle" }, true)).toBe(true);
  });
  it("enabled once status has arrived and nothing is inflight", () => {
    expect(buttonsDisabled({ phase: "idle" }, false)).toBe(false);
  });
});
