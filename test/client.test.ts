import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// client.ts's DOM surface is small (createElement/attachShadow/appendChild,
// window.addEventListener, plus scrollable log-box elements) — minimal fakes
// stand in for jsdom, which this package doesn't otherwise depend on.
//
// FakeShadowRoot's innerHTML setter mimics a real DOM's node teardown/rebuild
// on assignment: every `id="..."` in the new markup gets a *fresh*
// FakeElement, discarding whatever scroll state the old one had. This is
// exactly the property client.ts's scroll-pin logic has to work around
// (`lastScrollTop`/`userScrolled`), so the fake needs to reproduce it rather
// than paper over it.
class FakeElement {
  scrollTop = 0;
  scrollHeight = 500;
  clientHeight = 100;
  private listeners: Record<string, Array<(e: any) => void>> = {};
  addEventListener(type: string, cb: (e: any) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  dispatch(type: string, ev: any = {}) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

class FakeShadowRoot {
  html = "";
  private elements: Record<string, FakeElement> = {};
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    const ids = [...value.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
    const next: Record<string, FakeElement> = {};
    for (const id of ids) next[id] = new FakeElement();
    this.elements = next;
  }
  getElementById(id: string): FakeElement | null {
    return this.elements[id] ?? null;
  }
}

class FakeHost {
  style: Record<string, string> = {};
  shadow = new FakeShadowRoot();
  attachShadow() {
    return this.shadow;
  }
}

function installFakeDom() {
  const bodyChildren: FakeHost[] = [];
  const keydownListeners: Array<(e: unknown) => void> = [];
  const fakeDocument = {
    createElement: () => new FakeHost(),
    body: {
      appendChild: (el: FakeHost) => {
        bodyChildren.push(el);
      },
    },
  };
  const fakeWindow = {
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      if (type === "keydown") keydownListeners.push(cb);
    },
  };
  (globalThis as any).document = fakeDocument;
  (globalThis as any).window = fakeWindow;
  return { bodyChildren, keydownListeners };
}

function press(keydownListeners: Array<(e: any) => void>, key = "d") {
  for (const cb of keydownListeners) {
    cb({ key, metaKey: true, ctrlKey: false, altKey: false, target: null, preventDefault: () => {} });
  }
}

// A bare keypress with no modifiers — Esc, unlike the Cmd/Ctrl panel toggle.
function pressPlain(keydownListeners: Array<(e: any) => void>, key: string, target: unknown = null) {
  for (const cb of keydownListeners) {
    cb({ key, metaKey: false, ctrlKey: false, altKey: false, target, preventDefault: () => {} });
  }
}

// In-memory localStorage stand-in: the panel persists its log-box controls
// there, and the node test environment has no real one.
function installFakeStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as any).localStorage = fake;
  return { store };
}

// Records call order (both .on registrations and .send calls) so the
// status-request-after-listener-registration ordering can be pinned exactly,
// not just "both happened".
function makeHot() {
  const handlers: Record<string, (data: any) => void> = {};
  const calls: Array<{ type: "on" | "send"; event: string }> = [];
  const send = vi.fn((event: string, _data?: any) => {
    calls.push({ type: "send", event });
  });
  const on = vi.fn((event: string, cb: (data: any) => void) => {
    handlers[event] = cb;
    calls.push({ type: "on", event });
  });
  return { handlers, calls, send, on };
}

function fakeLogResponse(ok: boolean, body = "", startHeader: string | null = "0") {
  return {
    ok,
    text: async () => body,
    headers: { get: (h: string) => (h === "x-gsx-log-start" ? startHeader : null) },
  };
}

async function loadClient() {
  vi.resetModules();
  return import("../src/client.js");
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("init", () => {
  it("is idempotent: a second call does not double-register the host element or the keydown listener", async () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = { send: vi.fn(), on: vi.fn() };

    init({ key: "d", hot } as any);
    init({ key: "d", hot } as any);

    expect(bodyChildren.length).toBe(1);
    expect(keydownListeners.length).toBe(1);
    expect(hot.on).toHaveBeenCalledTimes(1);
  });
});

describe("gsx:status-request pull (race-free init)", () => {
  it("registers the gsx:status listener before pulling the cached status", async () => {
    installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();

    init({ key: "d", hot } as any);

    const onIndex = hot.calls.findIndex((c) => c.type === "on" && c.event === "gsx:status");
    const sendIndex = hot.calls.findIndex((c) => c.type === "send" && c.event === "gsx:status-request");
    expect(onIndex).toBeGreaterThanOrEqual(0);
    expect(sendIndex).toBeGreaterThan(onIndex);
    expect(hot.send).toHaveBeenCalledWith("gsx:status-request", {});
  });
});

