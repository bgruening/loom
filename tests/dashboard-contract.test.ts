import { describe, expect, it } from "vitest";
import {
  DASHBOARD_FILENAME,
  DASHBOARD_PRESETS,
  DASHBOARD_SCHEMA_VERSION,
  createDefaultDashboardDocument,
  dashboardFromPreset,
  parseDashboardDocument,
  serializeDashboardDocument,
  validateDashboardDocument,
} from "../shared/dashboard-contract.js";
import type { DashboardDocument } from "../shared/dashboard-contract.js";

function expectOk(result: ReturnType<typeof validateDashboardDocument>): DashboardDocument {
  if (!result.ok) throw new Error(`expected ok, got problems: ${JSON.stringify(result.problems)}`);
  return result.document;
}

describe("presets", () => {
  it("names the layout file next to the notebook", () => {
    expect(DASHBOARD_FILENAME).toBe(".loom-dashboard.json");
  });

  it("ships a current-analysis preset of notebook + jobs + plan", () => {
    const preset = dashboardFromPreset("current-analysis");
    expect(preset?.panels.map((p) => p.widget)).toEqual(["notebook", "jobs", "plan"]);
  });

  it("marks preset panels as coming from a preset", () => {
    const preset = dashboardFromPreset("current-analysis")!;
    expect(preset.panels.every((p) => p.addedBy === "preset")).toBe(true);
  });

  it("hands out copies, so a caller cannot mutate the preset", () => {
    const first = dashboardFromPreset("current-analysis")!;
    first.panels.pop();
    expect(dashboardFromPreset("current-analysis")!.panels).toHaveLength(3);
  });

  it("returns null for a preset that does not exist", () => {
    expect(dashboardFromPreset("nope")).toBeNull();
  });

  it("validates every shipped preset without repairs", () => {
    for (const preset of DASHBOARD_PRESETS) {
      const result = validateDashboardDocument({
        version: DASHBOARD_SCHEMA_VERSION,
        activeId: preset.dashboard.id,
        dashboards: [preset.dashboard],
      });
      expect(result.ok, preset.id).toBe(true);
      expect(result.problems, preset.id).toEqual([]);
    }
  });
});

describe("createDefaultDashboardDocument", () => {
  it("round-trips through serialize + parse unchanged", () => {
    const doc = createDefaultDashboardDocument();
    const parsed = expectOk(parseDashboardDocument(serializeDashboardDocument(doc)));
    expect(parsed).toEqual(doc);
  });

  it("points activeId at a dashboard that exists", () => {
    const doc = createDefaultDashboardDocument();
    expect(doc.dashboards.some((d) => d.id === doc.activeId)).toBe(true);
  });
});

