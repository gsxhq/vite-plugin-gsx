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
  type LogProbeResult,
} from "./client-logic.js";
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
  // degrades to no box, permanently, for the rest of this page's life),
  // then ~1s polling strictly gated on visible+building/starting.
  let logProbe: LogProbeResult = "unknown";
  let logProbeStarted = false;
  let logPollTimer: ReturnType<typeof setInterval> | null = null;
  let logText = "";
  let logStart: number | null = null;
  let userScrolled = false;
  let lastScrollTop = 0;
  let logBoxWasExpanded = false;

  const host = document.createElement("gsx-devpanel");
  const root = host.attachShadow({ mode: "open" });
  host.style.display = "none";
  document.body.appendChild(host);

  const isVisible = () => host.style.display !== "none";

  const render = () => {
    const box = logBoxState(logProbe, status?.phase, isVisible());
    // Fresh pin-to-bottom whenever the box (re)appears — a build starting up
    // again after a prior one finished (or the panel closing and reopening,
    // handled in applyVisibility below) is a new read, not a continuation of
    // wherever the user had scrolled in the last one.
    if (box.expanded && !logBoxWasExpanded) userScrolled = false;
    logBoxWasExpanded = box.expanded;

    const line = status ? phaseLine(status, Date.now()) : "";
    const banner = logTruncationBanner(logStart);

    root.innerHTML = `
      <style>
        .panel { position: fixed; right: 16px; bottom: 16px; z-index: 99998;
          background: #1b1b1f; color: #e8e8ea; font: 13px/1.5 ui-monospace, monospace;
          border: 1px solid #3c3c44; border-radius: 8px; padding: 12px 16px; min-width: 260px;
          box-shadow: 0 4px 24px rgba(0,0,0,.4); }
        .panel.expanded { width: 480px; }
        h1 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
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
          padding: 6px 8px; margin: 0 0 10px; font-size: 12px; }
      </style>
      <div class="panel${box.expanded ? " expanded" : ""}">
        <h1>gsx dev</h1>
        ${line ? `<p class="phaseline">${escapeHtml(line)}</p>` : ""}
        ${renderStatus(status)}
        ${
          box.expanded
            ? `${banner ? `<p class="logbanner">${escapeHtml(banner)}</p>` : ""}<pre id="gsx-log-box">${escapeHtml(logText)}</pre>`
            : ""
        }
        <button id="rebuild" ${buttonsDisabled(status, inflight) ? "disabled" : ""}>Rebuild</button>
        <button id="restart" ${buttonsDisabled(status, inflight) ? "disabled" : ""}>Restart server</button>
      </div>`;
    root.getElementById("rebuild")?.addEventListener("click", () => send("rebuild"));
    root.getElementById("restart")?.addEventListener("click", () => send("restart-server"));

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

    // Probe /__gsx/log exactly once, deferred until the first visible+
    // non-idle moment — a page that stays idle or hidden never requests it.
    if (!logProbeStarted && nextVisible && nonIdle) {
      logProbeStarted = true;
      void fetchLog();
    }

    const box = logBoxState(logProbe, status?.phase, nextVisible);
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

  window.addEventListener("keydown", (e) => {
    if (!isToggleKey(e, isEditable(e.target), opts.key)) return;
    e.preventDefault();
    const { state, actions } = onToggleKey(panelState);
    panelState = state;
    applyActions(actions);
    sync();
  });
}
