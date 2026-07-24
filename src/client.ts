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

const TICK_MS = 1000;

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

  const host = document.createElement("gsx-devpanel");
  const root = host.attachShadow({ mode: "open" });
  host.style.display = "none";
  document.body.appendChild(host);

  const isVisible = () => host.style.display !== "none";

  const render = () => {
    const line = status ? phaseLine(status, Date.now()) : "";
    root.innerHTML = `
      <style>
        .panel { position: fixed; right: 16px; bottom: 16px; z-index: 99998;
          background: #1b1b1f; color: #e8e8ea; font: 13px/1.5 ui-monospace, monospace;
          border: 1px solid #3c3c44; border-radius: 8px; padding: 12px 16px; min-width: 260px;
          box-shadow: 0 4px 24px rgba(0,0,0,.4); }
        h1 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
        .phaseline { margin: 0 0 8px; opacity: .85; }
        dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0 0 10px; }
        dt { opacity: .6 } dd { margin: 0 }
        button { margin-right: 8px; background: #2b2b31; color: inherit; border: 1px solid #3c3c44;
          border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
        button:disabled { opacity: .4; cursor: default; }
        .muted { opacity: .6; margin: 0 0 10px }
      </style>
      <div class="panel">
        <h1>gsx dev</h1>
        ${line ? `<p class="phaseline">${escapeHtml(line)}</p>` : ""}
        ${renderStatus(status)}
        <button id="rebuild" ${buttonsDisabled(status, inflight) ? "disabled" : ""}>Rebuild</button>
        <button id="restart" ${buttonsDisabled(status, inflight) ? "disabled" : ""}>Restart server</button>
      </div>`;
    root.getElementById("rebuild")?.addEventListener("click", () => send("rebuild"));
    root.getElementById("restart")?.addEventListener("click", () => send("restart-server"));
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

  // Applies visibility, then re-derives whether the 1s phase-line tick
  // should be running from current (status, panelState) and starts/stops
  // the real setInterval to match. Called after every event that can change
  // either — the single source of truth so the tick timer never drifts from
  // the state that decided it.
  const sync = () => {
    host.style.display = panelState.visible ? "" : "none";
    if (isVisible()) render();

    const wantTick = isVisible() && status != null && status.phase !== "idle";
    if (wantTick && tickTimer === null) {
      tickTimer = setInterval(() => {
        if (isVisible()) render();
      }, TICK_MS);
    } else if (!wantTick && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
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