describe("validateDashboardDocument -- fatal input", () => {
  it.each([
    ["null", null],
    ["a string", "hello"],
    ["an array", []],
    ["a number", 7],
    ["undefined", undefined],
  ])("rejects %s without throwing", (_label, input) => {
    const result = validateDashboardDocument(input);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("rejects a missing version rather than assuming v1", () => {
    const result = validateDashboardDocument({ dashboards: [] });
    expect(result.ok).toBe(false);
    expect(result.problems[0].path).toBe("version");
  });

  it("refuses a document from a newer build and says so", () => {
    const result = validateDashboardDocument({
      version: DASHBOARD_SCHEMA_VERSION + 1,
      activeId: "a",
      dashboards: [],
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("newer than this build");
  });
});

describe("validateDashboardDocument -- repairs", () => {
  it("keeps an unknown widget type instead of dropping the panel", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ id: "p", widget: "widget-from-the-future", config: {} }],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0].widget).toBe("widget-from-the-future");
  });

  it("drops a panel with no widget type and reports it", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: "d",
      dashboards: [{ id: "d", title: "D", panels: [{ id: "p" }, { id: "q", widget: "jobs" }] }],
    });
    const doc = expectOk(result);
    expect(doc.dashboards[0].panels.map((p) => p.id)).toEqual(["q"]);
    expect(result.problems.some((p) => p.path === "dashboards[0].panels[0].widget")).toBe(true);
  });

  it("renames duplicate panel ids rather than losing one", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [
              { id: "p", widget: "jobs" },
              { id: "p", widget: "plan" },
            ],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels.map((p) => p.id)).toEqual(["p", "p-2"]);
  });

  it("clamps an out-of-range row count and a bad span", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ id: "p", widget: "jobs", layout: { span: 9, rows: 99 } }],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0].layout).toEqual({ span: 1, rows: 6 });
  });

  it("replaces a non-object config with an empty one", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [{ id: "d", title: "D", panels: [{ id: "p", widget: "jobs", config: 5 }] }],
      }),
    );
    expect(doc.dashboards[0].panels[0].config).toEqual({});
  });

  it("falls back to the default dashboard when none survive", () => {
    const result = validateDashboardDocument({ version: 1, activeId: "x", dashboards: ["junk"] });
    const doc = expectOk(result);
    expect(doc.dashboards).toHaveLength(1);
    expect(doc.dashboards[0].id).toBe("current-analysis");
    expect(doc.activeId).toBe("current-analysis");
  });

  it("re-points an activeId that names no dashboard", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: "gone",
      dashboards: [{ id: "here", title: "Here", panels: [] }],
    });
    const doc = expectOk(result);
    expect(doc.activeId).toBe("here");
    expect(result.problems.some((p) => p.path === "activeId")).toBe(true);
  });

  it("does not mutate the caller's input", () => {
    const input = {
      version: 1,
      activeId: "d",
      dashboards: [
        { id: "d", title: "D", panels: [{ id: "p", widget: "jobs", config: { a: 1 } }] },
      ],
    };
    const before = JSON.stringify(input);
    const doc = expectOk(validateDashboardDocument(input));
    doc.dashboards[0].panels[0].config.a = 2;
    expect(JSON.stringify(input)).toBe(before);
  });

  it("preserves panel provenance so agent curation needs no migration later", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [
              {
                id: "p",
                widget: "jobs",
                addedBy: "agent",
                reason: "you asked about the bwa run",
                pinned: true,
              },
            ],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0]).toMatchObject({
      addedBy: "agent",
      reason: "you asked about the bwa run",
      pinned: true,
    });
  });

  it("drops provenance it cannot trust rather than passing it through", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: "d",
      dashboards: [
        {
          id: "d",
          title: "D",
          panels: [{ id: "p", widget: "jobs", addedBy: "root", pinned: "yes", reason: 3 }],
        },
      ],
    });
    const panel = expectOk(result).dashboards[0].panels[0];
    expect(panel.addedBy).toBeUndefined();
    expect(panel.pinned).toBeUndefined();
    expect(panel.reason).toBeUndefined();
    expect(result.problems.map((p) => p.path)).toEqual(
      expect.arrayContaining([
        "dashboards[0].panels[0].addedBy",
        "dashboards[0].panels[0].reason",
        "dashboards[0].panels[0].pinned",
      ]),
    );
  });

  it("caps an over-long provenance reason", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ id: "p", widget: "jobs", reason: "z".repeat(1000) }],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0].reason).toHaveLength(280);
  });

  it("caps a pathological panel count", () => {
    const panels = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, widget: "jobs" }));
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [{ id: "d", title: "D", panels }],
      }),
    );
    expect(doc.dashboards[0].panels).toHaveLength(40);
  });
});

describe("parseDashboardDocument", () => {
  it("reports malformed JSON instead of throwing", () => {
    const result = parseDashboardDocument("{ not json");
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("not valid JSON");
  });

  it("treats an empty file as empty, not as corruption", () => {
    const result = parseDashboardDocument("   ");
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toBe("empty");
  });

  it("rejects a non-string without throwing", () => {
    expect(parseDashboardDocument(null).ok).toBe(false);
    expect(parseDashboardDocument({ version: 1 }).ok).toBe(false);
  });
});
