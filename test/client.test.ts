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

  it("makes zero requests while visible but idle", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { keydownListeners } = installFakeDom();
    const { init } = await loadClient();
    const hot = makeHot();
    init({ key: "d", hot } as any);

    press(keydownListeners);
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

  it("box is removed and polling stops once the phase leaves building/starting", async () => {
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
    expect(host.shadow.innerHTML).toContain('class="panel expanded"');
    expect(host.shadow.innerHTML).toContain('id="gsx-log-box"');

    hot.handlers["gsx:status"]!({ phase: "idle" });
    expect(host.shadow.innerHTML).not.toContain('id="gsx-log-box"');

    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).not.toHaveBeenCalled();
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
