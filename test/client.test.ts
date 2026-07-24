import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// client.ts's DOM surface is small (createElement/attachShadow/appendChild,
// window.addEventListener) — minimal fakes stand in for jsdom, which this
// package doesn't otherwise depend on.
class FakeShadowRoot {
  innerHTML = "";
  getElementById(): null {
    return null;
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

function makeHot() {
  const handlers: Record<string, (data: any) => void> = {};
  const send = vi.fn();
  const on = vi.fn((event: string, cb: (data: any) => void) => {
    handlers[event] = cb;
  });
  return { handlers, send, on };
}

// The module holds an idempotence guard (`initialized`) at module scope, so
// each test that wires a fresh init() needs a fresh module instance —
// vitest's normal per-file module cache would otherwise make every init()
// after the first a silent no-op.
async function loadClient() {
  vi.resetModules();
  return import("../src/client.js");
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  vi.useRealTimers();
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
