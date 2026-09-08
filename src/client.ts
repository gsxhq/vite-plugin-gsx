// Dev panel: <gsx-devpanel> in shadow DOM, toggled by Cmd/Ctrl-<key>.
// Delivered by a wrapper module (see panelPlugin in index.ts) that imports
// this file and calls init({ key, autoShow }); talks over vite's HMR
// websocket.
import {
  isToggleKey,
  isEditable,
  renderStatus,
  buttonsDisabled,
  escapeHtml,
  autoShowDelay,
  phaseLine,
  initialPanelState,
  onStatus,
  onTimerFired,
  onToggleKey,
  type PanelState,
  type PanelActions,
  logBoxState,
  logTruncationBanner,
  normalizeLogText,
  applyLogControl,
  parseLogControls,
  serializeLogControls,
  defaultLogControls,
  LOG_CONTROLS_KEY,
  type LogProbeResult,
  type LogControls,
  type LogControlAction,
} from "./client-logic.js";
import { AnsiUp } from "ansi_up";
// Type-only: erased at build time, so dist/client.js keeps no runtime
// reference to "vite" (it must stay a dependency-free browser module).
import type { ViteHotContext } from "vite/types/hot.js";

export interface InitOptions {
  key: string;
  /** Delay (ms) before the panel auto-shows during a still-running cycle; `false` disables auto-show. Default: 3000. */
  autoShow?: number | false;
  /**
   * Injectable HMR context, defaulting to this module's own
   * `import.meta.hot`. Exists so unit tests can exercise init()'s DOM/event
   * wiring without a real Vite dev server — production callers (the panel
   * wrapper module) never pass this.
   */
  hot?: ViteHotContext;
}

// Idempotence guard: the wrapper module only ever calls init() once per page
// load, but guards against a stray double-import registering two hosts/
// listeners.
let initialized = false;

const LOG_ENDPOINT = "/__gsx/log";
const LOG_POLL_MS = 1000;
const TICK_MS = 1000;
// px-from-bottom tolerance before a scroll position counts as "scrolled up
// away from the tail" rather than merely not-pixel-perfectly-at-the-bottom.
const SCROLL_PIN_SLACK_PX = 4;

// Corner maximise/restore glyphs: arrows out of, and into, the corners.
// Stroked with currentColor so they inherit the panel's foreground, and
// inlined because dist/client.js must stay a self-contained browser module —
// no icon font, no sprite fetch.
const ICON_SVG_OPEN =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICON_MAXIMISE =
  `${ICON_SVG_OPEN}<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>` +
  '<line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const ICON_MINIMISE =
  `${ICON_SVG_OPEN}<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>` +
  '<line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

// Both storage helpers swallow everything localStorage can throw — it is
// absent in some embedding contexts and throws outright under a blocked-
// cookies policy or a full quota. The panel's toggles are a convenience;
// losing their persistence must never cost the panel itself.
function readLogControls(): LogControls {
  try {
    return parseLogControls(globalThis.localStorage?.getItem(LOG_CONTROLS_KEY));
  } catch {
    return defaultLogControls;
  }
}

function writeLogControls(controls: LogControls): void {
  try {
    globalThis.localStorage?.setItem(LOG_CONTROLS_KEY, serializeLogControls(controls));
  } catch {
    // Ignored: see readLogControls.
  }
}

