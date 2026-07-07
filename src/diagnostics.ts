export interface GsxPos {
  line: number;
  col: number;
}
export interface GsxRange {
  start: GsxPos;
  end: GsxPos;
}
export interface GsxDiagnostic {
  file: string;
  range: GsxRange;
  severity: string;
  code?: string;
  message: string;
  help?: string;
  source?: string;
}

export interface ViteError {
  message: string;
  stack: string;
  id: string;
  frame: string;
  plugin: string;
  loc: { file: string; line: number; column: number };
}

/**
 * Map gsx `--json` diagnostics onto Vite's error-overlay payload shape.
 * Returns null when no error-severity diagnostic is present (warnings alone
 * do not raise an overlay). `readSource` is injected so this stays pure.
 */
export function toViteError(
  diags: GsxDiagnostic[],
  readSource: (file: string) => string | null,
): ViteError | null {
  const err = diags.find((d) => d.severity === "error");
  if (!err) return null;

  const head = err.code ? `${err.code}: ${err.message}` : err.message;
  const message = err.help ? `${head}\n\n${err.help}` : head;

  return {
    message,
    stack: "",
    id: err.file,
    frame: buildFrame(err, readSource),
    plugin: "vite-plugin-gsx",
    loc: {
      file: err.file,
      line: err.range.start.line,
      column: err.range.start.col,
    },
  };
}

/** Build a one-line code frame with a caret under the diagnostic's start column. */
function buildFrame(
  diag: GsxDiagnostic,
  readSource: (file: string) => string | null,
): string {
  const src = readSource(diag.file);
  if (src === null) return "";
  const lines = src.split("\n");
  const lineNo = diag.range.start.line; // 1-based
  const srcLine = lines[lineNo - 1];
  if (srcLine === undefined) return "";

  const gutter = `${lineNo} | `;
  const caretPad = " ".repeat(gutter.length) + caretIndent(srcLine, diag.range.start.col);
  return `${gutter}${srcLine}\n${caretPad}^`;
}

/**
 * Indentation for the caret row so the caret lands under a 1-based column of
 * srcLine. Mirrors the source line's leading characters, PRESERVING TABS: a tab
 * renders as several columns in the overlay <pre>, so copying the source tab
 * (rather than substituting a single space) keeps the caret aligned regardless
 * of the viewer's tab-size. This is the faithful port of gsx's own terminal
 * renderer (internal/diag/render.go `caretPad`). Columns past the line's length
 * (rare) fall back to spaces. gsx columns are byte-based; for the tab/ASCII
 * indentation that .gsx files use this matches character indices exactly.
 */
function caretIndent(srcLine: string, col: number): string {
  let pad = "";
  for (let i = 0; i < col - 1; i++) {
    pad += i < srcLine.length && srcLine[i] === "\t" ? "\t" : " ";
  }
  return pad;
}