describe("auto-show timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
  });

  it("auto-shows after the configured delay if the cycle is still non-idle", async () => {
    const { bodyChildren } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: 3000, hot } as any);
    const host = bodyChildren[0]!;

    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    expect(host.style.display).toBe("none");

    await vi.advanceTimersByTimeAsync(2999);
    expect(host.style.display).toBe("none");

    await vi.advanceTimersByTimeAsync(1);
    expect(host.style.display).toBe("");
    expect(host.shadow.innerHTML).toContain("building");
  });

  it("idle before expiry cancels the timer — the panel never appears", async () => {
    const { bodyChildren } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: 3000, hot } as any);
    const host = bodyChildren[0]!;

    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(1500);
    hot.handlers["gsx:status"]!({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(host.style.display).toBe("none");
  });

  it("autoShow: false disables the timer entirely, but Cmd-D still opens the panel", async () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: false, hot } as any);
    const host = bodyChildren[0]!;

    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(host.style.display).toBe("none");

    press(keydownListeners);
    expect(host.style.display).toBe("");
  });

  it("an auto-shown panel hides itself on idle; a manually-opened one stays", async () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: 3000, hot } as any);
    const host = bodyChildren[0]!;

    // Auto-opened.
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(host.style.display).toBe("");
    hot.handlers["gsx:status"]!({ phase: "idle" });
    expect(host.style.display).toBe("none");

    // Manually opened (Cmd-D), then a full non-idle→idle cycle: stays open.
    press(keydownListeners);
    expect(host.style.display).toBe("");
    hot.handlers["gsx:status"]!({ phase: "generating", phaseSince: "2026-07-24T12:00:05Z" });
    hot.handlers["gsx:status"]!({ phase: "idle" });
    expect(host.style.display).toBe("");
  });

  it("Cmd-D always wins: closing a pending-timer panel early cancels the auto-show", async () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: 3000, hot } as any);
    const host = bodyChildren[0]!;

    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(1000);
    press(keydownListeners); // opens early, user-owned, cancels the pending timer
    expect(host.style.display).toBe("");

    // If the (cancelled) timer had fired regardless it wouldn't newly matter
    // (already visible), but this proves it doesn't double-fire/crash and
    // idle afterwards doesn't hide a user-opened panel.
    await vi.advanceTimersByTimeAsync(5000);
    hot.handlers["gsx:status"]!({ phase: "idle" });
    expect(host.style.display).toBe("");
  });
});

describe("phase-line ticking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
  });

  it("re-renders the phase line every second while visible and non-idle", async () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: false, hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners); // open manually so ticking can be observed immediately
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    expect(host.shadow.innerHTML).toContain("started 0s ago");

    await vi.advanceTimersByTimeAsync(1000);
    expect(host.shadow.innerHTML).toContain("started 1s ago");

    await vi.advanceTimersByTimeAsync(1000);
    expect(host.shadow.innerHTML).toContain("started 2s ago");
  });

  it("stops ticking (no re-render) once the panel is hidden", async () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: false, hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    press(keydownListeners); // hide again
    expect(host.style.display).toBe("none");

    const htmlBeforeTick = host.shadow.innerHTML;
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.shadow.innerHTML).toBe(htmlBeforeTick);
  });

  it("stops ticking once the phase goes idle", async () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: false, hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    hot.handlers["gsx:status"]!({ phase: "idle" });
    const htmlAfterIdle = host.shadow.innerHTML;

    await vi.advanceTimersByTimeAsync(5000);
    expect(host.shadow.innerHTML).toBe(htmlAfterIdle);
  });
});

