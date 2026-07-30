// Pure helpers for the dev panel client. No DOM APIs — unit-testable.

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function isToggleKey(e: KeyLike, editing: boolean, key: string): boolean {
  return !editing && !e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === key.toLowerCase();
}

export function isEditable(target: unknown): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

export function escapeHtml(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderStatus(status: any): string {
  if (!status) return `<p class="muted">waiting for status… (is gsx dev running?)</p>`;
  const server = status.server ?? {};
  const fd = status.frontDoor ?? {};
  const lc = status.lastCycle;
  const origin = server.upstream != null ? escapeHtml(server.upstream) : `:${escapeHtml(server.port ?? "?")}`;
  const rows = [
    ["phase", escapeHtml(status.phase ?? "?")],
    ["server", `${server.healthy ? "healthy" : "down"} ${origin}`],
    ["front door", `${escapeHtml(fd.state ?? "?")}${fd.restarts ? ` (${escapeHtml(fd.restarts)} restarts)` : ""}`],
  ];
  if (lc)
    rows.push([
      "last cycle",
      `${lc.ok ? "ok" : `${escapeHtml(lc.errors)} error(s)`} at ${escapeHtml(lc.at ?? "")}`,
    ]);
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

// Buttons stay disabled until the first status event arrives (daemon/standalone
// vite mode may never consume commands — degrade honestly) and while a command
// is inflight.
export function buttonsDisabled(status: unknown, inflight: boolean): boolean {
  return status == null || inflight;
}

// ---------------------------------------------------------------------------
// Auto-show: a local timer that opens the panel after `devPanel.autoShow` ms
// of a still-running (non-idle) cycle.

export const DEFAULT_AUTO_SHOW_MS = 3000;

// Re-validates the wire value defensively (mirrors resolveDevPanel's option
// validation server-side, which always sends a well-formed number|false) —
// `opt.autoShow` arrives here already validated in production, but this
// function stays total so a stale/hand-rolled `InitOptions` degrades to the
// default instead of scheduling a nonsensical timer.
export function autoShowDelay(opt: { autoShow?: number | false }): number | null {
  const v = opt?.autoShow;
  if (v === false) return null;
  if (v === undefined) return DEFAULT_AUTO_SHOW_MS;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_AUTO_SHOW_MS;
}

// ---------------------------------------------------------------------------
// Phase line: "building… started 42s ago · last cycle 2m10s" — ticked locally
// from `phaseSince` (no added polling; the wall-clock elapsed is derived from
// a timestamp already present on every status).

function humanizeDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

export function phaseLine(status: any, nowMs: number): string {
  const phase = status?.phase;
  if (typeof phase !== "string" || phase === "") return "";
  const durationMs = status.lastCycle?.durationMs;
  const hasLastCycle =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0;

  if (phase === "idle") {
    // idle isn't "running" — a ticking "idle… started 42s ago" head reads as
    // if something named idle is in progress, and the renderStatus rows
    // directly below already say "phase: idle". Show only the last-cycle
    // summary (nothing at all if there hasn't been a cycle yet).
    return hasLastCycle ? `last cycle ${humanizeDuration(durationMs)}` : "";
  }

  let head = `${phase}…`;
  const since = status.phaseSince;
  if (typeof since === "string" && since !== "") {
    const start = Date.parse(since);
    // Old gsx devs omit phaseSince entirely (undefined, handled above by
    // typeof); a malformed string is a separate degrade case — Date.parse
    // returns NaN rather than throwing, so guard explicitly rather than
    // letting a NaN elapsed leak into the rendered line.
    if (!Number.isNaN(start)) {
      head += ` started ${humanizeDuration(Math.max(0, nowMs - start))} ago`;
    }
  }
  const segments = [head];
  if (hasLastCycle) segments.push(`last cycle ${humanizeDuration(durationMs)}`);
  return segments.join(" · ");
}

// ---------------------------------------------------------------------------
// Panel open-state machine. Pure transition functions — client.ts owns the
// real setTimeout/keydown wiring and just applies the returned state +
// actions (which real timer to start/cancel).

export type OpenedBy = "user" | "auto" | null;

export interface PanelState {
  visible: boolean;
  openedBy: OpenedBy;
  /** An auto-show timer is currently scheduled (not yet fired or cancelled). */
  timerActive: boolean;
}

export const initialPanelState: PanelState = { visible: false, openedBy: null, timerActive: false };

export interface PanelActions {
  startTimer?: boolean;
  cancelTimer?: boolean;
}

// A new status arrived. `autoShowMs` is the resolved delay (`autoShowDelay()`
// output) — null means auto-show is disabled entirely (devPanel:false or
// autoShow:false), in which case status events never touch the timer (Cmd-D
// still works independently — see onToggleKey).
export function onStatus(
  state: PanelState,
  phase: string | undefined,
  autoShowMs: number | null,
): { state: PanelState; actions: PanelActions } {
  if (autoShowMs === null) return { state, actions: {} };
  const idle = phase === "idle";
  if (!idle) {
    // Already timing (a later in-cycle phase transition, e.g.
    // generating→building) or already shown: don't restart the clock or
    // re-trigger a show.
    if (state.timerActive || state.visible) return { state, actions: {} };
    return { state: { ...state, timerActive: true }, actions: { startTimer: true } };
  }
  // idle: a pending timer is cancelled before it ever opens the panel...
  if (state.timerActive) {
    return { state: { ...state, timerActive: false }, actions: { cancelTimer: true } };
  }
  // ...while a panel already auto-opened for this cycle closes again. A
  // manually-opened one (openedBy "user") stays, per spec.
  if (state.visible && state.openedBy === "auto") {
    return { state: { visible: false, openedBy: null, timerActive: false }, actions: {} };
  }
  return { state, actions: {} };
}

// The real setTimeout scheduled by a prior `startTimer` action fired.
export function onTimerFired(state: PanelState): PanelState {
  // Defensive: a timer client.ts failed to clear (or a stale closure) firing
  // after cancellation must not resurrect the panel.
  if (!state.timerActive) return state;
  return { visible: true, openedBy: "auto", timerActive: false };
}

// Cmd-D always wins: closes an open panel (whoever opened it) or opens one as
// user-owned, cancelling any pending auto-show timer so it never fires later
// and fights the user's own toggle.
export function onToggleKey(state: PanelState): { state: PanelState; actions: PanelActions } {
  if (state.visible) {
    return { state: { visible: false, openedBy: null, timerActive: false }, actions: {} };
  }
  const actions: PanelActions = state.timerActive ? { cancelTimer: true } : {};
  return { state: { visible: true, openedBy: "user", timerActive: false }, actions };
}

// ---------------------------------------------------------------------------
// Log box: a scrolling tail of /__gsx/log, available in every phase once the
// one-time probe succeeds, and driven from there by the user's own controls.

export type LogProbeResult = "unknown" | "available" | "unavailable";

/** The three user-owned toggles, persisted across reloads. */
export interface LogControls {
  collapsed: boolean;
  wrap: boolean;
  maximised: boolean;
}

export const defaultLogControls: LogControls = { collapsed: false, wrap: true, maximised: false };

/** localStorage key holding the serialized LogControls. */
export const LOG_CONTROLS_KEY = "gsx-devpanel-log";

export type LogControlAction = "toggle-collapsed" | "toggle-wrap" | "toggle-maximised" | "exit-maximised";

/**
 * The single place the controls' one invariant lives: maximised and collapsed
 * are mutually exclusive, since a full-viewport panel showing no log would be
 * a dead end the user has to click twice to escape. Whichever toggle the user
 * just pressed wins, and the other bit yields.
 */
export function applyLogControl(controls: LogControls, action: LogControlAction): LogControls {
  switch (action) {
    case "toggle-wrap":
      return { ...controls, wrap: !controls.wrap };
    case "toggle-collapsed": {
      const collapsed = !controls.collapsed;
      return { ...controls, collapsed, maximised: collapsed ? false : controls.maximised };
    }
    case "toggle-maximised": {
      const maximised = !controls.maximised;
      return { ...controls, maximised, collapsed: maximised ? false : controls.collapsed };
    }
    case "exit-maximised":
      return { ...controls, maximised: false };
  }
}

export function serializeLogControls(controls: LogControls): string {
  return JSON.stringify(controls);
}

/**
 * Reads controls back defensively: an absent, malformed, wrong-shaped, or
 * hand-edited key degrades to the defaults field by field rather than
 * breaking the panel, and the maximised/collapsed invariant is re-applied on
 * the way in so no stored pair can resurrect the unreachable state.
 */
export function parseLogControls(raw: string | null | undefined): LogControls {
  if (typeof raw !== "string" || raw === "") return defaultLogControls;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultLogControls;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return defaultLogControls;
  const bag = parsed as Record<string, unknown>;
  const bool = (key: keyof LogControls) =>
    typeof bag[key] === "boolean" ? (bag[key] as boolean) : defaultLogControls[key];
  const collapsed = bool("collapsed");
  return { collapsed, wrap: bool("wrap"), maximised: collapsed ? false : bool("maximised") };
}

export interface LogBoxState {
  /** Render the controls row — the box exists, whatever the toggles say. */
  present: boolean;
  /** Render the log tail itself, and widen the panel to fit it. */
  expanded: boolean;
  /** Actively poll /__gsx/log right now. */
  polling: boolean;
}

export function logBoxState(
  probeResult: LogProbeResult,
  visible: boolean,
  controls: LogControls,
): LogBoxState {
  const present = probeResult === "available" && visible;
  const expanded = present && !controls.collapsed;
  // Polling follows the tail the user can actually see: collapsing is a real
  // off switch, and no phase can turn the fetch loop back on behind their
  // back.
  return { present, expanded, polling: expanded };
}

// Non-null only when the server reported truncation via x-gsx-log-start > 0.
export function logTruncationBanner(startOffset: number | null | undefined): string | null {
  return typeof startOffset === "number" && Number.isFinite(startOffset) && startOffset > 0
    ? "earlier output truncated"
    : null;
}

// ---------------------------------------------------------------------------
// Log pre-pass. Two things ansi_up (verified against 6.0.6) does not do:
// carriage-return overwrite, and OSC strings — which leak through as literal
// text (`ESC]0;title BEL` renders as `]0;title`). Runs before ansi_to_html,
// on raw log text.

// OSC introducer through its terminator (BEL or ST), excluding OSC 8 —
// ansi_up turns those into real anchors (http/https only, URL escaped), so
// they are its business, not ours. Requiring the terminator means an
// unterminated OSC at a truncated tail's end is left as-is rather than
// swallowing the newest output.
const OSC_RE = /\x1b\](?!8;)[\s\S]*?(?:\x07|\x1b\\)/g;
const SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Strips OSC strings and applies carriage-return overwrite, so a `\r`-driven
 * progress line collapses to its final state instead of stacking. SGR state
 * persists across a `\r` in a real terminal, so sequences from the discarded
 * prefix are re-prepended to the kept segment.
 */
export function normalizeLogText(text: string): string {
  const stripped = text.replace(OSC_RE, "");
  if (!stripped.includes("\r")) return stripped;
  return stripped
    .split("\n")
    .map((line) => {
      // A CRLF log ends every line with a \r that is NOT an overwrite — it is
      // half the line ending, left over from splitting on \n. Ignore that one
      // (and drop it, so a bare CR never reaches the DOM); an overwriting \r
      // is one with content after it.
      const crlf = line.endsWith("\r");
      const body = crlf ? line.slice(0, -1) : line;
      const cut = body.lastIndexOf("\r");
      if (cut === -1) return body;
      const carried = (body.slice(0, cut).match(SGR_RE) ?? []).join("");
      return carried + body.slice(cut + 1);
    })
    .join("\n");
}