export function init(opts: InitOptions): void {
  if (initialized) return;
  initialized = true;

  const hot = opts.hot ?? (import.meta as any).hot;
  if (!hot) return;

  const autoShowMs = autoShowDelay({ autoShow: opts.autoShow });

  let status: any = null;
  let inflight = false;
  let panelState: PanelState = initialPanelState;
  let autoShowTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  // Log box: one probe per page load (never retried — a 404/failed probe
  // degrades to no box, permanently, for the rest of this page's life), then
  // ~1s polling for as long as the box is visible AND expanded.
  let logProbe: LogProbeResult = "unknown";
  let logProbeStarted = false;
  let logPollTimer: ReturnType<typeof setInterval> | null = null;
  let logText = "";
  let logStart: number | null = null;
  let userScrolled = false;
  let lastScrollTop = 0;
  let logBoxWasExpanded = false;
  let logControls: LogControls = readLogControls();

  const host = document.createElement("gsx-devpanel");
  const root = host.attachShadow({ mode: "open" });
  host.style.display = "none";
  // Mounted on <html>, not <body>: the panel is client-only and never part of
  // a server response, so anything that swaps or morphs body's children
  // (htmx hx-boost, its outerSync history restore, Turbo, Alpine morph)
  // would remove it. Nothing but a full page load replaces <html>'s children.
  document.documentElement.appendChild(host);

  const isVisible = () => host.style.display !== "none";

  const render = () => {
    const box = logBoxState(logProbe, isVisible(), logControls);
    // Fresh pin-to-bottom whenever the box (re)appears — re-expanding after a
    // collapse (or the panel closing and reopening, handled in sync below) is
    // a new read, not a continuation of wherever the user had scrolled in the
    // last one.
    if (box.expanded && !logBoxWasExpanded) userScrolled = false;
    logBoxWasExpanded = box.expanded;

    const line = status ? phaseLine(status, Date.now()) : "";
    const banner = logTruncationBanner(logStart);
    // Fresh converter per render: ansi_up carries SGR state across calls, so
    // a truncated/unreset escape sequence in one poll's tail must not tint
    // the next poll's render.
    const ansi = new AnsiUp();
    ansi.use_classes = true;
    // Prototype-free allowlist. ansi_up tests OSC 8 schemes with a plain
    // `allowlist[scheme]` lookup, so with an object literal every
    // Object.prototype key is a truthy "allowed scheme" —
    // `ESC]8;;constructor:…` renders as an anchor. A null-prototype object
    // closes that without touching the intended http/https policy.
    ansi.url_allowlist = Object.assign(Object.create(null), { http: 1, https: 1 });
    const logHtml = ansi.ansi_to_html(normalizeLogText(logText));

    root.innerHTML = `
      <style>
        .panel { position: fixed; right: 16px; bottom: 16px; z-index: 99998;
          background: #1b1b1f; color: #e8e8ea; font: 13px/1.5 ui-monospace, monospace;
          border: 1px solid #3c3c44; border-radius: 8px; padding: 12px 16px; min-width: 260px;
          box-shadow: 0 4px 24px rgba(0,0,0,.4); }
        .panel.expanded { width: 480px; }
        h1 { font-size: 13px; margin: 0 0 8px; font-weight: 600; padding-right: 28px; }
        .phaseline { margin: 0 0 8px; opacity: .85; }
        dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0 0 10px; }
        dt { opacity: .6 } dd { margin: 0 }
        button { margin-right: 8px; background: #2b2b31; color: inherit; border: 1px solid #3c3c44;
          border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
        button:disabled { opacity: .4; cursor: default; }
        .muted { opacity: .6; margin: 0 0 10px }
        .logbanner { opacity: .6; margin: 4px 0; font-size: 12px; }
        #gsx-log-box { max-height: 220px; overflow-y: auto; white-space: pre-wrap;
          background: #101013; border: 1px solid #3c3c44; border-radius: 6px;
          padding: 6px 8px; margin: 0; font-size: 12px; }
        #gsx-log-box.nowrap { white-space: pre; overflow-x: auto; }
        /* Maximise/restore sits in the panel's own top-right corner, clear of
           the control row. The h1 reserves room for it via padding-right so a
           long heading can never slide underneath. */
        .iconbtn { position: absolute; top: 8px; right: 8px; margin: 0;
          padding: 3px; line-height: 0; border-radius: 4px; }
        .iconbtn[aria-pressed="true"] { background: #3c3c44; border-color: #5e5e68; }
        /* Two rows, each wrapping rather than overflowing a narrow panel: the
           commands, then the log's own controls directly above its box. */
        .cmdrow, .ctlrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
        .cmdrow { margin: 0 0 4px; }
        .ctlrow { margin: 0 0 6px; }
        .cmdrow button { margin-right: 0; }
        .ctlrow button { margin-right: 0; padding: 2px 8px; font-size: 12px; }
        .ctlrow button[aria-pressed="true"] { background: #3c3c44; border-color: #5e5e68; }
        /* Maximised: drop the corner anchoring and become a full-viewport
           column, so the log box (the flex child that grows) takes every
           pixel left under the header, phase line and buttons. */
        .panel.maximised { top: 0; left: 0; right: 0; bottom: 0; width: auto; max-width: none;
          border-radius: 0; border: 0; box-sizing: border-box;
          display: flex; flex-direction: column; }
        .panel.maximised #gsx-log-box { flex: 1 1 auto; max-height: none; }
        .ansi-black-fg { color: #6b6b74 } .ansi-red-fg { color: #e05561 }
        .ansi-green-fg { color: #8cc265 } .ansi-yellow-fg { color: #d5a336 }
        .ansi-blue-fg { color: #6a9fd8 } .ansi-magenta-fg { color: #c162de }
        .ansi-cyan-fg { color: #42b3c2 } .ansi-white-fg { color: #d7dae0 }
        .ansi-bright-black-fg { color: #8b8b94 } .ansi-bright-red-fg { color: #ff616e }
        .ansi-bright-green-fg { color: #a5e075 } .ansi-bright-yellow-fg { color: #f0c674 }
        .ansi-bright-blue-fg { color: #8ab7f0 } .ansi-bright-magenta-fg { color: #de73ff }
        .ansi-bright-cyan-fg { color: #4cd1e0 } .ansi-bright-white-fg { color: #f4f4f6 }
        .ansi-black-bg { background: #2b2b31 } .ansi-red-bg { background: #6e2a30 }
        .ansi-green-bg { background: #3d5a2c } .ansi-yellow-bg { background: #6a5320 }
        .ansi-blue-bg { background: #2f4c6e } .ansi-magenta-bg { background: #5c2f6b }
        .ansi-cyan-bg { background: #235b62 } .ansi-white-bg { background: #4a4a52 }
        .ansi-bright-black-bg { background: #3c3c44 } .ansi-bright-red-bg { background: #8c3540 }
        .ansi-bright-green-bg { background: #4e7238 } .ansi-bright-yellow-bg { background: #856828 }
        .ansi-bright-blue-bg { background: #3c608a } .ansi-bright-magenta-bg { background: #743a86 }
        .ansi-bright-cyan-bg { background: #2c737c } .ansi-bright-white-bg { background: #5e5e68 }
      </style>
      <div class="panel${box.expanded ? " expanded" : ""}${logControls.maximised ? " maximised" : ""}">
        <h1>gsx dev</h1>
        ${line ? `<p class="phaseline">${escapeHtml(line)}</p>` : ""}
        ${renderStatus(status)}
        ${
          box.present
            ? `<button id="log-max" class="iconbtn" aria-pressed="${logControls.maximised}" title="${
                logControls.maximised ? "Restore panel" : "Maximise panel"
              }" aria-label="${logControls.maximised ? "Restore panel" : "Maximise panel"}">${
                logControls.maximised ? ICON_MINIMISE : ICON_MAXIMISE
              }</button>`
            : ""
        }
        <div class="cmdrow">
          <button id="rebuild" ${buttonsDisabled(status, inflight) ? "disabled" : ""}>Rebuild</button>
          <button id="restart" ${buttonsDisabled(status, inflight) ? "disabled" : ""}>Restart server</button>
        </div>
        ${
          box.present
            ? `<div class="ctlrow">
            <button id="log-toggle" aria-expanded="${!logControls.collapsed}">${
              logControls.collapsed ? "▸" : "▾"
            } log</button>
            <button id="log-wrap" aria-pressed="${logControls.wrap}">wrap lines</button>
          </div>`
            : ""
        }
        ${
          box.expanded
            ? `${banner ? `<p class="logbanner">${escapeHtml(banner)}</p>` : ""}<pre id="gsx-log-box"${
                logControls.wrap ? "" : ' class="nowrap"'
              }>${logHtml}</pre>`
            : ""
        }
      </div>`;
    root.getElementById("rebuild")?.addEventListener("click", () => send("rebuild"));
    root.getElementById("restart")?.addEventListener("click", () => send("restart-server"));
    root.getElementById("log-toggle")?.addEventListener("click", () => changeLogControls("toggle-collapsed"));
    root.getElementById("log-wrap")?.addEventListener("click", () => changeLogControls("toggle-wrap"));
    root.getElementById("log-max")?.addEventListener("click", () => changeLogControls("toggle-maximised"));

    if (box.expanded) {
      const el = root.getElementById("gsx-log-box") as any;
      if (el) {
        el.addEventListener("scroll", () => {
          lastScrollTop = el.scrollTop;
          userScrolled = el.scrollTop + el.clientHeight < el.scrollHeight - SCROLL_PIN_SLACK_PX;
        });
        // innerHTML replacement just tore down and recreated this node, so
        // its scroll offset resets to 0 — restore the pin (or the user's
        // last position) explicitly rather than let it snap to the top.
        el.scrollTop = userScrolled ? lastScrollTop : el.scrollHeight;
      }
    }
  };

  // Every control change funnels through here: apply the invariant, persist,
  // then sync() so the poll timer follows the new expanded state. Wrap and
  // maximise both change the box's scrollHeight, and collapse/expand rebuilds
  // the node outright, so any of them makes the remembered scroll offset
  // meaningless — re-pin to the tail rather than restore a stale position.
  const changeLogControls = (action: LogControlAction) => {
    const before = logControls;
    const next = applyLogControl(before, action);
    // applyLogControl always returns a fresh object, so compare by value:
    // Esc on a non-maximised panel must not write storage or re-render.
    if (next.collapsed === before.collapsed && next.wrap === before.wrap && next.maximised === before.maximised) {
      return;
    }
    logControls = next;
    writeLogControls(logControls);
    userScrolled = false;
    // Re-expanding shows whatever the tail was when polling stopped; fetch
    // immediately so the user does not read up to a second of stale log.
    if (before.collapsed && !logControls.collapsed) void fetchLog();
    sync();
  };

  const send = (cmd: string) => {
    inflight = true;
    hot.send("gsx:cmd", { cmd });
    render();
  };

  const startAutoShowTimer = () => {
    if (autoShowMs === null) return;
    autoShowTimer = setTimeout(() => {
      autoShowTimer = null;
      panelState = onTimerFired(panelState);
      sync();
    }, autoShowMs);
  };

  const cancelAutoShowTimer = () => {
    if (autoShowTimer !== null) {
      clearTimeout(autoShowTimer);
      autoShowTimer = null;
    }
  };

  const applyActions = (actions: PanelActions) => {
    if (actions.startTimer) startAutoShowTimer();
    if (actions.cancelTimer) cancelAutoShowTimer();
  };

  const fetchLog = async () => {
    try {
      const res = await fetch(LOG_ENDPOINT);
      if (!res.ok) {
        logProbe = "unavailable";
      } else {
        logProbe = "available";
        logText = await res.text();
        const h = res.headers.get("x-gsx-log-start");
        logStart = h !== null ? Number(h) : null;
      }
    } catch {
      // Network failure (server down, CORS, etc.) degrades exactly like a
      // 404: no box, no error, no retry.
      logProbe = "unavailable";
    }
    sync();
  };

  // Applies visibility, then re-derives every timer's should-be-running
  // state from current (status, panelState, logProbe) and starts/stops the
  // real setInterval/setTimeout handles to match. Called after every event
  // that can change any of those three — the single source of truth so the
  // timers never drift from the state that decided them.
  const sync = () => {
    const wasVisible = isVisible();
    const nextVisible = panelState.visible;
    if (nextVisible && !wasVisible) {
      // Fresh pin-to-bottom on every re-open, independent of whether the log
      // box itself was already "expanded" the whole time it was hidden.
      userScrolled = false;
    }
    host.style.display = nextVisible ? "" : "none";
    if (nextVisible) render();

    const nonIdle = status != null && status.phase !== "idle";

    const wantTick = nextVisible && nonIdle;
    if (wantTick && tickTimer === null) {
      tickTimer = setInterval(() => {
        if (isVisible()) render();
      }, TICK_MS);
    } else if (!wantTick && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    // Probe /__gsx/log exactly once, deferred until the panel is first
    // visible — a page whose panel is never opened still requests nothing.
    // No phase gate any more: the box is available in every phase, so an
    // idle-at-open panel has to learn whether the endpoint exists too. This
    // one request fires even when the box is collapsed, since whether to show
    // the controls row at all depends on the answer.
    if (!logProbeStarted && nextVisible) {
      logProbeStarted = true;
      void fetchLog();
    }

    const box = logBoxState(logProbe, nextVisible, logControls);
    if (box.polling && logPollTimer === null) {
      logPollTimer = setInterval(() => void fetchLog(), LOG_POLL_MS);
    } else if (!box.polling && logPollTimer !== null) {
      clearInterval(logPollTimer);
      logPollTimer = null;
    }
  };

  hot.on("gsx:status", (s: any) => {
    status = s;
    inflight = false;
    const { state, actions } = onStatus(panelState, status?.phase, autoShowMs);
    panelState = state;
    applyActions(actions);
    sync();
  });
  // Pull the cached status directly, right after the listener above is
  // registered: vite's HMR client drops custom events that arrive before a
  // listener exists, and that registration itself races the ws connection
  // handshake during module load (the plugin's connection-time replay can
  // lose that race). A reply here is idempotent with that replay — a client
  // that gets both just re-renders the same status twice.
  hot.send("gsx:status-request", {});

  window.addEventListener("keydown", (e) => {
    // Esc leaves the full-viewport log, and only that: it is claimed solely
    // while maximised, so a page whose own Esc handling matters keeps it in
    // every other state, and Esc never closes the panel itself.
    if ((e as KeyboardEvent).key === "Escape" && logControls.maximised && !isEditable(e.target)) {
      e.preventDefault();
      changeLogControls("exit-maximised");
      return;
    }
    if (!isToggleKey(e, isEditable(e.target), opts.key)) return;
    e.preventDefault();
    const { state, actions } = onToggleKey(panelState);
    panelState = state;
    applyActions(actions);
    sync();
  });
}
