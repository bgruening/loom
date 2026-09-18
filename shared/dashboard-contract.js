/**
 * Dashboard document contract -- shared by the renderer (which draws it), the
 * shells (which persist it) and, later, the brain (which may write one).
 *
 * A dashboard is data: a versioned JSON document of named dashboards, each an
 * ordered list of panels. Validation is total -- it never throws on untrusted
 * input, because this document can come off disk, out of an agent turn, or from
 * a build newer than the one reading it. Anything repairable is repaired and
 * reported; only three things are fatal (not an object, no usable version, a
 * version from the future).
 *
 * Unknown widget types are deliberately preserved. Dropping them would silently
 * delete panels every time an older build opened a newer layout.
 */

export const DASHBOARD_SCHEMA_VERSION = 1;

/** Per-analysis layout file, beside notebook.md in the working directory. */
export const DASHBOARD_FILENAME = ".loom-dashboard.json";

/** Refuse to persist anything larger. Layout, not a blob store. */
export const DASHBOARD_MAX_BYTES = 256 * 1024;

/**
 * Advisory list used to build presets and to give the brain a vocabulary. It is
 * deliberately not the set of renderable widgets -- the renderer's registry is
 * that, and it includes flag-gated widgets this list should not advertise.
 * Validation never consults either.
 */
export const KNOWN_WIDGET_TYPES = ["notebook", "jobs", "plan", "activity", "results"];

const DEFAULT_PRESET_ID = "overview";
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const DEFAULT_ROWS = 2;
const MAX_DASHBOARDS = 20;
const MAX_PANELS = 40;

