// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { htmlSandboxWidget } from "../app/src/renderer/dashboard/widgets/html-sandbox.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import {
  HTML_SANDBOX_FLAG_KEY,
  HTML_SANDBOX_GLOBAL,
} from "../app/src/renderer/dashboard/sandbox/flag.js";
import {
  SANDBOX_FORBIDDEN_TOKENS,
  SANDBOX_MAX_HTML_BYTES,
  SANDBOX_MAX_HEIGHT,
  SANDBOX_MESSAGE_TAG,
} from "../app/src/renderer/dashboard/sandbox/policy.js";
import type { DataSource, WidgetContext } from "../app/src/renderer/dashboard/widget-api.js";

type Config = { html: string; title?: string; data?: string[] };

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext<Config>;
  sources: DashboardSources;
  /** Which of the six sources the widget actually subscribed to. */
  subscribed: string[];
  dispose(): void;
}

function harness(config: Partial<Config> = {}): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  const sources = new DashboardSources();
  const offs: Array<() => void> = [];
  const cleanups: Array<() => void> = [];
  const subscribed: string[] = [];
  const names = Object.entries(sources.sources);

  const ctx = {
    panelId: "p1",
    config: { ...htmlSandboxWidget.defaultConfig, ...config },
    sources: sources.sources,
    header,
    setConfig: vi.fn(),
    fail: vi.fn(),
    onDispose(fn: () => void) {
      cleanups.push(fn);
    },
    subscribe<T>(
      source: DataSource<T>,
      listener: (value: T) => void,
      opts?: { immediate?: boolean },
    ) {
      const name = names.find(([, s]) => s === (source as unknown))?.[0];
      if (name) subscribed.push(name);
      const off = source.subscribe(listener);
      offs.push(off);
      if (opts?.immediate !== false) listener(source.get());
      return off;
    },
  } as unknown as WidgetContext<Config>;

  let widgetDispose: (() => void) | void;
  const h: Harness = {
    el,
    header,
    ctx,
    sources,
    subscribed,
    // Mirrors the host: unsubscribe, run registered cleanups newest-first,
    // then the widget's own dispose.
    dispose() {
      while (offs.length) offs.pop()?.();
      while (cleanups.length) cleanups.pop()?.();
      widgetDispose?.();
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h as any).run = () => {
    widgetDispose = htmlSandboxWidget.mount(el, ctx);
  };
  return h;
}

function mount(h: Harness): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h as any).run();
}

function frameIn(h: Harness): HTMLIFrameElement | null {
  return h.el.querySelector("iframe");
}

/** Stand in for the frame's window, which happy-dom will not script for us. */
function fakeFrameWindow(frame: HTMLIFrameElement): { posts: unknown[] } {
  const posts: unknown[] = [];
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: { postMessage: (msg: unknown) => posts.push(msg) },
  });
  return { posts };
}

function post(frame: HTMLIFrameElement, data: unknown, source?: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, source: (source ?? frame.contentWindow) as Window }),
  );
}

function enable(): void {
  localStorage.setItem(HTML_SANDBOX_FLAG_KEY, "1");
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.querySelector("#dash-sandbox-styles")?.remove();
  localStorage.clear();
  delete (globalThis as Record<string, unknown>)[HTML_SANDBOX_GLOBAL];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("html-sandbox widget contract", () => {
  it("keeps the type and symbol the registry and the layout document expect", () => {
    expect(htmlSandboxWidget.type).toBe("html-sandbox");
    expect(htmlSandboxWidget.defaultConfig).toEqual({ html: "", data: [] });
  });
});

describe("the flag", () => {
  it("is off with nothing set, and draws no frame at all", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("switched off");
    h.dispose();
  });

  it("is on when local storage says so", () => {
    enable();
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).not.toBeNull();
    h.dispose();
  });

  it("lets the shell turn it off over the top of local storage", () => {
    enable();
    (globalThis as Record<string, unknown>)[HTML_SANDBOX_GLOBAL] = { htmlSandbox: false };
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    h.dispose();
  });

  it("badges the panel whether it is on or off", () => {
    for (const on of [false, true]) {
      document.body.innerHTML = "";
      localStorage.clear();
      if (on) enable();
      const h = harness({ html: "<p>hi</p>" });
      mount(h);
      expect(h.header.querySelector(".dash-sandbox-badge")?.textContent).toBe("custom content");
      h.dispose();
    }
  });
});

describe("what gets into the frame", () => {
  beforeEach(enable);

  it("locks the frame down and says nothing more than allow-scripts", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    for (const token of SANDBOX_FORBIDDEN_TOKENS) {
      expect(frame.getAttribute("sandbox")).not.toContain(token);
    }
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("src")).toBeNull();
    h.dispose();
  });

  it("carries the content, behind the policy", () => {
    const h = harness({ html: "<p id='mine'>hi</p>" });
    mount(h);
    const doc = frameIn(h)!.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("id='mine'");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("id='mine'"));
    h.dispose();
  });

  it("asks for nothing when the panel has no content yet", () => {
    const h = harness({ html: "   " });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("Nothing to show yet");
    h.dispose();
  });

  it("refuses an oversized view rather than running it", () => {
    const h = harness({ html: "<p>" + "x".repeat(SANDBOX_MAX_HTML_BYTES) + "</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("too large");
    h.dispose();
  });

  it("measures the cap in bytes, not characters", () => {
    // Just under the cap in characters, well over it once encoded.
    const h = harness({ html: "—".repeat(SANDBOX_MAX_HTML_BYTES - 10) });
    mount(h);
    expect(frameIn(h)).toBeNull();
    h.dispose();
  });
});

