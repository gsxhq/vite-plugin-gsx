import { describe, it, expect } from "vitest";
import { fsImportSpecifier } from "../src/index.js";

describe("fsImportSpecifier", () => {
  it("POSIX absolute path", () => {
    expect(fsImportSpecifier("/Users/dev/dist/client.js")).toBe(
      "/@fs/Users/dev/dist/client.js",
    );
  });

  it("win32 absolute path (backslashes, drive letter) normalizes to a slash-joined /@fs specifier", () => {
    expect(fsImportSpecifier("C:\\Users\\dev\\dist\\client.js")).toBe(
      "/@fs/C:/Users/dev/dist/client.js",
    );
  });
});