export const DASHBOARD_PRESETS = [
  {
    id: "overview",
    label: "Overview",
    description: "The notebook, what Galaxy is running, and where the plan stands.",
    dashboard: {
      id: "overview",
      title: "Overview",
      panels: [
        {
          id: "p-notebook",
          widget: "notebook",
          config: { follow: true },
          layout: { span: 2, rows: 3 },
        },
        { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } },
        { id: "p-plan", widget: "plan", config: {}, layout: { span: 1, rows: 2 } },
      ],
    },
  },
  {
    id: "monitoring",
    label: "Monitoring",
    description: "For a long run: jobs, plan progress, and the analysis log.",
    dashboard: {
      id: "monitoring",
      title: "Monitoring",
      panels: [
        { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 2, rows: 2 } },
        { id: "p-plan", widget: "plan", config: {}, layout: { span: 1, rows: 3 } },
        { id: "p-activity", widget: "activity", config: {}, layout: { span: 1, rows: 3 } },
      ],
    },
  },
  {
    id: "results",
    label: "Results",
    description: "What the analysis produced, next to the notebook that explains it.",
    dashboard: {
      id: "results",
      title: "Results",
      panels: [
        { id: "p-results", widget: "results", config: {}, layout: { span: 2, rows: 3 } },
        {
          id: "p-notebook",
          widget: "notebook",
          config: { follow: false },
          layout: { span: 2, rows: 3 },
        },
      ],
    },
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function problem(path, message) {
  return { path, message };
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A fresh copy of a preset's dashboard, or null if there is no such preset. */
export function dashboardFromPreset(presetId) {
  const preset = DASHBOARD_PRESETS.find((p) => p.id === presetId);
  return preset ? clone(preset.dashboard) : null;
}

/** The document a workspace starts with: one dashboard, the overview preset. */
export function createDefaultDashboardDocument() {
  const dashboard = dashboardFromPreset(DEFAULT_PRESET_ID);
  return {
    version: DASHBOARD_SCHEMA_VERSION,
    activeId: dashboard.id,
    dashboards: [dashboard],
  };
}

export function serializeDashboardDocument(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

function normalizeLayout(raw, path, problems) {
  const layout = { span: 1, rows: DEFAULT_ROWS };
  if (raw === undefined) return layout;
  if (!isPlainObject(raw)) {
    problems.push(
      problem(path, `expected an object, got ${describe(raw)}; using the default size`),
    );
    return layout;
  }
  if (raw.span === 1 || raw.span === 2) {
    layout.span = raw.span;
  } else if (raw.span !== undefined) {
    problems.push(problem(`${path}.span`, "expected 1 or 2; using 1"));
  }
  if (typeof raw.rows === "number" && Number.isFinite(raw.rows)) {
    const rows = Math.round(raw.rows);
    layout.rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows));
    if (layout.rows !== rows) {
      problems.push(problem(`${path}.rows`, `clamped ${rows} to ${MIN_ROWS}..${MAX_ROWS}`));
    }
  } else if (raw.rows !== undefined) {
    problems.push(problem(`${path}.rows`, `expected a number; using ${DEFAULT_ROWS}`));
  }
  return layout;
}

function normalizePanel(raw, path, index, seenIds, problems) {
  if (!isPlainObject(raw)) {
    problems.push(problem(path, `expected an object, got ${describe(raw)}; dropped`));
    return null;
  }
  if (typeof raw.widget !== "string" || raw.widget.trim() === "") {
    problems.push(problem(`${path}.widget`, "missing a widget type; panel dropped"));
    return null;
  }

  let id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : "";
  if (!id) {
    id = `panel-${index + 1}`;
    problems.push(problem(`${path}.id`, `missing; using "${id}"`));
  }
  if (seenIds.has(id)) {
    let suffix = 2;
    while (seenIds.has(`${id}-${suffix}`)) suffix++;
    problems.push(problem(`${path}.id`, `"${id}" is already used; renamed to "${id}-${suffix}"`));
    id = `${id}-${suffix}`;
  }
  seenIds.add(id);

  const panel = {
    id,
    widget: raw.widget.trim(),
    config: {},
    layout: normalizeLayout(raw.layout, `${path}.layout`, problems),
  };
  if (typeof raw.title === "string" && raw.title.trim() !== "") {
    panel.title = raw.title.trim();
  } else if (raw.title !== undefined) {
    problems.push(problem(`${path}.title`, "expected a non-empty string; using the widget label"));
  }
  if (isPlainObject(raw.config)) {
    panel.config = clone(raw.config);
  } else if (raw.config !== undefined) {
    problems.push(problem(`${path}.config`, `expected an object, got ${describe(raw.config)}`));
  }
  return panel;
}

function normalizeDashboard(raw, path, index, seenIds, problems) {
  if (!isPlainObject(raw)) {
    problems.push(problem(path, `expected an object, got ${describe(raw)}; dropped`));
    return null;
  }

  let id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : "";
  if (!id) {
    id = `dashboard-${index + 1}`;
    problems.push(problem(`${path}.id`, `missing; using "${id}"`));
  }
  if (seenIds.has(id)) {
    let suffix = 2;
    while (seenIds.has(`${id}-${suffix}`)) suffix++;
    problems.push(problem(`${path}.id`, `"${id}" is already used; renamed to "${id}-${suffix}"`));
    id = `${id}-${suffix}`;
  }
  seenIds.add(id);

  let title = "Dashboard";
  if (typeof raw.title === "string" && raw.title.trim() !== "") {
    title = raw.title.trim();
  } else if (raw.title !== undefined) {
    problems.push(problem(`${path}.title`, 'expected a non-empty string; using "Dashboard"'));
  }

  let rawPanels = Array.isArray(raw.panels) ? raw.panels : [];
  if (!Array.isArray(raw.panels) && raw.panels !== undefined) {
    problems.push(problem(`${path}.panels`, `expected an array, got ${describe(raw.panels)}`));
  }
  if (rawPanels.length > MAX_PANELS) {
    problems.push(
      problem(`${path}.panels`, `${rawPanels.length} panels; keeping the first ${MAX_PANELS}`),
    );
    rawPanels = rawPanels.slice(0, MAX_PANELS);
  }

  const seenPanelIds = new Set();
  const panels = [];
  rawPanels.forEach((rawPanel, i) => {
    const panel = normalizePanel(rawPanel, `${path}.panels[${i}]`, i, seenPanelIds, problems);
    if (panel) panels.push(panel);
  });

  return { id, title, panels };
}

/**
 * Normalize an untrusted value into a dashboard document.
 *
 * `{ok: true}` carries the document plus every repair that was made.
 * `{ok: false}` means the input could not be repaired into anything meaningful:
 * it was not an object, it had no usable version, or its version is newer than
 * this build. Callers fall back to the default document and, per the design,
 * leave the file on disk alone.
 */
export function validateDashboardDocument(input) {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      problems: [problem("", `expected a dashboard document object, got ${describe(input)}`)],
    };
  }

  const version = input.version;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return {
      ok: false,
      problems: [problem("version", `expected a schema version, got ${describe(version)}`)],
    };
  }
  if (version > DASHBOARD_SCHEMA_VERSION) {
    return {
      ok: false,
      problems: [
        problem(
          "version",
          `schema version ${version} is newer than this build understands (${DASHBOARD_SCHEMA_VERSION})`,
        ),
      ],
    };
  }

  const problems = [];
  let rawDashboards = Array.isArray(input.dashboards) ? input.dashboards : [];
  if (!Array.isArray(input.dashboards)) {
    problems.push(problem("dashboards", `expected an array, got ${describe(input.dashboards)}`));
  }
  if (rawDashboards.length > MAX_DASHBOARDS) {
    problems.push(
      problem(
        "dashboards",
        `${rawDashboards.length} dashboards; keeping the first ${MAX_DASHBOARDS}`,
      ),
    );
    rawDashboards = rawDashboards.slice(0, MAX_DASHBOARDS);
  }

  const seenIds = new Set();
  const dashboards = [];
  rawDashboards.forEach((raw, i) => {
    const dashboard = normalizeDashboard(raw, `dashboards[${i}]`, i, seenIds, problems);
    if (dashboard) dashboards.push(dashboard);
  });

  if (dashboards.length === 0) {
    problems.push(problem("dashboards", "no usable dashboards; using the default"));
    dashboards.push(dashboardFromPreset(DEFAULT_PRESET_ID));
  }

  let activeId = typeof input.activeId === "string" ? input.activeId.trim() : "";
  if (!dashboards.some((d) => d.id === activeId)) {
    if (activeId) {
      problems.push(
        problem("activeId", `"${activeId}" is not in this document; using "${dashboards[0].id}"`),
      );
    }
    activeId = dashboards[0].id;
  }

  return {
    ok: true,
    document: { version: DASHBOARD_SCHEMA_VERSION, activeId, dashboards },
    problems,
  };
}

/** JSON text -> validated document. Same total-function guarantee. */
export function parseDashboardDocument(raw) {
  if (typeof raw !== "string") {
    return { ok: false, problems: [problem("", `expected JSON text, got ${describe(raw)}`)] };
  }
  if (raw.trim() === "") {
    return { ok: false, problems: [problem("", "empty")] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: [problem("", `not valid JSON: ${message}`)] };
  }
  return validateDashboardDocument(parsed);
}
