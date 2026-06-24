import { spawn } from "node:child_process";
import type { GsxDiagnostic } from "./diagnostics.js";

export interface GenerateResult {
  ok: boolean;
  diagnostics: GsxDiagnostic[];
  raw: string;
}

export interface RunGenerateOptions {
  command: string[];
  paths: string[];
  cwd: string;
}

/**
 * Run `<command> --json <paths...>` in cwd. On success (exit 0) returns
 * ok:true with no diagnostics. On a non-zero exit, parses the gsx JSON
 * diagnostics array from stdout; if that is missing/unparseable, synthesizes a
 * single error diagnostic from stderr (or stdout). A spawn failure (binary not
 * found) yields a remediation diagnostic pointing at the gsx tool setup.
 */
export function runGenerate(opts: RunGenerateOptions): Promise<GenerateResult> {
  const [bin, ...leading] = opts.command;
  if (!bin) {
    return Promise.resolve({
      ok: false,
      raw: "",
      diagnostics: [synthetic("vite-plugin-gsx: empty `command` option")],
    });
  }
  const args = [...leading, "--json", ...opts.paths];

  return new Promise<GenerateResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(bin, args, { cwd: opts.cwd });

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (e) => {
      resolve({
        ok: false,
        raw: String(e),
        diagnostics: [
          synthetic(
            `vite-plugin-gsx: could not run gsx (\`${opts.command.join(" ")}\`): ${
              (e as NodeJS.ErrnoException).code ?? e.message
            }. Is the gsx \`tool\` directive in go.mod, and is Go installed?`,
          ),
        ],
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, diagnostics: [], raw: stdout });
        return;
      }
      const parsed = parseDiagnostics(stdout);
      if (parsed) {
        resolve({ ok: false, diagnostics: parsed, raw: stdout });
        return;
      }
      const detail = (stderr || stdout || `exit ${code}`).trim();
      resolve({
        ok: false,
        raw: stdout,
        diagnostics: [synthetic(`gsx generate failed: ${detail}`)],
      });
    });
  });
}

function parseDiagnostics(stdout: string): GsxDiagnostic[] | null {
  const text = stdout.trim();
  if (!text.startsWith("[")) return null;
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return null;
    return arr as GsxDiagnostic[];
  } catch {
    return null;
  }
}

function synthetic(message: string): GsxDiagnostic {
  return {
    file: "",
    range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    severity: "error",
    message,
  };
}
