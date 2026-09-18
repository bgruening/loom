// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardHost } from "../app/src/renderer/dashboard/host.js";
import { WidgetRegistry } from "../app/src/renderer/dashboard/registry.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type { WidgetDefinition } from "../app/src/renderer/dashboard/widget-api.js";
import {
  createDefaultDashboardDocument,
  type DashboardDocument,
} from "../shared/dashboard-contract.js";

function doc(...widgets: string[]): DashboardDocument {
  return {
    version: 1,
    activeId: "d",
    dashboards: [
      {
        id: "d",
        title: "D",
        panels: widgets.map((widget, i) => ({
          id: `p${i}`,
          widget,
          config: {},
          layout: { span: 1 as const, rows: 2 },
        })),
      },
    ],
  };
}

function stubWidget(type: string, mount: WidgetDefinition["mount"]): WidgetDefinition {
  return { type, label: type, defaultConfig: {}, mount };
}

let root: HTMLElement;
let registry: WidgetRegistry;
let sources: DashboardSources;

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = document.getElementById("root")!;
  registry = new WidgetRegistry();
  sources = new DashboardSources();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function makeHost(persist?: (d: DashboardDocument) => void): DashboardHost {
  return new DashboardHost(root, { sources: sources.sources, registry, persist });
}

describe("rendering", () => {
  it("draws the default document's panels on construction", () => {
    registry.register(stubWidget("notebook", () => {}));
    registry.register(stubWidget("jobs", () => {}));
    registry.register(stubWidget("plan", () => {}));
    makeHost();
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(3);
    expect(
      [...root.querySelectorAll(".dash-panel")].map((p) => (p as HTMLElement).dataset.widget),
    ).toEqual(["notebook", "jobs", "plan"]);
  });

  it("applies span and rows to the grid", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    const next = doc("a");
    next.dashboards[0].panels[0].layout = { span: 2, rows: 4 };
    host.setDocument(next, { persist: false });
    const panel = root.querySelector(".dash-panel") as HTMLElement;
    expect(panel.style.gridColumn).toBe("span 2");
    expect(panel.style.getPropertyValue("--dash-panel-rows")).toBe("4");
  });

  it("prefers a panel title over the widget label", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    const next = doc("a");
    next.dashboards[0].panels[0].title = "My panel";
    host.setDocument(next, { persist: false });
    expect(root.querySelector(".dash-panel-title")?.textContent).toBe("My panel");
  });

  it("shows an empty state for a dashboard with no panels", () => {
    const host = makeHost();
    host.setDocument(
      { version: 1, activeId: "d", dashboards: [{ id: "d", title: "D", panels: [] }] },
      { persist: false },
    );
    expect(root.querySelector(".empty-state")).not.toBeNull();
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(0);
  });
});

describe("unknown widget types", () => {
  it("draws a placeholder rather than dropping the panel", () => {
    registry.register(stubWidget("known", () => {}));
    const host = makeHost();
    host.setDocument(doc("known", "from-the-future"), { persist: false });
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(2);
    const unknown = root.querySelector(".dash-card-unknown");
    expect(unknown?.textContent).toContain("from-the-future");
  });

  it("puts the type in the DOM as text, never as markup", () => {
    const host = makeHost();
    host.setDocument(doc("<img src=x onerror=alert(1)>"), { persist: false });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".dash-card-unknown")?.textContent).toContain("<img");
  });
});

