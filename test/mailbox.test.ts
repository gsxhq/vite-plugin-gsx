import { describe, it, expect } from "vitest";
import { CommandMailbox } from "../src/mailbox.js";

describe("CommandMailbox", () => {
  it("delivers queued commands in order and drains", async () => {
    const m = new CommandMailbox();
    m.push("rebuild");
    m.push("restart-server");
    expect(await m.waitTake(10)).toEqual(["rebuild", "restart-server"]);
    expect(await m.waitTake(10)).toEqual([]); // drained → timeout
  });

  it("collapses consecutive duplicates", async () => {
    const m = new CommandMailbox();
    m.push("rebuild");
    m.push("rebuild");
    m.push("restart-server");
    m.push("rebuild");
    expect(await m.waitTake(10)).toEqual(["rebuild", "restart-server", "rebuild"]);
  });

  it("caps the queue at 16", async () => {
    const m = new CommandMailbox();
    for (let i = 0; i < 40; i++) m.push(`c${i}`); // distinct → no dedupe
    expect((await m.waitTake(10)).length).toBe(16);
  });

  it("resolves a pending waiter immediately on push", async () => {
    const m = new CommandMailbox();
    const p = m.waitTake(5000);
    m.push("rebuild");
    const t0 = Date.now();
    expect(await p).toEqual(["rebuild"]);
    expect(Date.now() - t0).toBeLessThan(1000); // did not wait out the timeout
  });

  it("a second waiter displaces the first (resolved empty)", async () => {
    const m = new CommandMailbox();
    const first = m.waitTake(5000);
    const second = m.waitTake(5000);
    expect(await first).toEqual([]);
    m.push("rebuild");
    expect(await second).toEqual(["rebuild"]);
  });
});
