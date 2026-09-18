// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardHost } from "../app/src/renderer/dashboard/host.js";
import { WidgetRegistry } from "../app/src/renderer/dashboard/registry.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import { createDashboardEditor } from "../app/src/renderer/dashboard/editor.js";
import type { DashboardEditorController } from "../app/src/renderer/dashboard/editor/controller.js";
import type { WidgetDefinition } from "../app/src/renderer/dashboard/widget-api.js";
import {
  createDefaultDashboardDocument,
  type DashboardDocument,
} from "../shared/dashboard-contract.js";

let root: HTMLElement;
let registry: WidgetRegistry;
let sources: DashboardSources;
let editor: DashboardEditorController;
let host: DashboardHost;
let clock: number;
let mounts: Record<string, number>;

function stubWidget(type: string, extra: Partial<WidgetDefinition> = {}): WidgetDefinition {
  return {
    type,
    label: `${type[0].toUpperCase()}${type.slice(1)}`,
    description: `The ${type} widget.`,
    defaultConfig: {},
    mount: () => {
      mounts[type] = (mounts[type] ?? 0) + 1;
    },
    ...extra,
  };
}

function doc(...widgets: string[]): DashboardDocument {
  return {
    version: 1,
    activeId: "d",
    dashboards: [
      {
        id: "d",
        title: "Main",
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

/**
 * A host with the editor attached, starting from `document_` -- which stands in
 * for the saved layout the bootstrap reads off disk, so the settle window has
 * to still be open when it lands.
 */
function build(document_?: DashboardDocument, settleMs = 5000): void {
  editor = createDashboardEditor({ now: () => clock, settleMs });
  host = new DashboardHost(root, { sources: sources.sources, registry, editor });
  if (document_) host.setDocument(document_, { persist: false });
}

function act(name: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`[data-act="${name}"]`);
  if (!node) throw new Error(`no control with data-act="${name}"`);
  return node;
}

function maybeAct(name: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-act="${name}"]`);
}

function panelEl(panelId: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`.dash-panel[data-panel-id="${panelId}"]`);
  if (!node) throw new Error(`no panel ${panelId}`);
  return node;
}

function tool(panelId: string, name: string): HTMLButtonElement {
  const node = panelEl(panelId).querySelector<HTMLButtonElement>(
    `.dash-panel-tools [data-act="${name}"]`,
  );
  if (!node) throw new Error(`no ${name} tool on ${panelId}`);
  return node;
}

function panelOrder(): string[] {
  return [...root.querySelectorAll<HTMLElement>(".dash-panel")].map(
    (p) => p.dataset.panelId ?? "?",
  );
}

function live(): string {
  return root.querySelector(".dash-editor-live")?.textContent ?? "";
}

function startEditing(): void {
  act("toggle-edit").click();
}

function keyOn(element: HTMLElement, init: KeyboardEventInit): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

/** Let the grid's MutationObserver deliver, which is how a render with no panels is noticed. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = document.getElementById("root")!;
  registry = new WidgetRegistry();
  sources = new DashboardSources();
  clock = 1_000_000;
  mounts = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const type of ["notebook", "jobs", "plan"]) registry.register(stubWidget(type));
});

describe("the toolbar", () => {
  it("fills the slot the host gave it and starts out of edit mode", () => {
    build();
    const toolbar = root.querySelector(".dash-toolbar")!;
    expect(toolbar.classList.contains("dash-editor")).toBe(true);
    expect(act("toggle-edit").textContent).toBe("Edit layout");
    expect(act("toggle-edit").getAttribute("aria-pressed")).toBe("false");
    expect(
      (act("add-panel") as HTMLElement).closest(".dash-editor-row")!.hasAttribute("hidden"),
    ).toBe(true);
    expect(root.classList.contains("dash-editing")).toBe(false);
  });

  it("lists every dashboard and switches between them without an undo entry", async () => {
    build();
    host.setDocument(
      {
        version: 1,
        activeId: "one",
        dashboards: [
          { id: "one", title: "One", panels: [] },
          { id: "two", title: "Two", panels: [] },
        ],
      },
      { persist: false },
    );
    // Neither dashboard has a panel, so nothing decorated: the grid watcher is
    // what tells the toolbar its list is out of date.
    await flush();
    const select = act("select-dashboard") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["One", "Two"]);
    expect(select.value).toBe("one");

    select.value = "two";
    select.dispatchEvent(new Event("change"));
    expect(host.getDocument().activeId).toBe("two");
    expect(live()).toBe("Showing Two");
    startEditing();
    expect(root.querySelector(".dash-editor-note")!.hasAttribute("hidden")).toBe(true);
  });

  it("shows the editing controls, the keyboard hints and the panel tools on toggle", () => {
    build(doc("notebook"));
    expect(root.querySelector(".dash-editor-hint")!.hasAttribute("hidden")).toBe(true);
    startEditing();
    expect(act("toggle-edit").textContent).toBe("Done");
    expect(act("toggle-edit").getAttribute("aria-pressed")).toBe("true");
    expect(root.classList.contains("dash-editing")).toBe(true);
    expect(root.querySelector(".dash-editor-hint")!.hasAttribute("hidden")).toBe(false);
    expect(panelEl("p0").tabIndex).toBe(0);
    expect(panelEl("p0").getAttribute("aria-label")).toBe(
      "Notebook, panel 1 of 1, half width, 2 rows tall",
    );
    expect(live()).toBe("Editing the layout");
  });

  it("does not re-mount the widgets just to enter edit mode", () => {
    build(doc("notebook", "jobs"));
    const before = { ...mounts };
    startEditing();
    act("toggle-edit").click();
    expect(mounts).toEqual(before);
    expect(panelEl("p0").hasAttribute("tabindex")).toBe(false);
  });
});

describe("reordering and resizing", () => {
  beforeEach(() => {
    build(doc("notebook", "jobs", "plan"));
    startEditing();
  });

  it("moves a panel with the header buttons and says where it went", () => {
    tool("p0", "move-down").click();
    expect(panelOrder()).toEqual(["p1", "p0", "p2"]);
    expect(live()).toBe("Notebook moved to position 2 of 3");
    tool("p0", "move-up").click();
    expect(panelOrder()).toEqual(["p0", "p1", "p2"]);
  });

  it("disables the move buttons at the ends", () => {
    expect(tool("p0", "move-up").disabled).toBe(true);
    expect(tool("p0", "move-down").disabled).toBe(false);
    expect(tool("p2", "move-down").disabled).toBe(true);
  });

  it("puts focus back on the button the user pressed, not on the body", () => {
    tool("p0", "move-down").click();
    expect(document.activeElement).toBe(tool("p0", "move-down"));
  });

  it("falls back to the panel when the button it would return to is now disabled", () => {
    tool("p1", "move-up").click();
    // p1 is first now, so its move-up is disabled; focus lands on the panel.
    expect(tool("p1", "move-up").disabled).toBe(true);
    expect(document.activeElement).toBe(panelEl("p1"));
  });

  it("toggles width and writes it into the document", () => {
    tool("p0", "toggle-width").click();
    expect(host.getDocument().dashboards[0].panels[0].layout.span).toBe(2);
    expect(panelEl("p0").style.gridColumn).toBe("span 2");
    expect(live()).toBe("Notebook is now full width");
    tool("p0", "toggle-width").click();
    expect(host.getDocument().dashboards[0].panels[0].layout.span).toBe(1);
  });

  it("moves, widens and resizes from the keyboard", () => {
    const panel = panelEl("p0");
    keyOn(panel, { key: "ArrowDown", altKey: true });
    expect(panelOrder()).toEqual(["p1", "p0", "p2"]);

    keyOn(panelEl("p0"), { key: "ArrowRight", altKey: true });
    expect(host.getDocument().dashboards[0].panels[1].layout.span).toBe(2);

    keyOn(panelEl("p0"), { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(host.getDocument().dashboards[0].panels[1].layout.rows).toBe(3);
    expect(live()).toBe("Notebook is now 3 rows tall");

    keyOn(panelEl("p0"), { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(host.getDocument().dashboards[0].panels[1].layout.rows).toBe(2);
  });

  it("says so instead of doing nothing silently at a bound", () => {
    keyOn(panelEl("p0"), { key: "ArrowUp", altKey: true });
    expect(live()).toBe("Notebook is already first");
    expect(panelOrder()).toEqual(["p0", "p1", "p2"]);

    for (let i = 0; i < 5; i++)
      keyOn(panelEl("p0"), { key: "ArrowUp", altKey: true, shiftKey: true });
    expect(live()).toBe("Notebook is already as short as it goes");
    expect(host.getDocument().dashboards[0].panels[0].layout.rows).toBe(1);
  });

  it("ignores the arrows without Alt, so a widget's own keys still work", () => {
    keyOn(panelEl("p0"), { key: "ArrowDown" });
    expect(panelOrder()).toEqual(["p0", "p1", "p2"]);
  });

  it("does nothing on the keyboard outside edit mode", () => {
    act("toggle-edit").click();
    keyOn(panelEl("p0"), { key: "ArrowDown", altKey: true });
    keyOn(panelEl("p0"), { key: "Delete" });
    expect(panelOrder()).toEqual(["p0", "p1", "p2"]);
  });
});

describe("adding and removing panels", () => {
  it("offers every registered widget with its description, and marks the ones in use", () => {
    build(doc("notebook"));
    startEditing();
    act("add-panel").click();
    const cards = [...root.querySelectorAll(".dash-editor-gallery-card")];
    expect(cards.map((c) => c.querySelector("b")?.textContent)).toEqual([
      "Notebook",
      "Jobs",
      "Plan",
    ]);
    expect(cards[0].querySelector("small")?.textContent).toBe("The notebook widget.");
    expect(cards[0].querySelector("em")?.textContent).toBe("Already on this dashboard");
    expect(cards[1].querySelector("em")).toBeNull();
  });

  it("adds the chosen widget at the end, closes the picker and focuses the new panel", () => {
    build(doc("notebook"));
    startEditing();
    act("add-panel").click();
    act("add-plan").click();
    const panels = host.getDocument().dashboards[0].panels;
    expect(panels.map((p) => p.widget)).toEqual(["notebook", "plan"]);
    expect(panels[1].addedBy).toBe("user");
    expect(maybeAct("add-plan")).toBeNull();
    expect(document.activeElement).toBe(panelEl(panels[1].id));
    expect(live()).toBe("Plan added at the end");
  });

  it("removes a panel, offers Undo, and puts it back where it was", () => {
    build(doc("notebook", "jobs", "plan"));
    startEditing();
    tool("p1", "remove").click();
    expect(panelOrder()).toEqual(["p0", "p2"]);
    const note = root.querySelector(".dash-editor-note")!;
    expect(note.hasAttribute("hidden")).toBe(false);
    expect(note.querySelector(".dash-editor-note-text")?.textContent).toContain("Jobs");

    act("undo").click();
    expect(panelOrder()).toEqual(["p0", "p1", "p2"]);
    expect(live()).toContain("Undone");
    expect(root.querySelector(".dash-editor-note")!.hasAttribute("hidden")).toBe(true);
  });

  it("removes with Delete only when the panel itself has focus", () => {
    build(doc("notebook", "jobs"));
    startEditing();
    keyOn(tool("p0", "move-down"), { key: "Delete" });
    expect(panelOrder()).toEqual(["p0", "p1"]);
    keyOn(panelEl("p0"), { key: "Delete" });
    expect(panelOrder()).toEqual(["p1"]);
  });

  it("moves focus to a neighbour after a remove", () => {
    build(doc("notebook", "jobs", "plan"));
    startEditing();
    tool("p1", "remove").click();
    expect(document.activeElement).toBe(panelEl("p2"));
  });
});

describe("dashboards", () => {
  it("creates an empty one with the name that was typed", () => {
    build();
    startEditing();
    act("new-dashboard").click();
    const name = act("new-title") as HTMLInputElement;
    name.value = "QC run";
    act("new-blank").click();
    const document_ = host.getDocument();
    expect(document_.dashboards.map((d) => d.title)).toEqual(["Current analysis", "QC run"]);
    expect(document_.activeId).toBe("qc-run");
    expect(document_.dashboards[1].panels).toEqual([]);
  });

  it("starts a new dashboard from a preset", () => {
    build();
    startEditing();
    act("new-dashboard").click();
    act("new-preset-monitoring").click();
    const created = host.getDocument().dashboards.at(-1)!;
    expect(created.title).toBe("Monitoring");
    expect(created.panels.map((p) => p.widget)).toEqual(["jobs", "plan", "activity"]);
  });

  it("renames, and refuses a blank name with a message rather than silently", () => {
    build();
    startEditing();
    act("rename-dashboard").click();
    const field = act("rename-title") as HTMLInputElement;
    field.value = "   ";
    act("rename-save").click();
    expect(root.querySelector(".dash-editor-error")?.textContent).toBe("A dashboard needs a name.");

    (act("rename-title") as HTMLInputElement).value = "Sequencing";
    act("rename-save").click();
    expect(host.getDocument().dashboards[0].title).toBe("Sequencing");
    expect(maybeAct("rename-save")).toBeNull();
  });

  it("duplicates the active dashboard and switches to the copy", () => {
    build(doc("notebook", "jobs"));
    startEditing();
    act("duplicate-dashboard").click();
    const document_ = host.getDocument();
    expect(document_.dashboards.map((d) => d.title)).toEqual(["Main", "Main (copy)"]);
    expect(document_.activeId).toBe("d-copy");
    expect(panelOrder()).toEqual(["p0", "p1"]);
  });

  it("confirms a delete, and does nothing on cancel", () => {
    build();
    startEditing();
    act("duplicate-dashboard").click();
    act("delete-dashboard").click();
    expect(act("confirm-go").textContent).toBe("Delete dashboard");
    act("confirm-cancel").click();
    expect(host.getDocument().dashboards).toHaveLength(2);

    act("delete-dashboard").click();
    act("confirm-go").click();
    expect(host.getDocument().dashboards.map((d) => d.id)).toEqual(["current-analysis"]);
    expect(act("undo")).toBeTruthy();
  });

  it("will not delete the only dashboard, and says why", () => {
    build();
    startEditing();
    const remove = act("delete-dashboard") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toContain("only dashboard");
  });

  it("resets to the default behind a confirm, and that is undoable too", () => {
    build(doc("notebook"));
    startEditing();
    act("reset").click();
    expect(root.querySelector(".dash-editor-sheet-head-title")?.textContent).toContain("Reset");
    act("confirm-go").click();
    expect(host.getDocument()).toEqual(createDefaultDashboardDocument());

    act("undo").click();
    expect(host.getDocument().dashboards[0].id).toBe("d");
    expect(panelOrder()).toEqual(["p0"]);
  });

  it("closes a sheet on Escape", () => {
    build();
    startEditing();
    act("new-dashboard").click();
    root
      .querySelector(".dash-editor-sheet")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(maybeAct("new-blank")).toBeNull();
  });
});

describe("panel settings", () => {
  beforeEach(() => {
    registry.register(
      stubWidget("follower", { label: "Follower", defaultConfig: { follow: true, limit: 10 } }),
    );
  });

  it("renames a panel and clears the override again", () => {
    build(doc("notebook"));
    startEditing();
    tool("p0", "settings").click();
    const title = act("panel-title") as HTMLInputElement;
    expect(title.placeholder).toBe("Notebook");
    title.value = "Lab book";
    title.dispatchEvent(new Event("change"));
    expect(host.getDocument().dashboards[0].panels[0].title).toBe("Lab book");
    expect(panelEl("p0").querySelector(".dash-panel-title")?.textContent).toBe("Lab book");

    (act("panel-title") as HTMLInputElement).value = "";
    act("panel-title").dispatchEvent(new Event("change"));
    expect(host.getDocument().dashboards[0].panels[0].title).toBeUndefined();
  });

  it("sets width and height from buttons, and disables them at the bounds", () => {
    build(doc("notebook"));
    startEditing();
    tool("p0", "settings").click();
    expect(act("panel-half").getAttribute("aria-pressed")).toBe("true");
    act("panel-full").click();
    expect(host.getDocument().dashboards[0].panels[0].layout.span).toBe(2);
    expect(act("panel-full").getAttribute("aria-pressed")).toBe("true");

    for (let i = 0; i < 6; i++) act("panel-taller").click();
    expect(host.getDocument().dashboards[0].panels[0].layout.rows).toBe(6);
    expect((act("panel-taller") as HTMLButtonElement).disabled).toBe(true);
    expect(root.querySelector(".dash-editor-stepper output")?.textContent).toBe("6 rows");
  });

  it("generates a control for each setting the widget declared", () => {
    build(doc("follower"));
    startEditing();
    tool("p0", "settings").click();
    const follow = act("config-follow") as HTMLInputElement;
    expect(follow.type).toBe("checkbox");
    expect(follow.checked).toBe(true);
    follow.checked = false;
    follow.dispatchEvent(new Event("change"));
    expect(host.getDocument().dashboards[0].panels[0].config).toEqual({ follow: false });

    const limit = act("config-limit") as HTMLInputElement;
    expect(limit.type).toBe("number");
    limit.value = "25";
    limit.dispatchEvent(new Event("change"));
    expect(host.getDocument().dashboards[0].panels[0].config).toEqual({ follow: false, limit: 25 });
  });

  it("refuses a number field that is not a number", () => {
    build(doc("follower"));
    startEditing();
    tool("p0", "settings").click();
    const limit = act("config-limit") as HTMLInputElement;
    limit.value = "";
    limit.dispatchEvent(new Event("change"));
    expect(root.querySelector(".dash-editor-error")?.textContent).toBe("Limit has to be a number.");
    expect(host.getDocument().dashboards[0].panels[0].config).toEqual({});
  });

  it("offers the raw JSON, applies it, and explains what is wrong with bad text", () => {
    build(doc("notebook"));
    startEditing();
    tool("p0", "settings").click();
    const area = act("config-json") as HTMLTextAreaElement;
    area.value = "{ nope";
    act("config-json-apply").click();
    expect(root.querySelector(".dash-editor-error")?.textContent).toContain("not valid JSON");

    (act("config-json") as HTMLTextAreaElement).value = '{"custom": 3}';
    act("config-json-apply").click();
    expect(host.getDocument().dashboards[0].panels[0].config).toEqual({ custom: 3 });
    expect(root.querySelector(".dash-editor-error")).toBeNull();
  });

  it("says which settings only the JSON editor can reach", () => {
    build(doc("follower"));
    startEditing();
    tool("p0", "settings").click();
    (act("config-json") as HTMLTextAreaElement).value = '{"follow": true, "shape": {"a": 1}}';
    act("config-json-apply").click();
    const notes = [...root.querySelectorAll(".dash-editor-sheet-detail")].map((p) => p.textContent);
    expect(notes.some((t) => t?.includes("shape is only editable as JSON"))).toBe(true);
  });

  it("tells the truth about a widget this build does not have", () => {
    build(doc("from-the-future"));
    startEditing();
    tool("p0", "settings").click();
    const note = root.querySelector(".dash-editor-sheet-detail")?.textContent ?? "";
    expect(note).toContain("from-the-future");
    expect(note).toContain("only be edited as JSON");
    expect(maybeAct("config-json")).not.toBeNull();
  });

  it("closes itself when its panel is removed", () => {
    build(doc("notebook", "jobs"));
    startEditing();
    tool("p0", "settings").click();
    expect(maybeAct("panel-title")).not.toBeNull();
    tool("p0", "remove").click();
    expect(maybeAct("panel-title")).toBeNull();
  });
});

describe("a widget type this build does not know", () => {
  it("is editable like any other panel and keeps its provenance", () => {
    build({
      version: 1,
      activeId: "d",
      dashboards: [
        {
          id: "d",
          title: "Main",
          panels: [
            { id: "p0", widget: "notebook", config: {}, layout: { span: 1, rows: 2 } },
            {
              id: "p1",
              widget: "galaxy-history-live",
              title: "Live history",
              config: { historyId: "abc" },
              layout: { span: 2, rows: 4 },
              addedBy: "agent",
              reason: "from a newer build",
              pinned: true,
            },
          ],
        },
      ],
    });
    startEditing();
    expect(panelEl("p1").querySelector(".dash-card-unknown")).not.toBeNull();
    tool("p1", "move-up").click();
    expect(panelOrder()).toEqual(["p1", "p0"]);
    expect(host.getDocument().dashboards[0].panels[0]).toEqual({
      id: "p1",
      widget: "galaxy-history-live",
      title: "Live history",
      config: { historyId: "abc" },
      layout: { span: 2, rows: 4 },
      addedBy: "agent",
      reason: "from a newer build",
      pinned: true,
    });
  });

  it("puts a hostile widget type in the panel label as text, never as markup", () => {
    build(doc("<img src=x onerror=alert(1)>"));
    startEditing();
    expect(root.querySelector("img")).toBeNull();
    expect(panelEl("p0").getAttribute("aria-label")).toContain("<img");
  });
});

describe("changes the editor did not make", () => {
  it("offers Undo for one, and says who did it, even outside edit mode", () => {
    build(doc("notebook"));
    clock += 60_000;
    const next = host.getDocument();
    next.dashboards[0].panels.push({
      id: "agent-panel",
      widget: "jobs",
      config: {},
      layout: { span: 1, rows: 2 },
      addedBy: "agent",
      reason: "an invocation started",
    });
    host.setDocument(next, { persist: false });

    const note = root.querySelector(".dash-editor-note")!;
    expect(note.hasAttribute("hidden")).toBe(false);
    expect(note.querySelector(".dash-editor-note-text")?.textContent).toContain(
      "outside the editor",
    );

    act("undo").click();
    expect(panelOrder()).toEqual(["p0"]);
  });

  it("does not offer Undo for the saved layout arriving at startup", () => {
    build(undefined, 5000);
    // Still inside the settle window, and what it replaces is the untouched
    // default, so this is the file being read, not a change to anything seen.
    clock += 100;
    host.setDocument(doc("notebook", "jobs"), { persist: false });
    expect(root.querySelector(".dash-editor-note")!.hasAttribute("hidden")).toBe(true);
    startEditing();
    expect(root.querySelector(".dash-editor-note")!.hasAttribute("hidden")).toBe(true);
  });

  it("does offer Undo once the startup window has passed", () => {
    build(undefined, 5000);
    clock += 5001;
    host.setDocument(doc("notebook"), { persist: false });
    startEditing();
    expect(root.querySelector(".dash-editor-note")!.hasAttribute("hidden")).toBe(false);
  });
});

describe("what leaves the editor", () => {
  it("validates before every write, and persists through the host", () => {
    const persist = vi.fn();
    editor = createDashboardEditor({ now: () => clock, settleMs: 5000 });
    host = new DashboardHost(root, { sources: sources.sources, registry, editor, persist });
    host.setDocument(doc("notebook"), { persist: false });
    const setDocument = vi.spyOn(host, "setDocument");
    startEditing();

    tool("p0", "toggle-width").click();
    expect(setDocument).toHaveBeenCalledTimes(1);
    const written = setDocument.mock.calls[0][0];
    // The editor hands over an already-normalized document, so the host's own
    // validation finds nothing to repair.
    expect(written.version).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("keeps the toolbar in step when the host is emptied of panels", () => {
    build(doc("notebook"));
    startEditing();
    tool("p0", "remove").click();
    expect(root.querySelector(".empty-state")).not.toBeNull();
    expect((act("add-panel") as HTMLButtonElement).disabled).toBe(false);
    act("undo").click();
    expect(panelOrder()).toEqual(["p0"]);
  });

  it("stops touching the document once the host disposes it", () => {
    build(doc("notebook"));
    startEditing();
    host.dispose();
    expect(root.textContent).toBe("");
  });
});
