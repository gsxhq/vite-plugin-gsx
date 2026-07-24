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
  const durationMs = status.lastCycle?.durationMs;
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    segments.push(`last cycle ${humanizeDuration(durationMs)}`);
  }
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