describe("failure isolation", () => {
  it("isolates a widget that throws in mount and keeps the others alive", () => {
    let goodMounted = false;
    registry.register(
      stubWidget("bad", () => {
        throw new Error("mount exploded");
      }),
    );
    registry.register(
      stubWidget("good", (el) => {
        goodMounted = true;
        el.textContent = "fine";
      }),
    );
    const host = makeHost();
    host.setDocument(doc("bad", "good"), { persist: false });

    expect(goodMounted).toBe(true);
    const cards = root.querySelectorAll(".dash-card-error");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("mount exploded");
    expect(root.textContent).toContain("fine");
  });

  it("isolates a widget whose subscription callback throws on a later update", () => {
    registry.register(
      stubWidget("bad", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, (snap) => {
          if (snap.markdown) throw new Error("update exploded");
        });
      }),
    );
    registry.register(
      stubWidget("good", (el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, (snap) => {
          el.textContent = snap.markdown;
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("bad", "good"), { persist: false });
    expect(root.querySelectorAll(".dash-card-error")).toHaveLength(0);

    sources.setNotebook("hello");

    expect(root.querySelectorAll(".dash-card-error")).toHaveLength(1);
    expect(root.textContent).toContain("update exploded");
    // The healthy widget still received the update.
    expect(root.textContent).toContain("hello");
  });

  it("stops delivering updates to a widget that has already failed", () => {
    let calls = 0;
    registry.register(
      stubWidget("bad", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, () => {
          calls++;
          throw new Error("always");
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("bad"), { persist: false });
    sources.setNotebook("one");
    sources.setNotebook("two");
    // Once at mount (immediate) and never again.
    expect(calls).toBe(1);
  });

  it("lets a widget declare its own failure through ctx.fail", () => {
    registry.register(
      stubWidget("self", (_el, ctx) => {
        ctx.fail(new Error("cannot draw this"));
      }),
    );
    const host = makeHost();
    host.setDocument(doc("self"), { persist: false });
    expect(root.querySelector(".dash-card-error")?.textContent).toContain("cannot draw this");
  });

  it("survives a widget whose dispose throws", () => {
    registry.register(
      stubWidget("a", () => () => {
        throw new Error("dispose exploded");
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(() => host.setDocument(doc("a"), { persist: false })).not.toThrow();
  });
});

describe("lifecycle", () => {
  it("unsubscribes a widget's sources when the panel goes away", () => {
    let updates = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, () => {
          updates++;
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(updates).toBe(1);

    host.setDocument(
      { version: 1, activeId: "d", dashboards: [{ id: "d", title: "D", panels: [] }] },
      { persist: false },
    );
    sources.setNotebook("after removal");
    expect(updates).toBe(1);
  });

  it("clears the container and stops updates on dispose", () => {
    let updates = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, () => {
          updates++;
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    host.dispose();
    sources.setNotebook("after dispose");
    expect(updates).toBe(1);
    expect(root.textContent).toBe("");
  });
});

describe("document management", () => {
  it("hands out a copy, so a caller cannot mutate host state", () => {
    const host = makeHost();
    const copy = host.getDocument();
    copy.dashboards[0].panels = [];
    expect(host.getDocument().dashboards[0].panels.length).toBeGreaterThan(0);
  });

  it("persists on setDocument and not when persist is false", () => {
    const persist = vi.fn();
    registry.register(stubWidget("a", () => {}));
    const host = makeHost(persist);
    host.setDocument(doc("a"), { persist: false });
    expect(persist).not.toHaveBeenCalled();
    host.setDocument(doc("a"));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("rejects a fatally malformed document and changes nothing", () => {
    const persist = vi.fn();
    const host = makeHost(persist);
    const before = host.getDocument();
    const problems = host.setDocument({ version: 99 } as unknown as DashboardDocument);
    expect(problems.length).toBeGreaterThan(0);
    expect(persist).not.toHaveBeenCalled();
    expect(host.getDocument()).toEqual(before);
  });

  it("normalizes on the way in, so a repaired document is what renders", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    const problems = host.setDocument(
      {
        version: 1,
        activeId: "d",
        dashboards: [
          { id: "d", title: "D", panels: [{ id: "p", widget: "a", layout: { span: 7, rows: 0 } }] },
        ],
      } as unknown as DashboardDocument,
      { persist: false },
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(host.getDocument().dashboards[0].panels[0].layout).toEqual({ span: 1, rows: 1 });
  });

  it("writes a widget's config change back to the document and persists it", () => {
    const persist = vi.fn();
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.setConfig({ follow: false });
      }),
    );
    const host = makeHost(persist);
    host.setDocument(doc("a"), { persist: false });
    expect(host.getDocument().dashboards[0].panels[0].config).toEqual({ follow: false });
    expect(persist).toHaveBeenCalled();
  });

  it("merges the panel config over the widget's defaults", () => {
    let seen: Record<string, unknown> = {};
    registry.register({
      type: "a",
      label: "A",
      defaultConfig: { follow: true, depth: 3 },
      mount: (_el, ctx) => {
        seen = ctx.config;
      },
    });
    const host = makeHost();
    const next = doc("a");
    next.dashboards[0].panels[0].config = { depth: 9 };
    host.setDocument(next, { persist: false });
    expect(seen).toEqual({ follow: true, depth: 9 });
  });

  it("switches the active dashboard and ignores an id that does not exist", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    host.setDocument(
      {
        version: 1,
        activeId: "one",
        dashboards: [
          {
            id: "one",
            title: "One",
            panels: [{ id: "p", widget: "a", config: {}, layout: { span: 1, rows: 2 } }],
          },
          { id: "two", title: "Two", panels: [] },
        ],
      },
      { persist: false },
    );
    host.setActiveDashboardId("two");
    expect(host.getActiveDashboard()?.id).toBe("two");
    host.setActiveDashboardId("nope");
    expect(host.getActiveDashboard()?.id).toBe("two");
  });

  it("lists the registered widgets for the editor", () => {
    registry.register(stubWidget("a", () => {}));
    registry.register(stubWidget("b", () => {}));
    expect(
      makeHost()
        .listWidgets()
        .map((w) => w.type),
    ).toEqual(["a", "b"]);
  });
});

describe("banner", () => {
  it("shows and hides the note above the grid", () => {
    const host = makeHost();
    const banner = root.querySelector(".dash-banner") as HTMLElement;
    expect(banner.classList.contains("hidden")).toBe(true);
    host.setBanner("could not read the saved layout");
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.textContent).toBe("could not read the saved layout");
    host.setBanner("");
    expect(banner.classList.contains("hidden")).toBe(true);
  });
});

describe("registry", () => {
  it("refuses two widgets claiming the same type", () => {
    registry.register(stubWidget("a", () => {}));
    expect(() => registry.register(stubWidget("a", () => {}))).toThrow(/already registered/);
  });

  it("registers every built-in widget under a distinct type", async () => {
    const { BUILT_IN_WIDGETS } = await import("../app/src/renderer/dashboard/widgets/index.js");
    const types = BUILT_IN_WIDGETS.map((w) => w.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain("notebook");
  });

  it("gives the default document a widget for every panel it ships", async () => {
    const { BUILT_IN_WIDGETS } = await import("../app/src/renderer/dashboard/widgets/index.js");
    const known = new Set(BUILT_IN_WIDGETS.map((w) => w.type));
    for (const panel of createDefaultDashboardDocument().dashboards[0].panels) {
      expect(known.has(panel.widget), panel.widget).toBe(true);
    }
  });
});
