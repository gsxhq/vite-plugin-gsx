import { describe, it, expect, vi, afterEach } from "vitest";
import { init } from "../src/client.js";

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
  private shadow = new FakeShadowRoot();
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

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
});

describe("init", () => {
  it("is idempotent: a second call does not double-register the host element or the keydown listener", () => {
    const { bodyChildren, keydownListeners } = installFakeDom();
    const hot = { send: vi.fn(), on: vi.fn() };

    init({ key: "d", hot } as any);
    init({ key: "d", hot } as any);

    expect(bodyChildren.length).toBe(1);
    expect(keydownListeners.length).toBe(1);
    expect(hot.on).toHaveBeenCalledTimes(1);
  });
});
