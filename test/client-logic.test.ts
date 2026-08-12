import { describe, it, expect } from "vitest";
import {
  isToggleKey,
  isEditable,
  renderStatus,
  buttonsDisabled,
  autoShowDelay,
  DEFAULT_AUTO_SHOW_MS,
  phaseLine,
  reloadNote,
  initialPanelState,
  onStatus,
  onTimerFired,
  onToggleKey,
  type PanelState,
  logBoxState,
  logTruncationBanner,
  normalizeLogText,
  defaultLogControls,
  applyLogControl,
  parseLogControls,
  serializeLogControls,
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
  it("idle: suppresses the elapsed head (renderStatus's phase row already says idle), keeps last cycle", () => {
    const status = {
      phase: "idle",
      phaseSince: "2026-07-24T12:00:00Z",
      lastCycle: { durationMs: 130000 },
    };
    expect(phaseLine(status, now)).toBe("last cycle 2m10s");
  });
  it("idle with no cycle yet: empty (a manually-opened panel on a fresh idle project shows no phase line)", () => {
    const status = { phase: "idle", phaseSince: "2026-07-24T12:00:00Z" };
    expect(phaseLine(status, now)).toBe("");
  });
  it("appends the reload reason after the cycle duration when lastCycle.reload is set", () => {
    const status = {
      phase: "building",
      phaseSince: "2026-07-24T12:00:00Z",
      lastCycle: { durationMs: 130000, reload: "changed Go source dep/dep.go" },
    };
    expect(phaseLine(status, now)).toBe(
      "building… started 42s ago · last cycle 2m10s — full reload: changed Go source dep/dep.go",
    );
  });
  it("idle + reload reason: last-cycle-only line still carries the note", () => {
    const status = {
      phase: "idle",
      lastCycle: { durationMs: 130000, reload: "changed Go source dep/dep.go" },
    };
    expect(phaseLine(status, now)).toBe("last cycle 2m10s — full reload: changed Go source dep/dep.go");
  });
  it("omits the reload note when lastCycle.reload is absent (warm cycle)", () => {
    const status = { phase: "building", lastCycle: { durationMs: 130000 } };
    expect(phaseLine(status, now)).toBe("building… · last cycle 2m10s");
  });
  it("omits the reload note when lastCycle.reload is an empty string, never a bare dash", () => {
    const status = { phase: "building", lastCycle: { durationMs: 130000, reload: "" } };
    const line = phaseLine(status, now);
    expect(line).toBe("building… · last cycle 2m10s");
    expect(line).not.toContain("—");
  });
});

