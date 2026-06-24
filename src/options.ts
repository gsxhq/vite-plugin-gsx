export interface GsxOptions {
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
}

export interface ResolvedOptions {
  command: string[];
  paths: string[];
  watch: string[];
  cwd: string;
  reloadEndpoint: string;
  debounce: number;
  generateOnStart: boolean;
}

const DEFAULT_GSX_GLOB = "**/*.gsx";

export function resolveOptions(user: GsxOptions, root: string): ResolvedOptions {
  const watch =
    user.watch === undefined
      ? [DEFAULT_GSX_GLOB]
      : Array.isArray(user.watch)
        ? user.watch
        : [user.watch];
  return {
    command: user.command ?? ["go", "tool", "gsx", "generate"],
    paths: user.paths ?? ["."],
    watch,
    cwd: user.cwd ?? root,
    reloadEndpoint: user.reloadEndpoint ?? "/__reload",
    debounce: user.debounce ?? 50,
    generateOnStart: user.generateOnStart ?? true,
  };
}
