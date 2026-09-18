/**
 * `dashboard_read` / `dashboard_update` -- the brain's handle on the layout the
 * user sees beside the chat.
 *
 * What these pin down, in rough order of how much it matters: the agent cannot
 * touch a panel the user placed or pinned, however it phrases the write; it
 * cannot create a widget this build does not draw, the sandboxed HTML one least
 * of all; the write is a compare-and-swap through a temp file at a path no tool
 * argument can influence; and a refusal writes nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DASHBOARD_FILENAME,
  DASHBOARD_MAX_BYTES,
  createDefaultDashboardDocument,
  serializeDashboardDocument,
} from "../shared/dashboard-contract.js";
import type { DashboardDocument } from "../shared/dashboard-contract.js";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import {
  applyDashboardActions,
  introducedWidgetTypes,
  isProtectedPanel,
  presetLines,
  provenanceViolations,
  registerDashboardTools,
  sandboxWidgetEnabled,
  widgetCatalogLines,
} from "../extensions/loom/dashboard-tools";
import {
  getDashboardPath,
  resetDashboardUndo,
  updateDashboardDocument,
} from "../extensions/loom/dashboard-store";

interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
  renderResult?: (result: { details?: unknown }) => unknown;
}

let tmpDir: string;
let dashPath: string;

function tools(): Map<string, ToolDef> {
  const registered: ToolDef[] = [];
  const api = { registerTool: (def: ToolDef) => registered.push(def) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDashboardTools(api as any);
  return new Map(registered.map((t) => [t.name, t]));
}

async function run(
  name: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = tools().get(name);
  if (!tool) throw new Error(`${name} not registered`);
  const result = await tool.execute("call-1", params, new AbortController().signal, vi.fn(), {});
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onDisk(): DashboardDocument {
  return JSON.parse(fs.readFileSync(dashPath, "utf-8")) as DashboardDocument;
}

/** A document with one dashboard whose panels are exactly what a test needs. */
function documentWith(panels: DashboardDocument["dashboards"][0]["panels"]): DashboardDocument {
  return {
    version: 1,
    activeId: "current-analysis",
    dashboards: [{ id: "current-analysis", title: "Current analysis", panels }],
  };
}

function seed(document: DashboardDocument): void {
  fs.writeFileSync(dashPath, serializeDashboardDocument(document), "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dashboard-agent-"));
  fs.writeFileSync(path.join(tmpDir, "notebook.md"), "# notebook\n", "utf-8");
  dashPath = path.join(tmpDir, DASHBOARD_FILENAME);
  resetState();
  resetDashboardUndo();
  setNotebookPath(path.join(tmpDir, "notebook.md"));
});