describe("reloadNote", () => {
  it("formats a non-empty reason", () => {
    expect(reloadNote("changed Go source dep/dep.go")).toBe("full reload: changed Go source dep/dep.go");
  });
  it("is empty for an absent reason", () => {
    expect(reloadNote(undefined)).toBe("");
    expect(reloadNote(null)).toBe("");
  });
  it("is empty for an empty-string reason — never a rendered empty note", () => {
    expect(reloadNote("")).toBe("");
  });
  it("is empty for a non-string reason (defensive, malformed wire payload)", () => {
    expect(reloadNote(42)).toBe("");
    expect(reloadNote({})).toBe("");
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
  const open = defaultLogControls;
  const shut = { ...defaultLogControls, collapsed: true };

  it("never shows or polls without a successful probe", () => {
    expect(logBoxState("unknown", true, open)).toEqual({ present: false, expanded: false, polling: false });
    expect(logBoxState("unavailable", true, open)).toEqual({ present: false, expanded: false, polling: false });
  });
  it("is present, expanded and polling once probed available and visible", () => {
    expect(logBoxState("available", true, open)).toEqual({ present: true, expanded: true, polling: true });
  });
  it("stays available in every phase — the phase no longer gates the box", () => {
    // The whole point of the always-available box: an idle page shows the log
    // just as a building one does. `phase` is not an input any more.
    expect(logBoxState("available", true, open).expanded).toBe(true);
  });
  it("collapsed keeps the controls row present but stops polling", () => {
    expect(logBoxState("available", true, shut)).toEqual({ present: true, expanded: false, polling: false });
  });
  it("hidden shows nothing and polls nothing, however the controls are set", () => {
    expect(logBoxState("available", false, open)).toEqual({ present: false, expanded: false, polling: false });
    expect(logBoxState("available", false, shut)).toEqual({ present: false, expanded: false, polling: false });
  });
});

describe("applyLogControl", () => {
  it("toggles wrap without touching the other two", () => {
    expect(applyLogControl(defaultLogControls, "toggle-wrap")).toEqual({
      collapsed: false, wrap: false, maximised: false,
    });
  });
  it("toggles collapsed", () => {
    const shut = applyLogControl(defaultLogControls, "toggle-collapsed");
    expect(shut.collapsed).toBe(true);
    expect(applyLogControl(shut, "toggle-collapsed").collapsed).toBe(false);
  });
  it("maximising expands a collapsed box — maximised+collapsed is unreachable", () => {
    const shut = { ...defaultLogControls, collapsed: true };
    expect(applyLogControl(shut, "toggle-maximised")).toEqual({
      collapsed: false, wrap: true, maximised: true,
    });
  });
  it("collapsing a maximised box drops out of maximised", () => {
    const big = { ...defaultLogControls, maximised: true };
    expect(applyLogControl(big, "toggle-collapsed")).toEqual({
      collapsed: true, wrap: true, maximised: false,
    });
  });
  it("exit-maximised clears maximised and is a no-op when not maximised", () => {
    const big = { ...defaultLogControls, maximised: true };
    expect(applyLogControl(big, "exit-maximised").maximised).toBe(false);
    expect(applyLogControl(defaultLogControls, "exit-maximised")).toEqual(defaultLogControls);
  });
  it("preserves wrap across collapse and maximise toggles", () => {
    const noWrap = { ...defaultLogControls, wrap: false };
    expect(applyLogControl(noWrap, "toggle-collapsed").wrap).toBe(false);
    expect(applyLogControl(noWrap, "toggle-maximised").wrap).toBe(false);
  });
  it("returns a new object rather than mutating its input", () => {
    const before = { ...defaultLogControls };
    applyLogControl(before, "toggle-collapsed");
    expect(before).toEqual(defaultLogControls);
  });
});

describe("parseLogControls / serializeLogControls", () => {
  it("round-trips every reachable field combination", () => {
    // collapsed+maximised is excluded on purpose: applyLogControl cannot
    // produce it and parseLogControls normalizes it away, so it is not a
    // round-trippable state.
    for (const collapsed of [false, true]) {
      for (const wrap of [false, true]) {
        for (const maximised of collapsed ? [false] : [false, true]) {
          const c = { collapsed, wrap, maximised };
          expect(parseLogControls(serializeLogControls(c))).toEqual(c);
        }
      }
    }
  });
  it("defaults to an expanded, wrapping, unmaximised box", () => {
    expect(defaultLogControls).toEqual({ collapsed: false, wrap: true, maximised: false });
  });
  it("falls back to defaults when nothing is stored", () => {
    expect(parseLogControls(null)).toEqual(defaultLogControls);
    expect(parseLogControls(undefined)).toEqual(defaultLogControls);
    expect(parseLogControls("")).toEqual(defaultLogControls);
  });
  it("falls back to defaults on malformed JSON", () => {
    expect(parseLogControls("{not json")).toEqual(defaultLogControls);
  });
  it("falls back to defaults on JSON of the wrong shape", () => {
    // A stale key written by a different version must never break the panel.
    expect(parseLogControls("null")).toEqual(defaultLogControls);
    expect(parseLogControls("42")).toEqual(defaultLogControls);
    expect(parseLogControls('"nope"')).toEqual(defaultLogControls);
    expect(parseLogControls("[]")).toEqual(defaultLogControls);
  });
  it("ignores non-boolean fields field-by-field, keeping the valid ones", () => {
    expect(parseLogControls('{"collapsed":true,"wrap":"yes","maximised":null}')).toEqual({
      collapsed: true, wrap: true, maximised: false,
    });
  });
  it("ignores unknown keys", () => {
    expect(parseLogControls('{"collapsed":true,"somethingElse":9}')).toEqual({
      collapsed: true, wrap: true, maximised: false,
    });
  });
  it("never persists a maximised+collapsed pair back out", () => {
    // Belt-and-braces on the invariant applyLogControl maintains: even a
    // hand-edited key cannot resurrect the unreachable state.
    expect(parseLogControls('{"collapsed":true,"maximised":true}')).toEqual({
      collapsed: true, wrap: true, maximised: false,
    });
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

describe("normalizeLogText", () => {
  it("leaves text with no carriage returns or OSC untouched", () => {
    expect(normalizeLogText("plain\nlines\n")).toBe("plain\nlines\n");
    expect(normalizeLogText("")).toBe("");
  });

  it("collapses a \\r-overwritten line to its final segment", () => {
    expect(normalizeLogText("downloading 10%\rdownloading 99%\rdone\nnext\n")).toBe("done\nnext\n");
  });

  it("collapses each line independently", () => {
    expect(normalizeLogText("a\rb\nc\rd\n")).toBe("b\nd\n");
  });

  it("re-prepends SGR sequences from the discarded prefix", () => {
    // SGR state persists across \r in a real terminal, so the kept segment
    // must stay green.
    expect(normalizeLogText("\x1b[32m10%\r99% done")).toBe("\x1b[32m99% done");
  });

  it("re-prepends every SGR sequence from the prefix, in order", () => {
    expect(normalizeLogText("\x1b[1m\x1b[31mx\ry")).toBe("\x1b[1m\x1b[31my");
  });

  it("does not re-prepend SGR from the kept segment's own prefix twice", () => {
    expect(normalizeLogText("a\r\x1b[32mb")).toBe("\x1b[32mb");
  });

  it("keeps a trailing \\r\\n line ending intact", () => {
    // CRLF: the \r immediately precedes the newline, so the "segment after
    // the last \r" is empty and the line's content must not be dropped.
    expect(normalizeLogText("hello\r\nworld\r\n")).toBe("hello\nworld\n");
  });

  it("strips a BEL-terminated OSC string", () => {
    expect(normalizeLogText("a\x1b]0;my title\x07b")).toBe("ab");
  });

  it("strips an ST-terminated OSC string", () => {
    expect(normalizeLogText("a\x1b]0;my title\x1b\\b")).toBe("ab");
  });

  it("preserves OSC 8 hyperlinks for ansi_up to handle", () => {
    const link = "\x1b]8;;http://x\x07link\x1b]8;;\x07";
    expect(normalizeLogText(link)).toBe(link);
  });

  it("does not let an unterminated OSC string eat the rest of the log", () => {
    // A byte-sliced tail can end mid-OSC. Dropping everything after it would
    // blank the newest output, which is the part the user is watching.
    expect(normalizeLogText("keep me\x1b]0;never terminated")).toBe("keep me\x1b]0;never terminated");
  });

  it("leaves SGR sequences alone", () => {
    expect(normalizeLogText("\x1b[31mred\x1b[0m\n")).toBe("\x1b[31mred\x1b[0m\n");
  });
});
