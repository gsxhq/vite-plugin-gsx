import { describe, it, expect } from "vitest";
import { toViteError, type GsxDiagnostic } from "../src/diagnostics.js";

function diag(over: Partial<GsxDiagnostic> = {}): GsxDiagnostic {
  return {
    file: "views/foo.gsx",
    range: { start: { line: 2, col: 7 }, end: { line: 2, col: 10 } },
    severity: "error",
    code: "syntax",
    message: "mismatched close tag",
    ...over,
  };
}

const SRC = "package views\n  <div></span>\n"; // line 2 is "  <div></span>"
const read = (_f: string) => SRC;

describe("toViteError", () => {
  it("returns null when there is no error-severity diagnostic", () => {
    expect(toViteError([diag({ severity: "warning" })], read)).toBeNull();
    expect(toViteError([], read)).toBeNull();
  });

  it("prefixes the code and fills loc + plugin", () => {
    const err = toViteError([diag()], read)!;
    expect(err.message).toContain("syntax: mismatched close tag");
    expect(err.loc).toEqual({ file: "views/foo.gsx", line: 2, column: 7 });
    expect(err.plugin).toBe("vite-plugin-gsx");
    expect(err.id).toBe("views/foo.gsx");
  });

  it("appends help after a blank line when present", () => {
    const err = toViteError([diag({ help: "did you mean </div>?" })], read)!;
    expect(err.message).toBe(
      "syntax: mismatched close tag\n\ndid you mean </div>?",
    );
  });

  it("omits the code prefix when code is absent", () => {
    const err = toViteError([diag({ code: undefined })], read)!;
    expect(err.message).toBe("mismatched close tag");
  });

  it("builds a frame with a caret under the start column", () => {
    const err = toViteError([diag()], read)!;
    // frame shows the offending source line and a caret at column 7
    expect(err.frame).toContain("<div></span>");
    expect(err.frame).toMatch(/\n\s+\^/);
  });

  it("preserves leading tabs in the caret row so it aligns under any tab-size", () => {
    // Source line indented with a TAB. gsx columns are byte-based (a tab counts
    // as one column), but a tab renders as several columns in the overlay <pre>.
    // The caret row must copy the tab (not substitute spaces) so it stays under
    // the target column regardless of the viewer's tab-size.
    const tabbed = "component X() {\n\t<div></span>\n"; // line 2 = "\t<div></span>"
    const err = toViteError(
      // col 2 = the "<" immediately after the leading tab (1-based, byte column)
      [diag({ range: { start: { line: 2, col: 2 }, end: { line: 2, col: 2 } } })],
      () => tabbed,
    )!;
    const [srcRow, caretRow] = err.frame.split("\n");
    expect(srcRow).toBe("2 | \t<div></span>");
    // Caret row mirrors the gutter WIDTH as spaces ("2 | " → 4 spaces), then the
    // copied tab, then the caret — so in a <pre> the tab expands identically on
    // both rows and the caret sits under the "<".
    expect(caretRow).toBe("    \t^");
  });

  it("yields an empty frame when the source cannot be read", () => {
    const err = toViteError([diag()], () => null)!;
    expect(err.frame).toBe("");
  });

  it("picks the first error when warnings precede it", () => {
    const err = toViteError(
      [diag({ severity: "warning", message: "w" }), diag({ message: "real" })],
      read,
    )!;
    expect(err.message).toContain("real");
  });
});
