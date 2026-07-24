import { describe, it, expect } from "vitest";
import {
  isToggleKey,
  isEditable,
  renderStatus,
  buttonsDisabled,
  autoShowDelay,
  DEFAULT_AUTO_SHOW_MS,
  phaseLine,
  initialPanelState,
  onStatus,
  onTimerFired,
  onToggleKey,
  type PanelState,
  logBoxState,
  logTruncationBanner,
} from "../src/client-logic.js";

const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: "d", metaKey: false, ctrlKey: false, altKey: false, ...over,
});

describe("isToggleKey", () => {
  it("cmd-d and ctrl-d toggle", () => {
    expect(isToggleKey(key({ metaKey: true }), false, "d")).toBe(true);
    expect(isToggleKey(key({ ctrlKey: true }), false, "d")).toBe(true);
    expect(isToggleKey(key({ key: "D", ctrlKey: true }), false, "d")).toBe(true);
  });
  it("plain d, alt-d, other keys don't", () => {
    expect(isToggleKey(key(), false, "d")).toBe(false);
    expect(isToggleKey(key({ metaKey: true, altKey: true }), false, "d")).toBe(false);
    expect(isToggleKey(key({ key: "e", metaKey: true }), false, "d")).toBe(false);
  });
  it("suppressed while editing", () => {
    expect(isToggleKey(key({ metaKey: true }), true, "d")).toBe(false);
  });
  it("honors a custom key, compared case-insensitively", () => {
    expect(isToggleKey(key({ key: "k", ctrlKey: true }), false, "k")).toBe(true);
    expect(isToggleKey(key({ key: "K", ctrlKey: true }), false, "k")).toBe(true);
    expect(isToggleKey(key({ key: "k", ctrlKey: true }), false, "K")).toBe(true);
    // the default "d" no longer matches once the key is rebound
    expect(isToggleKey(key({ key: "d", ctrlKey: true }), false, "k")).toBe(false);
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

describe("renderStatus — server upstream", () => {
  it("renders the resolved upstream origin when present", () => {
    const html = renderStatus({ server: { upstream: "http://localhost:8890", healthy: true } });
    expect(html).toContain("http://localhost:8890");
    expect(html).toContain("healthy");
  });
  it("falls back to :port when upstream is absent (older gsx dev)", () => {
    const html = renderStatus({ server: { port: "7777", healthy: true } });
    expect(html).toContain(":7777");
  });
  it("degrades sanely when both upstream and port are absent", () => {
    const html = renderStatus({ server: { healthy: false } });
    expect(html).not.toContain("undefined");
  });
  it("escapes the upstream string (another process's output)", () => {
    const html = renderStatus({ server: { upstream: "<img src=x onerror=alert(1)>", healthy: true } });
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

describe("autoShowDelay", () => {
  it("defaults to 3000ms when autoShow is absent", () => {
    expect(autoShowDelay({})).toBe(DEFAULT_AUTO_SHOW_MS);
  });
  it("false disables auto-show (null)", () => {
    expect(autoShowDelay({ autoShow: false })).toBeNull();
  });
  it("honors a valid non-negative number, including 0", () => {
    expect(autoShowDelay({ autoShow: 5000 })).toBe(5000);
    expect(autoShowDelay({ autoShow: 0 })).toBe(0);
  });
  it("falls back to the default for negative, NaN, or non-finite values", () => {
    expect(autoShowDelay({ autoShow: -1 })).toBe(DEFAULT_AUTO_SHOW_MS);
    expect(autoShowDelay({ autoShow: NaN })).toBe(DEFAULT_AUTO_SHOW_MS);
    expect(autoShowDelay({ autoShow: Infinity })).toBe(DEFAULT_AUTO_SHOW_MS);
  });
});

describe("phaseLine", () => {
  const now = Date.parse("2026-07-24T12:00:42Z");
  it("full line: phase + elapsed + last cycle", () => {
    const status = {
      phase: "building",
      phaseSince: "2026-07-24T12:00:00Z",
      lastCycle: { durationMs: 130000 },
    };
    expect(phaseLine(status, now)).toBe("building… started 42s ago · last cycle 2m10s");
  });
  it("omits the elapsed segment when phaseSince is absent (old gsx dev)", () => {
    const status = { phase: "building", lastCycle: { durationMs: 130000 } };
    expect(phaseLine(status, now)).toBe("building… · last cycle 2m10s");
  });
  it("omits the last-cycle segment when lastCycle/durationMs is absent", () => {
    const status = { phase: "building", phaseSince: "2026-07-24T12:00:00Z" };
    expect(phaseLine(status, now)).toBe("building… started 42s ago");
  });
  it("bare phase when both are absent (old gsx dev, first cycle)", () => {
    expect(phaseLine({ phase: "building" }, now)).toBe("building…");
  });
  it("never renders undefined/NaN for a malformed phaseSince", () => {
    const status = { phase: "building", phaseSince: "not-a-date" };
    const line = phaseLine(status, now);
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("NaN");
    expect(line).toBe("building…");
  });
  it("never renders undefined/NaN for a non-numeric durationMs", () => {
    const status = { phase: "building", lastCycle: { durationMs: "oops" } };
    const line = phaseLine(status, now);
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("NaN");
    expect(line).toBe("building…");
  });
  it("humanizes durations under a minute as plain seconds", () => {
    const status = { phase: "generating", phaseSince: "2026-07-24T12:00:41Z" };
    expect(phaseLine(status, now)).toBe("generating… started 1s ago");
  });
  it("ticks: a later nowMs advances the elapsed segment", () => {
    const status = { phase: "building", phaseSince: "2026-07-24T12:00:00Z" };
    expect(phaseLine(status, now + 1000)).toBe("building… started 43s ago");
  });
  it("empty string when status/phase is absent", () => {
    expect(phaseLine(null, now)).toBe("");
    expect(phaseLine({}, now)).toBe("");
  });
});

describe("panel open-state machine", () => {
  it("a non-idle status starts the auto-show timer from rest", () => {
    const { state, actions } = onStatus(initialPanelState, "generating", 3000);
    expect(state).toEqual({ visible: false, openedBy: null, timerActive: true });
    expect(actions).toEqual({ startTimer: true });
  });

  it("a later non-idle phase transition does not restart an already-running timer", () => {
    const timing: PanelState = { visible: false, openedBy: null, timerActive: true };
    const { state, actions } = onStatus(timing, "building", 3000);
    expect(state).toEqual(timing);
    expect(actions).toEqual({});
  });

  it("idle before expiry cancels the pending timer", () => {
    const timing: PanelState = { visible: false, openedBy: null, timerActive: true };
    const { state, actions } = onStatus(timing, "idle", 3000);
    expect(state).toEqual({ visible: false, openedBy: null, timerActive: false });
    expect(actions).toEqual({ cancelTimer: true });
  });

  it("timer expiry while still non-idle auto-opens the panel", () => {
    const timing: PanelState = { visible: false, openedBy: null, timerActive: true };
    expect(onTimerFired(timing)).toEqual({ visible: true, openedBy: "auto", timerActive: false });
  });

  it("a stale timer firing after cancellation is a no-op", () => {
    const cancelled: PanelState = { visible: false, openedBy: null, timerActive: false };
    expect(onTimerFired(cancelled)).toBe(cancelled);
  });

  it("idle auto-closes an auto-opened panel", () => {
    const autoOpen: PanelState = { visible: true, openedBy: "auto", timerActive: false };
    const { state, actions } = onStatus(autoOpen, "idle", 3000);
    expect(state).toEqual({ visible: false, openedBy: null, timerActive: false });
    expect(actions).toEqual({});
  });

  it("idle does NOT close a manually-opened panel", () => {
    const userOpen: PanelState = { visible: true, openedBy: "user", timerActive: false };
    const { state, actions } = onStatus(userOpen, "idle", 3000);
    expect(state).toEqual(userOpen);
    expect(actions).toEqual({});
  });

  it("a non-idle status while already visible does not (re)start a timer", () => {
    const userOpen: PanelState = { visible: true, openedBy: "user", timerActive: false };
    const { state, actions } = onStatus(userOpen, "building", 3000);
    expect(state).toEqual(userOpen);
    expect(actions).toEqual({});
  });

  it("Cmd-D opens as user-owned and cancels a pending auto-show timer", () => {
    const timing: PanelState = { visible: false, openedBy: null, timerActive: true };
    const { state, actions } = onToggleKey(timing);
    expect(state).toEqual({ visible: true, openedBy: "user", timerActive: false });
    expect(actions).toEqual({ cancelTimer: true });
  });

  it("Cmd-D opens as user-owned with no timer to cancel from rest", () => {
    const { state, actions } = onToggleKey(initialPanelState);
    expect(state).toEqual({ visible: true, openedBy: "user", timerActive: false });
    expect(actions).toEqual({});
  });

  it("Cmd-D always closes an open panel, auto- or user-opened", () => {
    const autoOpen: PanelState = { visible: true, openedBy: "auto", timerActive: false };
    expect(onToggleKey(autoOpen)).toEqual({
      state: { visible: false, openedBy: null, timerActive: false },
      actions: {},
    });
    const userOpen: PanelState = { visible: true, openedBy: "user", timerActive: false };
    expect(onToggleKey(userOpen)).toEqual({
      state: { visible: false, openedBy: null, timerActive: false },
      actions: {},
    });
  });

  it("autoShow:false (autoShowMs null) disables the timer entirely regardless of phase", () => {
    const { state, actions } = onStatus(initialPanelState, "building", null);
    expect(state).toEqual(initialPanelState);
    expect(actions).toEqual({});
    const { state: idleState, actions: idleActions } = onStatus(initialPanelState, "idle", null);
    expect(idleState).toEqual(initialPanelState);
    expect(idleActions).toEqual({});
  });
});

describe("logBoxState", () => {
  it("never shows or polls without a successful probe", () => {
    expect(logBoxState("unknown", "building", true)).toEqual({ expanded: false, polling: false });
    expect(logBoxState("unavailable", "building", true)).toEqual({ expanded: false, polling: false });
  });
  it("expands and polls while building/starting, probed available, and visible", () => {
    expect(logBoxState("available", "building", true)).toEqual({ expanded: true, polling: true });
    expect(logBoxState("available", "starting", true)).toEqual({ expanded: true, polling: true });
  });
  it("does not expand outside building/starting (e.g. generating, idle)", () => {
    expect(logBoxState("available", "generating", true)).toEqual({ expanded: false, polling: false });
    expect(logBoxState("available", "idle", true)).toEqual({ expanded: false, polling: false });
  });
  it("idle makes zero polling requests even if probed available", () => {
    expect(logBoxState("available", "idle", true).polling).toBe(false);
  });
  it("hidden makes zero polling requests even mid-build with a successful probe", () => {
    const { polling } = logBoxState("available", "building", false);
    expect(polling).toBe(false);
  });
});

describe("logTruncationBanner", () => {
  it("no banner at offset 0 (untruncated)", () => {
    expect(logTruncationBanner(0)).toBeNull();
  });
  it("banner when the offset is positive (truncated)", () => {
    expect(logTruncationBanner(42)).toBe("earlier output truncated");
  });
  it("no banner when the offset is absent", () => {
    expect(logTruncationBanner(undefined)).toBeNull();
    expect(logTruncationBanner(null)).toBeNull();
  });
});
