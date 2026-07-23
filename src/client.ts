// Dev panel: <gsx-devpanel> in shadow DOM, toggled by Cmd-D/Ctrl-D.
// Served by the plugin at /__gsx/panel.js; talks over vite's HMR websocket.
import { isToggleKey, isEditable, renderStatus } from "./client-logic.js";

const hot = (import.meta as any).hot;
if (hot) {
  let status: any = null;
  let inflight = false;

  const host = document.createElement("gsx-devpanel");
  const root = host.attachShadow({ mode: "open" });
  host.style.display = "none";
  document.body.appendChild(host);

  const render = () => {
    root.innerHTML = `
      <style>
        .panel { position: fixed; right: 16px; bottom: 16px; z-index: 99998;
          background: #1b1b1f; color: #e8e8ea; font: 13px/1.5 ui-monospace, monospace;
          border: 1px solid #3c3c44; border-radius: 8px; padding: 12px 16px; min-width: 260px;
          box-shadow: 0 4px 24px rgba(0,0,0,.4); }
        h1 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
        dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0 0 10px; }
        dt { opacity: .6 } dd { margin: 0 }
        button { margin-right: 8px; background: #2b2b31; color: inherit; border: 1px solid #3c3c44;
          border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
        button:disabled { opacity: .4; cursor: default; }
        .muted { opacity: .6; margin: 0 0 10px }
      </style>
      <div class="panel">
        <h1>gsx dev</h1>
        ${renderStatus(status)}
        <button id="rebuild" ${inflight ? "disabled" : ""}>Rebuild</button>
        <button id="restart" ${inflight ? "disabled" : ""}>Restart server</button>
      </div>`;
    root.getElementById("rebuild")?.addEventListener("click", () => send("rebuild"));
    root.getElementById("restart")?.addEventListener("click", () => send("restart-server"));
  };

  const send = (cmd: string) => {
    inflight = true;
    hot.send("gsx:cmd", { cmd });
    render();
  };

  hot.on("gsx:status", (s: any) => {
    status = s;
    inflight = false;
    if (host.style.display !== "none") render();
  });

  window.addEventListener("keydown", (e) => {
    if (!isToggleKey(e, isEditable(e.target))) return;
    e.preventDefault();
    const show = host.style.display === "none";
    host.style.display = show ? "" : "none";
    if (show) render();
  });
}
