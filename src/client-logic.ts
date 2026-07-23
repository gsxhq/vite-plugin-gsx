// Pure helpers for the dev panel client. No DOM APIs — unit-testable.

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function isToggleKey(e: KeyLike, editing: boolean): boolean {
  return !editing && !e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d";
}

export function isEditable(target: unknown): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderStatus(status: any): string {
  if (!status) return `<p class="muted">waiting for status… (is gsx dev running?)</p>`;
  const server = status.server ?? {};
  const fd = status.frontDoor ?? {};
  const lc = status.lastCycle;
  const rows = [
    ["phase", esc(status.phase ?? "?")],
    ["server", `${server.healthy ? "healthy" : "down"} :${esc(server.port ?? "?")}`],
    ["front door", `${esc(fd.state ?? "?")}${fd.restarts ? ` (${esc(fd.restarts)} restarts)` : ""}`],
  ];
  if (lc) rows.push(["last cycle", `${lc.ok ? "ok" : `${esc(lc.errors)} error(s)`} at ${esc(lc.at ?? "")}`]);
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

// Buttons stay disabled until the first status event arrives (daemon/standalone
// vite mode may never consume commands — degrade honestly) and while a command
// is inflight.
export function buttonsDisabled(status: unknown, inflight: boolean): boolean {
  return status == null || inflight;
}
