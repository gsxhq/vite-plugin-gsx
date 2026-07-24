import { resolve } from "node:path";

export interface GsxOptions {
  /** Spawn gsx generate --watch instead of receiving events from gsx dev. Default: false. */
  daemon?: boolean;
  /** Command + leading args to invoke gsx. Default: ["go","tool","gsx","generate"]. */
  command?: string[];
  /** Path args passed to generate. Default: ["."]. */
  paths?: string[];
  /** Globs whose changes trigger regeneration. Default: all .gsx files. */
  watch?: string | string[];
  /** Working directory for the command. Default: Vite config root. */
  cwd?: string;
  /** Endpoint the Go server POSTs to trigger reload. Default: "/__reload". */
  reloadEndpoint?: string;
  /** Debounce window for rapid saves, ms. Default: 50. */
  debounce?: number;
  /** Run an initial generate when the dev server starts. Default: true. */
  generateOnStart?: boolean;
  /**
   * Dev panel (Cmd/Ctrl-D status overlay). `false` disables it entirely;
   * `{ key }` keeps it enabled but rebinds the toggle to Cmd/Ctrl-<key>.
   * `{ autoShow }` sets the delay (ms) before the panel auto-shows itself
   * during a still-running build cycle; `false` disables auto-show (Cmd-D
   * still works). Default: enabled, key "d", autoShow 3000.
   */
  devPanel?: boolean | { key?: string; autoShow?: number | false };
  /**
   * Backend log file served read-only at /__gsx/log (for the dev panel).
   * Default: `process.env.GSX_DEV_LOG` — the absolute path `gsx dev`
   * injects when gsx.toml's `[dev].log` is set. A string overrides the
   * path (resolved against the Vite root); `false` disables the endpoint.
   */
  devLog?: string | false;
}

export interface ResolvedOptions {
  daemon: boolean;
  command: string[];
  paths: string[];
  watch: string[];
  cwd: string;
  reloadEndpoint: string;
  debounce: number;
  generateOnStart: boolean;
  devPanel: DevPanelSetting;
  /** Absolute backend-log path to serve at /__gsx/log; null = endpoint off. */
  devLogPath: string | null;
}

export interface DevPanelSetting {
  enabled: boolean;
  key: string;
  /** Delay (ms) before the panel auto-shows during a still-running cycle; `false` disables auto-show. */
  autoShow: number | false;
}

const DEFAULT_GSX_GLOB = "**/*.gsx";
const DEFAULT_DEVPANEL_KEY = "d";
const VALID_DEVPANEL_KEY = /^[a-z0-9]$/;
const DEFAULT_AUTO_SHOW_MS = 3000;

// Same validate-or-default-silently rationale as the key: no logger reaches
// this pure resolver, and a bad literal is a coding mistake caught by
// review/tests, not a runtime condition users hit.
function resolveAutoShow(user: number | false | undefined): number | false {
  if (user === false) return false;
  if (user === undefined) return DEFAULT_AUTO_SHOW_MS;
  return Number.isFinite(user) && user >= 0 ? user : DEFAULT_AUTO_SHOW_MS;
}

// Resolves the devPanel setting on its own (rather than folding it only into
// resolveOptions) because panelPlugin needs it at gsx()-factory time, before
// a Vite `root` (and thus resolveOptions' other inputs) is known — see the
// gsx() factory in index.ts.
export function resolveDevPanel(user: GsxOptions["devPanel"]): DevPanelSetting {
  // A disabled panel has nothing to auto-show either — pin autoShow to
  // `false` rather than the numeric default so a disabled setting reads
  // unambiguously as "off" end to end.
  if (user === false) return { enabled: false, key: DEFAULT_DEVPANEL_KEY, autoShow: false };
  const requested = user === true || user === undefined ? undefined : user.key;
  const lowered = requested?.toLowerCase();
  // An invalid key (anything but a single a-z/0-9 character) falls back to
  // the default silently: this function has no logger to warn through (only
  // the gsx() factory/configureServer do, and threading one down here just
  // for this would be a disproportionate restructure). A bad literal is a
  // coding mistake caught by review/tests, not a runtime condition users hit.
  const key = lowered !== undefined && VALID_DEVPANEL_KEY.test(lowered) ? lowered : DEFAULT_DEVPANEL_KEY;
  const requestedAutoShow = user === true || user === undefined ? undefined : user.autoShow;
  const autoShow = resolveAutoShow(requestedAutoShow);
  return { enabled: true, key, autoShow };
}

export function resolveOptions(user: GsxOptions, root: string): ResolvedOptions {
  const watch =
    user.watch === undefined
      ? [DEFAULT_GSX_GLOB]
      : Array.isArray(user.watch)
        ? user.watch
        : [user.watch];
  return {
    daemon: user.daemon ?? false,
    command: user.command ?? ["go", "tool", "gsx", "generate"],
    paths: user.paths ?? ["."],
    watch,
    cwd: user.cwd ?? root,
    reloadEndpoint: user.reloadEndpoint ?? "/__reload",
    debounce: user.debounce ?? 50,
    generateOnStart: user.generateOnStart ?? true,
    devPanel: resolveDevPanel(user.devPanel),
    devLogPath: resolveDevLogPath(user.devLog, root),
  };
}

// Env read here, at resolve time (configureServer), not module load — same
// late-read rule as devFallback's GSX_DEV_UPSTREAM. Both the option and the
// env var are resolved against `root` the same way: `resolve()` leaves an
// already-absolute path untouched (the gsx contract always injects an
// absolute GSX_DEV_LOG), so this only changes behavior for a hand-set
// relative env override, which previously opened against Node's cwd instead
// of the project root — an asymmetry with the option path that had no
// justification. `""` (option or env) means "no path", same as `false`,
// rather than resolving to the root directory itself (which is a real path
// that exists — `fsp.open` on it fails with EISDIR, a 500, not the intended
// "endpoint absent").
function resolveDevLogPath(devLog: GsxOptions["devLog"], root: string): string | null {
  if (devLog === false || devLog === "") return null;
  if (devLog !== undefined) return resolve(root, devLog);
  const fromEnv = process.env.GSX_DEV_LOG;
  return fromEnv ? resolve(root, fromEnv) : null;
}