describe("log box", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
  });

  it("STRICT: an idle, hidden page makes zero /__gsx/log requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);

    hot.handlers["gsx:status"]!({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(10000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes zero requests while hidden even mid-build", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: false, hot } as any);

    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(10000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the log while visible and idle — the phase no longer gates it", async () => {
    // Was "makes zero requests while visible but idle": the box used to exist
    // only during building/starting. It is now available in every phase, so a
    // visible+idle panel probes, renders the box, and polls.
    const fetchMock = vi.fn(async () => fakeLogResponse(true, "idle log\n", "0"));
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledWith("/__gsx/log");
    expect(host.shadow.innerHTML).toContain('id="gsx-log-box"');
    expect(host.shadow.innerHTML).toContain("idle log");

    const callsSoFar = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsSoFar);
  });

  it("makes zero requests while hidden and idle", async () => {
    // The hidden-page guarantee survives the phase gate's removal: nothing is
    // requested until the panel is actually opened.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", autoShow: false, hot } as any);

    hot.handlers["gsx:status"]!({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(10000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes once on the first visible+non-idle moment, expands, and polls ~1s", async () => {
    const fetchMock = vi.fn(async () => fakeLogResponse(true, "hello world\n", "0"));
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/__gsx/log");
    expect(host.shadow.innerHTML).toContain("hello world");
    expect(host.shadow.innerHTML).toContain('class="panel expanded"');
    expect(host.shadow.innerHTML).toContain('id="gsx-log-box"');

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a 404 probe never shows a box and is never retried", async () => {
    const fetchMock = vi.fn(async () => fakeLogResponse(false));
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.shadow.innerHTML).not.toContain('id="gsx-log-box"');

    await vi.advanceTimersByTimeAsync(10000);
    // No retries, ever — still exactly the one probe attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a network failure on probe degrades the same as a 404 — no box, no throw", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.shadow.innerHTML).not.toContain('id="gsx-log-box"');
  });

  it("shows a truncation banner when x-gsx-log-start > 0, not when it's 0", async () => {
    const fetchMock = vi.fn(async () => fakeLogResponse(true, "tail only", "128"));
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);

    expect(host.shadow.innerHTML).toContain("earlier output truncated");
  });

  it("keeps the box and keeps polling when the phase leaves building/starting", async () => {
    // Inverts the old "box is removed and polling stops once the phase leaves
    // building/starting" pin. A build finishing is exactly when you want to
    // read what it said, so the box now survives the transition to idle.
    const fetchMock = vi.fn(async () => fakeLogResponse(true, "log body", "0"));
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.shadow.innerHTML).toContain('id="gsx-log-box"');

    hot.handlers["gsx:status"]!({ phase: "idle" });
    expect(host.shadow.innerHTML).toContain('id="gsx-log-box"');

    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("pins the log box to the bottom by default", async () => {
    const fetchMock = vi.fn(async () => fakeLogResponse(true, "content", "0"));
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);

    const el = host.shadow.getElementById("gsx-log-box")!;
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it("stays at the user's scroll position across polls once they scroll up, and resets on reopen", async () => {
    const fetchMock = vi.fn(async () => fakeLogResponse(true, "content", "0"));
    vi.stubGlobal("fetch", fetchMock);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;

    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);

    // User scrolls away from the bottom.
    const el1 = host.shadow.getElementById("gsx-log-box")!;
    el1.scrollTop = 10;
    el1.dispatch("scroll");

    // Next poll re-renders (a fresh element, per the fake's innerHTML
    // semantics) — it must NOT snap back to the bottom.
    await vi.advanceTimersByTimeAsync(1000);
    const el2 = host.shadow.getElementById("gsx-log-box")!;
    expect(el2.scrollTop).toBe(10);
    expect(el2.scrollTop).not.toBe(el2.scrollHeight);

    // Close and reopen the panel: fresh read, pinned to bottom again.
    press(keydownListeners);
    expect(host.style.display).toBe("none");
    press(keydownListeners);
    const el3 = host.shadow.getElementById("gsx-log-box")!;
    expect(el3.scrollTop).toBe(el3.scrollHeight);
  });
});

describe("log box ANSI rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
  });

  // Serve `body` from /__gsx/log, open the panel mid-build so the log box
  // expands, and return the rendered shadow-root HTML. Fresh module + fake
  // DOM per call, so no state leaks between cases.
  async function renderWithLog(body: string): Promise<string> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeLogResponse(true, body, "0")),
    );
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;
    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);
    return host.shadow.innerHTML;
  }

  // Each case: log text served by /__gsx/log -> assertion on the rendered
  // shadow-root HTML.
  it("renders SGR colors as ansi-* classes", async () => {
    const html = await renderWithLog("\x1b[31mred\x1b[0m");
    expect(html).toContain('<span class="ansi-red-fg">red</span>');
  });

  it("renders bright colors and bold", async () => {
    const html = await renderWithLog("\x1b[1;92mboldbright\x1b[0m");
    expect(html).toContain('class="ansi-bright-green-fg"');
    expect(html).toContain("font-weight:bold");
  });

  it("renders 256-color and truecolor as inline rgb", async () => {
    const html = await renderWithLog("\x1b[38;5;208m256\x1b[0m \x1b[38;2;10;20;30mtrue\x1b[0m");
    expect(html).toContain("color:rgb(255,135,0)");
    expect(html).toContain("color:rgb(10,20,30)");
  });

  it("escapes HTML in log content", async () => {
    const html = await renderWithLog('<script>alert(1)</script> & "q"');
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("does not turn a javascript: OSC 8 hyperlink into an anchor", async () => {
    const html = await renderWithLog("\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x07");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("<a href");
  });

  it("collapses \\r progress lines", async () => {
    const html = await renderWithLog("10%\r50%\r100%\n");
    expect(html).toContain("100%");
    expect(html).not.toContain("10%\r");
  });

  it("strips OSC title sequences", async () => {
    const html = await renderWithLog("a\x1b]0;my title\x07b");
    expect(html).not.toContain("my title");
    expect(html).toContain("ab");
  });

  it("does not carry color state from one poll into the next", async () => {
    // A tail that starts mid-escape or never resets must not tint the NEXT
    // poll of the SAME panel instance. A fresh AnsiUp per render is what
    // guarantees this — so this case must drive two polls through one client,
    // not two renderWithLog calls (those reset the module and would pass
    // even with a shared converter).
    let body = "\x1b[31mno reset here";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeLogResponse(true, body, "0")),
    );
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;
    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.shadow.innerHTML).toContain('class="ansi-red-fg"');

    body = "plain";
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.shadow.innerHTML).toContain("plain");
    expect(host.shadow.innerHTML).not.toContain('class="ansi-red-fg"');
  });

  it("ships styles for every ansi-* class it can emit", async () => {
    const html = await renderWithLog("");
    // One rule per class ansi_up can emit with use_classes, so no color
    // renders as unstyled inherit-colored text.
    for (const color of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
      for (const variant of [color, `bright-${color}`]) {
        expect(html).toContain(`.ansi-${variant}-fg`);
        expect(html).toContain(`.ansi-${variant}-bg`);
      }
    }
  });
});