afterEach(() => {
  resetState();
  resetDashboardUndo();
  delete process.env.LOOM_SHELL_KIND;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("registration", () => {
  it("registers exactly the two dashboard tools", () => {
    expect([...tools().keys()].sort()).toEqual(["dashboard_read", "dashboard_update"]);
  });

  it("tells the model in the write tool's description that it acts only when asked", () => {
    const description = tools().get("dashboard_update")!.description;
    expect(description).toContain("Only when the user asks");
    expect(description).toContain("on your own");
    expect(description).toContain("pinned");
  });

  it("takes no filesystem path from the model", () => {
    for (const tool of tools().values()) {
      const keys = Object.keys(
        (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(keys.filter((k) => /path|file|dir/i.test(k))).toEqual([]);
    }
  });

  it("derives the advertised widget vocabulary from the shared contract", () => {
    // Not a second hand-written list: the notebook widget's example config is
    // the one the shipped preset uses.
    expect(widgetCatalogLines()).toContain('notebook (config {"follow":true})');
    expect(widgetCatalogLines()).toContain("jobs (config {})");
    expect(widgetCatalogLines().some((line) => line.startsWith("html-sandbox"))).toBe(false);
    expect(presetLines().some((line) => line.startsWith("current-analysis --"))).toBe(true);
  });
});

describe("dashboard_read", () => {
  it("reports the default layout when nothing is on disk", async () => {
    const result = await run("dashboard_read");
    expect(result.success).toBe(true);
    expect(result.exists).toBe(false);
    expect(result.note).toContain("No layout file yet");
    expect((result.document as DashboardDocument).dashboards[0].id).toBe("current-analysis");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("reads what is on disk, with provenance in the summary", async () => {
    seed(
      documentWith([
        {
          id: "p-notes",
          widget: "notebook",
          config: {},
          layout: { span: 2, rows: 2 },
          addedBy: "user",
          pinned: true,
        },
      ]),
    );
    const result = await run("dashboard_read");
    expect(result.exists).toBe(true);
    expect((result.summary as string[])[0]).toContain("p-notes [notebook]");
    expect((result.summary as string[])[0]).toContain("pinned");
  });

  it("falls back to the default for an unreadable file and leaves it alone", async () => {
    fs.writeFileSync(dashPath, "{ not json", "utf-8");
    const result = await run("dashboard_read");
    expect(result.success).toBe(true);
    expect(result.exists).toBe(true);
    expect((result.problems as unknown[]).length).toBeGreaterThan(0);
    expect(fs.readFileSync(dashPath, "utf-8")).toBe("{ not json");
  });

  it("refuses when there is no analysis directory", async () => {
    setNotebookPath(null);
    const result = await run("dashboard_read");
    expect(result.success).toBe(false);
    expect(result.error).toContain("no notebook");
  });
});

describe("dashboard_update -- the happy paths", () => {
  it("adds a panel, stamps it as the agent's, and records why", async () => {
    const result = await run("dashboard_update", {
      reason: "you asked to watch the alignment run",
      actions: [{ action: "add_panel", widget: "jobs", span: 1, rows: 2 }],
    });
    expect(result.success).toBe(true);

    const panels = onDisk().dashboards[0].panels;
    const added = panels.find((p) => p.widget === "jobs" && p.addedBy === "agent");
    expect(added).toBeTruthy();
    expect(added!.reason).toBe("you asked to watch the alignment run");
    expect(added!.id).toBe("p-jobs-2"); // the preset already ships a p-jobs
  });

  it("honours position, so 'next to the plan' means next to the plan", async () => {
    seed(
      documentWith([{ id: "p-plan", widget: "plan", config: {}, layout: { span: 1, rows: 2 } }]),
    );
    await run("dashboard_update", {
      reason: "beside the plan, as asked",
      actions: [{ action: "add_panel", widget: "jobs", position: 0 }],
    });
    expect(onDisk().dashboards[0].panels.map((p) => p.widget)).toEqual(["jobs", "plan"]);
  });

  it("merges a config change rather than replacing the config", async () => {
    seed(
      documentWith([
        {
          id: "p-notebook",
          widget: "notebook",
          config: { follow: true, density: "compact" },
          layout: { span: 2, rows: 3 },
          addedBy: "preset",
        },
      ]),
    );
    await run("dashboard_update", {
      reason: "you asked it to stop scrolling",
      actions: [{ action: "update_panel", panelId: "p-notebook", config: '{"follow":false}' }],
    });
    expect(onDisk().dashboards[0].panels[0].config).toEqual({
      follow: false,
      density: "compact",
    });
  });

  it("creates a dashboard from a preset and switches to it", async () => {
    const result = await run("dashboard_update", {
      reason: "you asked for a monitoring view",
      actions: [
        { action: "create_dashboard", preset: "monitoring", title: "Long run" },
        { action: "switch_dashboard", dashboardId: "monitoring" },
      ],
    });
    expect(result.success).toBe(true);
    const document = onDisk();
    expect(document.activeId).toBe("monitoring");
    expect(document.dashboards.map((d) => d.id)).toEqual(["current-analysis", "monitoring"]);
  });

  it("replaces the whole layout when handed a document", async () => {
    const replacement = documentWith([
      { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 2, rows: 2 } },
    ]);
    const result = await run("dashboard_update", {
      reason: "you asked for just the jobs",
      document: JSON.stringify(replacement),
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.widget)).toEqual(["jobs"]);
  });

  it("removes and moves panels it put there itself", async () => {
    seed(
      documentWith([
        { id: "p-a", widget: "jobs", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
        { id: "p-b", widget: "plan", config: {}, layout: { span: 1, rows: 2 }, addedBy: "preset" },
        {
          id: "p-c",
          widget: "activity",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "agent",
        },
      ]),
    );
    const result = await run("dashboard_update", {
      reason: "you asked to tidy it up",
      actions: [
        { action: "remove_panel", panelId: "p-c" },
        { action: "move_panel", panelId: "p-a", position: 1 },
      ],
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-b", "p-a"]);
  });
});

describe("dashboard_update -- what it refuses", () => {
  it("needs a reason", async () => {
    const result = await run("dashboard_update", {
      reason: "  ",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reason is required");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses both actions and document at once, and neither", async () => {
    const both = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
      document: "{}",
    });
    expect(both.error).toContain("not both");
    const neither = await run("dashboard_update", { reason: "why" });
    expect(neither.error).toContain("pass actions or document");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("hands back the validator's problems when the document will not parse", async () => {
    const result = await run("dashboard_update", { reason: "why", document: "{ not json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not valid JSON");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses a document from a newer schema rather than downgrading it", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      document: JSON.stringify({ version: 99, activeId: "x", dashboards: [] }),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("newer than this build");
  });

  it("refuses a widget type this build cannot draw, and says what it can", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "volcano-plot" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("volcano-plot");
    expect(result.error).toContain("jobs");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses the sandboxed HTML widget while its flag is off", async () => {
    expect(sandboxWidgetEnabled()).toBe(false);
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "html-sandbox", config: '{"html":"<b>hi</b>"}' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("feature flag");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses a widget type smuggled in through the whole-document path", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      document: JSON.stringify(
        documentWith([
          { id: "p-x", widget: "html-sandbox", config: {}, layout: { span: 1, rows: 2 } },
        ]),
      ),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("feature flag");
  });

  it("names the unknown panel rather than guessing", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "remove_panel", panelId: "p-nope" }],
    });
    expect(result.error).toContain("p-nope");
    expect(result.error).toContain("dashboard_read");
  });

  it("rejects a layout larger than the file cap without writing anything", async () => {
    const big = documentWith([
      {
        id: "p-notebook",
        widget: "notebook",
        config: { blob: "x".repeat(DASHBOARD_MAX_BYTES + 1024) },
        layout: { span: 2, rows: 3 },
      },
    ]);
    const result = await run("dashboard_update", {
      reason: "why",
      document: JSON.stringify(big),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("larger than");
    expect(fs.existsSync(dashPath)).toBe(false);
  });
});

describe("provenance -- the panels that are not the agent's", () => {
  const userPanel = {
    id: "p-mine",
    widget: "notebook" as const,
    config: {},
    layout: { span: 1 as const, rows: 2 },
    addedBy: "user" as const,
  };
  const pinnedPanel = {
    id: "p-pinned",
    widget: "plan" as const,
    config: {},
    layout: { span: 1 as const, rows: 2 },
    addedBy: "preset" as const,
    pinned: true,
  };

  it("counts an unlabelled panel as the user's", () => {
    expect(
      isProtectedPanel({ id: "p", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } }),
    ).toBe(true);
    expect(isProtectedPanel({ ...userPanel })).toBe(true);
    expect(isProtectedPanel({ ...pinnedPanel })).toBe(true);
    expect(isProtectedPanel({ ...userPanel, addedBy: "agent", pinned: false })).toBe(false);
    expect(isProtectedPanel({ ...userPanel, addedBy: "preset", pinned: false })).toBe(false);
  });

  it("will not remove a panel the user placed", async () => {
    seed(documentWith([userPanel]));
    const before = fs.readFileSync(dashPath, "utf-8");
    const result = await run("dashboard_update", {
      reason: "tidying",
      actions: [{ action: "remove_panel", panelId: "p-mine" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("placed by the user");
    expect(result.error).toContain("dashboard's own controls");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(before);
  });

  it("will not resize or retitle a pinned panel", async () => {
    seed(documentWith([pinnedPanel]));
    const result = await run("dashboard_update", {
      reason: "making room",
      actions: [{ action: "update_panel", panelId: "p-pinned", rows: 5 }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("is pinned");
  });

  it("will not reorder the user's panels past each other", async () => {
    seed(documentWith([userPanel, { ...pinnedPanel, pinned: true }]));
    const result = await run("dashboard_update", {
      reason: "reshuffling",
      actions: [{ action: "move_panel", panelId: "p-mine", position: 1 }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reordering");
  });

  it("will not drop a user panel through a whole-document replace either", async () => {
    seed(documentWith([userPanel]));
    const result = await run("dashboard_update", {
      reason: "rebuilding",
      document: JSON.stringify(
        documentWith([{ id: "p-jobs", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } }]),
      ),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot be removed");
  });

  it("will not delete a dashboard that holds one", async () => {
    seed(documentWith([userPanel]));
    const result = await run("dashboard_update", {
      reason: "starting over",
      document: JSON.stringify({
        version: 1,
        activeId: "fresh",
        dashboards: [{ id: "fresh", title: "Fresh", panels: [] }],
      }),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot be removed");
  });

  it("still lets the agent add a panel beside them", async () => {
    seed(documentWith([userPanel]));
    const result = await run("dashboard_update", {
      reason: "you asked to see the jobs too",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-mine", "p-jobs"]);
  });

  it("sees no violation when nothing protected moved", () => {
    const before = documentWith([userPanel]);
    const after = documentWith([
      userPanel,
      { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
    ]);
    expect(provenanceViolations(before, after)).toEqual([]);
    expect(introducedWidgetTypes(before, after)).toEqual(["jobs"]);
  });
});

describe("the persisted path", () => {
  it("is the fixed filename beside the notebook", () => {
    expect(getDashboardPath()).toBe(path.join(tmpDir, DASHBOARD_FILENAME));
  });

  it("moves with the notebook and never outside its directory", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dashboard-other-"));
    try {
      setNotebookPath(path.join(other, "notebook.md"));
      expect(getDashboardPath()).toBe(path.join(other, DASHBOARD_FILENAME));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlink planted at that name", async () => {
    const outside = path.join(tmpDir, "secret.json");
    fs.writeFileSync(outside, "untouched", "utf-8");
    fs.symlinkSync(outside, dashPath);

    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("symbolic link");
    expect(fs.readFileSync(outside, "utf-8")).toBe("untouched");
  });

  it("refuses to read through one too", async () => {
    fs.writeFileSync(path.join(tmpDir, "secret.json"), "untouched", "utf-8");
    fs.symlinkSync(path.join(tmpDir, "secret.json"), dashPath);
    const result = await run("dashboard_read");
    expect(result.success).toBe(false);
    expect(result.error).toContain("symbolic link");
  });

  it("leaves no scratch files behind", async () => {
    await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("notes the change in the activity log", async () => {
    await run("dashboard_update", {
      reason: "you asked to watch the run",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    const lines = fs
      .readFileSync(path.join(tmpDir, "activity.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; source: string });
    expect(
      lines.some((e) => e.kind === "dashboard.changed" && e.source === "dashboard_update"),
    ).toBe(true);
  });

  it("retries against the file when someone else writes in the middle", async () => {
    seed(createDefaultDashboardDocument());
    let interfered = false;
    const attempts: number[] = [];

    const written = await updateDashboardDocument((current) => {
      attempts.push(current.dashboards[0].panels.length);
      if (!interfered) {
        interfered = true;
        // Another writer lands between our read and our rename.
        fs.writeFileSync(
          dashPath,
          serializeDashboardDocument(
            documentWith([
              {
                id: "p-theirs",
                widget: "plan",
                config: {},
                layout: { span: 1, rows: 2 },
                addedBy: "user",
              },
            ]),
          ),
          "utf-8",
        );
      }
      return { ok: true, document: current };
    });

    expect(written.ok).toBe(true);
    expect(attempts.length).toBe(2);
    // The second attempt saw the other writer's document, not the first read.
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-theirs"]);
  });
});

describe("shells", () => {
  it("says the pane will pick it up when a shell is attached", async () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.where).toContain("Dashboard tab");
  });

  it("writes the file and says there is no pane in the terminal", async () => {
    delete process.env.LOOM_SHELL_KIND;
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(true);
    expect(result.where).toContain("no dashboard pane in the terminal");
    expect(fs.existsSync(dashPath)).toBe(true);
  });
});

describe("applyDashboardActions on its own", () => {
  it("caps how much one call may do", () => {
    const actions = Array.from({ length: 21 }, () => ({ action: "add_panel", widget: "jobs" }));
    const result = applyDashboardActions(createDefaultDashboardDocument(), actions, "why");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("at most 20");
  });

  it("refuses an action it does not know", () => {
    const result = applyDashboardActions(
      createDefaultDashboardDocument(),
      [{ action: "delete_everything" }],
      "why",
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("unknown action");
  });

  it("does not mutate the document it was handed", () => {
    const document = createDefaultDashboardDocument();
    const before = JSON.stringify(document);
    applyDashboardActions(document, [{ action: "add_panel", widget: "jobs" }], "why");
    expect(JSON.stringify(document)).toBe(before);
  });
});
