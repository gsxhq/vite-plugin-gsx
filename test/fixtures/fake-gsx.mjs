#!/usr/bin/env node
// Test double for `gsx generate`. Behaviour controlled by argv flags that the
// test prepends to `command` (they arrive before runGenerate's "--json" + paths):
//   --mode=ok    (default) : append a run-marker line, exit 0
//   --mode=fail            : print a gsx --json diagnostics array, exit 1
//   --mode=badjson         : print non-JSON to stdout, exit 1
//   --mode=crash           : print "gsx: boom" to stderr, exit 2 (no stdout)
// Always appends one line to ./gsx-ran.log in cwd so tests can count invocations.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = (argv.find((a) => a.startsWith("--mode=")) ?? "--mode=ok").slice(7);

appendFileSync(join(process.cwd(), "gsx-ran.log"), mode + "\n");

if (mode === "fail") {
  const diags = [
    {
      file: "views/foo.gsx",
      range: { start: { line: 2, col: 7 }, end: { line: 2, col: 10 } },
      severity: "error",
      code: "syntax",
      message: "mismatched close tag",
      help: "did you mean </div>?",
    },
  ];
  process.stdout.write(JSON.stringify(diags));
  process.exit(1);
} else if (mode === "badjson") {
  process.stdout.write("not json at all");
  process.exit(1);
} else if (mode === "crash") {
  process.stderr.write("gsx: boom\n");
  process.exit(2);
}
process.exit(0);