describe("log box controls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
  });

  // Opens the panel with the log endpoint available and returns everything a
  // control test needs: the host to read markup from, the shadow root to
  // click buttons in, the keydown listeners, the fetch spy, and the storage.
  async function openPanel(seed: Record<string, string> = {}) {
    const fetchMock = vi.fn(async () => fakeLogResponse(true, "line one\nline two\n", "0"));
    vi.stubGlobal("fetch", fetchMock);
    const { store } = installFakeStorage(seed);
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;
    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(0);
    const click = async (id: string) => {
      host.shadow.getElementById(id)!.dispatch("click");
      await vi.advanceTimersByTimeAsync(0);
    };
    return { host, hot, keydownListeners, fetchMock, store, click, html: () => host.shadow.innerHTML };
  }

  // The stylesheet itself contains `.panel.maximised`, so a bare
  // toContain("maximised") is always true — assert on the panel's class
  // attribute instead.
  const panelClass = (html: string) => /<div class="(panel[^"]*)"/.exec(html)?.[1] ?? "";

  it("renders all three controls whenever the log endpoint is available", async () => {
    const { html } = await openPanel();
    expect(html()).toContain('id="log-toggle"');
    expect(html()).toContain('id="log-wrap"');
    expect(html()).toContain('id="log-max"');
  });

  it("renders no controls at all when the endpoint is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeLogResponse(false)));
    installFakeStorage();
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;
    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(0);

    expect(host.shadow.innerHTML).not.toContain('id="log-toggle"');
    expect(host.shadow.innerHTML).not.toContain('id="gsx-log-box"');
  });

  it("collapsing hides the tail, keeps the controls, and STOPS polling", async () => {
    const { html, click, fetchMock } = await openPanel();
    expect(html()).toContain('id="gsx-log-box"');

    await click("log-toggle");
    expect(html()).toContain('id="log-toggle"');
    expect(html()).not.toContain('id="gsx-log-box"');
    expect(html()).toContain('aria-expanded="false"');

    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-expanding fetches immediately rather than waiting for the next tick", async () => {
    const { click, fetchMock } = await openPanel();
    await click("log-toggle");
    fetchMock.mockClear();

    await click("log-toggle");
    expect(fetchMock).toHaveBeenCalledWith("/__gsx/log");
  });

  it("a build starting does not re-expand a collapsed box or restart polling", async () => {
    // Collapse is the user's decision and outranks any phase change: a build
    // must not silently restart a 1s fetch loop they switched off.
    const { html, click, fetchMock, hot } = await openPanel();
    await click("log-toggle");
    expect(html()).not.toContain('id="gsx-log-box"');
    fetchMock.mockClear();

    hot.handlers["gsx:status"]!({ phase: "building", phaseSince: "2026-07-24T12:00:00Z" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(html()).not.toContain('id="gsx-log-box"');
    expect(fetchMock).not.toHaveBeenCalled();
    // The panel still tells you a build is running, just in its phase line.
    expect(html()).toContain("building");
  });

  it("wrap toggles the nowrap class and its aria-pressed state", async () => {
    const { html, click } = await openPanel();
    expect(html()).toContain('id="log-wrap" aria-pressed="true"');
    expect(html()).not.toContain('class="nowrap"');

    await click("log-wrap");
    expect(html()).toContain('id="log-wrap" aria-pressed="false"');
    expect(html()).toContain('class="nowrap"');
  });

  it("maximise adds the maximised class to the panel", async () => {
    const { html, click } = await openPanel();
    expect(panelClass(html())).toBe("panel expanded");

    await click("log-max");
    expect(panelClass(html())).toBe("panel expanded maximised");
    expect(html()).toContain('id="log-max" aria-pressed="true"');
  });

  it("maximising a collapsed box expands it", async () => {
    const { html, click } = await openPanel({ "gsx-devpanel-log": '{"collapsed":true}' });
    expect(html()).not.toContain('id="gsx-log-box"');

    await click("log-max");
    expect(html()).toContain('id="gsx-log-box"');
    expect(panelClass(html())).toBe("panel expanded maximised");
  });

  it("Esc exits maximised without closing the panel", async () => {
    const { html, click, keydownListeners, host } = await openPanel();
    await click("log-max");
    expect(panelClass(html())).toContain("maximised");

    pressPlain(keydownListeners, "Escape");
    await vi.advanceTimersByTimeAsync(0);

    expect(panelClass(html())).toBe("panel expanded");
    expect(host.style.display).not.toBe("none");
    expect(html()).toContain('id="gsx-log-box"');
  });

  it("Esc does nothing when not maximised", async () => {
    const { html, keydownListeners, host } = await openPanel();
    pressPlain(keydownListeners, "Escape");
    await vi.advanceTimersByTimeAsync(0);

    expect(host.style.display).not.toBe("none");
    expect(html()).toContain('id="gsx-log-box"');
  });

  it("Esc is ignored while typing in an editable element", async () => {
    const { html, click, keydownListeners } = await openPanel();
    await click("log-max");

    pressPlain(keydownListeners, "Escape", { tagName: "INPUT" });
    await vi.advanceTimersByTimeAsync(0);

    expect(panelClass(html())).toContain("maximised");
  });

  it("persists each toggle to localStorage", async () => {
    const { click, store } = await openPanel();
    await click("log-wrap");
    expect(JSON.parse(store.get("gsx-devpanel-log")!)).toEqual({
      collapsed: false, wrap: false, maximised: false,
    });

    await click("log-toggle");
    expect(JSON.parse(store.get("gsx-devpanel-log")!)).toEqual({
      collapsed: true, wrap: false, maximised: false,
    });
  });

  it("restores persisted controls on load", async () => {
    const { html } = await openPanel({
      "gsx-devpanel-log": '{"collapsed":false,"wrap":false,"maximised":true}',
    });
    expect(panelClass(html())).toBe("panel expanded maximised");
    expect(html()).toContain('class="nowrap"');
    expect(html()).toContain('id="gsx-log-box"');
  });

  it("starts collapsed — and makes zero requests beyond the one probe — when persisted collapsed", async () => {
    const { html, fetchMock } = await openPanel({ "gsx-devpanel-log": '{"collapsed":true}' });
    expect(html()).toContain('id="log-toggle"');
    expect(html()).not.toContain('id="gsx-log-box"');

    // The single probe still happens: whether to show the controls row at all
    // depends on its answer. Nothing beyond it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("survives a localStorage that throws on read and on write", async () => {
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => fakeLogResponse(true, "log\n", "0")));
    const { bodyChildren, keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);
    const host = bodyChildren[0]!;
    press(keydownListeners);
    hot.handlers["gsx:status"]!({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(0);

    // Defaults, and a working panel.
    expect(host.shadow.innerHTML).toContain('id="gsx-log-box"');
    host.shadow.getElementById("log-wrap")!.dispatch("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.shadow.innerHTML).toContain('class="nowrap"');
  });
});