describe("data in", () => {
  beforeEach(enable);

  it("subscribes to nothing when the panel named nothing", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(h.subscribed).toEqual([]);
    h.dispose();
  });

  it("subscribes only to the sources the panel named", () => {
    const h = harness({ html: "<p>hi</p>", data: ["plan", "bogus", "session"] });
    mount(h);
    expect(h.subscribed.sort()).toEqual(["plan", "session"]);
    h.dispose();
  });

  it("sends nothing until the frame says it is ready", () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    const win = fakeFrameWindow(frame);
    h.sources.setNotebook("# something");
    expect(win.posts).toHaveLength(0);
    h.dispose();
  });

  it("sends the allowed sources, and only those, once the frame is ready", () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    const win = fakeFrameWindow(frame);
    h.sources.setNotebook("# a heading");
    h.sources.setSession({ model: "secret-model" });

    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "ready" });

    expect(win.posts).toHaveLength(1);
    const msg = win.posts[0] as { tag: string; sources: Record<string, unknown> };
    expect(msg.tag).toBe(SANDBOX_MESSAGE_TAG);
    expect(Object.keys(msg.sources)).toEqual(["notebook"]);
    expect(JSON.stringify(msg)).toContain("a heading");
    expect(JSON.stringify(msg)).not.toContain("secret-model");
    h.dispose();
  });
});

describe("data out", () => {
  beforeEach(enable);

  it("applies a height the frame asks for", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    fakeFrameWindow(frame);
    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "height", height: 260 });
    expect(frame.style.height).toBe("260px");
    h.dispose();
  });

  it("clamps an absurd height instead of growing the page", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    fakeFrameWindow(frame);
    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "height", height: 5_000_000 });
    expect(frame.style.height).toBe(`${SANDBOX_MAX_HEIGHT}px`);
    h.dispose();
  });

  it("ignores a message from anything that is not this frame", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    fakeFrameWindow(frame);
    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "height", height: 300 }, { impostor: true });
    expect(frame.style.height).toBe("100%");
    h.dispose();
  });

  it("ignores anything that is not one of the two known messages", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    fakeFrameWindow(frame);
    for (const junk of [
      "height",
      { type: "height", height: 300 },
      { tag: SANDBOX_MESSAGE_TAG, type: "setConfig", html: "<p>replaced</p>" },
      { tag: SANDBOX_MESSAGE_TAG, type: "height", height: "300" },
    ]) {
      post(frame, junk);
    }
    expect(frame.style.height).toBe("100%");
    expect(h.ctx.setConfig).not.toHaveBeenCalled();
    h.dispose();
  });

  it("stops listening to a flood and says what it did", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    fakeFrameWindow(frame);
    for (let i = 0; i < 200; i++) {
      post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "height", height: 100 + i });
    }
    // The last accepted height, not the last sent one.
    expect(parseInt(frame.style.height, 10)).toBeLessThan(200);
    expect(h.el.textContent).toContain("more than its share");
    h.dispose();
  });

  it("hears nothing after the panel is gone", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    fakeFrameWindow(frame);
    h.dispose();
    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "height", height: 700 });
    expect(frame.style.height).not.toBe("700px");
    expect(h.el.textContent).toBe("");
  });
});

describe("the navigation watchdog", () => {
  beforeEach(enable);

  it("leaves the first load alone", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    frame.dispatchEvent(new Event("load"));
    expect(frameIn(h)).not.toBeNull();
    h.dispose();
  });

  it("tears the frame down if it loads a second document", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    frame.dispatchEvent(new Event("load"));
    frame.dispatchEvent(new Event("load"));
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("tried to open a web page");
    expect(h.el.querySelector(".dash-sandbox-alarm")).not.toBeNull();
    h.dispose();
  });

  it("says nothing more to a frame that has navigated", () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    const win = fakeFrameWindow(frame);
    frame.dispatchEvent(new Event("load"));
    frame.dispatchEvent(new Event("load"));
    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "ready" });
    expect(win.posts).toHaveLength(0);
    h.dispose();
  });
});

describe("when Orbit's own policy blocks the frame's scripts", () => {
  beforeEach(enable);

  it("says so, once it is clear no bridge is coming", () => {
    vi.useFakeTimers();
    const h = harness({ html: "<script>draw()</script><p>chart</p>" });
    mount(h);
    vi.advanceTimersByTime(5000);
    expect(h.el.textContent).toContain("still picture");
    h.dispose();
  });

  it("stays quiet for a view that has no script to block", () => {
    vi.useFakeTimers();
    const h = harness({ html: "<svg><rect width='10' height='10'/></svg>" });
    mount(h);
    vi.advanceTimersByTime(5000);
    expect(h.el.textContent).not.toContain("still picture");
    h.dispose();
  });

  it("stays quiet when the bridge does answer", () => {
    vi.useFakeTimers();
    const h = harness({ html: "<script>draw()</script>" });
    mount(h);
    const frame = frameIn(h)!;
    fakeFrameWindow(frame);
    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "ready" });
    vi.advanceTimersByTime(5000);
    expect(h.el.textContent).not.toContain("still picture");
    h.dispose();
  });
});
