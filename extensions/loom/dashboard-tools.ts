/**
 * Dashboard tools -- how "show me my running jobs next to the plan" becomes a
 * layout.
 *
 * Two tools: one reads the layout document, one changes it. Both are
 * shell-neutral. The document is the same JSON the shells persist, validated by
 * the same `shared/dashboard-contract` validator, and writing it IS the
 * transport (see `dashboard-store.ts`) -- there is no separate widget message
 * for layout, and in the CLI the write simply happens with nothing attached to
 * read it.
 *
 * Two rules shape everything here, both from the curation design:
 *
 *   1. The agent changes the dashboard when the user asks, and never on its own
 *      initiative. That is stated in the tool description, where the model
 *      reads it.
 *   2. A panel the user placed or pinned is not the agent's to remove, move or
 *      rewrite. `provenanceViolations` enforces that on the finished document,
 *      so it holds for a wholesale replace exactly as it does for a patch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import {
  DASHBOARD_PRESETS,
  KNOWN_WIDGET_TYPES,
  dashboardFromPreset,
  parseDashboardDocument,
  validateDashboardDocument,
} from "../../shared/dashboard-contract.js";
import type {
  Dashboard,
  DashboardDocument,
  DashboardPanel,
  DashboardProblem,
} from "../../shared/dashboard-contract.js";
import { appendActivityEvent } from "./activity";
import { readDashboardDocument, updateDashboardDocument } from "./dashboard-store";

/** More than this in one call is a rewrite, and a rewrite should say so. */
const MAX_ACTIONS = 20;

/**
 * Whether the agent may create an `html-sandbox` panel.
 *
 * The sandboxed HTML widget is the one piece with a real security surface: the
 * content is written by the model, so a prompt-injected agent authors it. It
 * ships behind a flag, and no such flag exists yet, so there is nothing to
 * consult and nothing to trust -- creating one is refused outright. When the
 * widget lands, this is the single place to read its flag.
 */
export function sandboxWidgetEnabled(): boolean {
  return false;
}

/** Widget types the agent is allowed to create. */
function creatableWidgetTypes(): string[] {
  return KNOWN_WIDGET_TYPES.slice();
}

/**
 * The widget vocabulary the tool description advertises, derived from the
 * shared contract rather than typed out a second time: the types come from
 * `KNOWN_WIDGET_TYPES` and each one's example config from the first shipped
 * preset that uses it. Anything richer -- a human label, a description of what
 * a widget draws -- lives only in the renderer's registry, which the brain
 * cannot see.
 */
export function widgetCatalogLines(): string[] {
  const example = new Map<string, string>();
  for (const preset of DASHBOARD_PRESETS) {
    for (const panel of preset.dashboard.panels) {
      if (!example.has(panel.widget)) example.set(panel.widget, JSON.stringify(panel.config));
    }
  }
  return creatableWidgetTypes().map((type) => `${type} (config ${example.get(type) ?? "{}"})`);
}

/** The shipped presets, for the tool description and for `create_dashboard`. */
export function presetLines(): string[] {
  return DASHBOARD_PRESETS.map((preset) => `${preset.id} -- ${preset.description}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A panel the agent must leave alone.
 *
 * `pinned` is the user saying so outright. Absent provenance counts as the
 * user's too: the only panels that arrive without it are hand-written ones, and
 * treating an unlabelled panel as the agent's own would make a hand-edited
 * layout the one case where curation quietly deletes work.
 */
export function isProtectedPanel(panel: DashboardPanel): boolean {
  if (panel.pinned === true) return true;
  return panel.addedBy !== "agent" && panel.addedBy !== "preset";
}

/** Key-order-independent comparison, so a merged config is not a false change. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

function samePanel(a: DashboardPanel, b: DashboardPanel): boolean {
  return (
    a.widget === b.widget &&
    (a.title ?? "") === (b.title ?? "") &&
    a.layout.span === b.layout.span &&
    a.layout.rows === b.layout.rows &&
    a.pinned === b.pinned &&
    a.addedBy === b.addedBy &&
    stableJson(a.config) === stableJson(b.config)
  );
}

function reasonProtected(panel: DashboardPanel): string {
  if (panel.pinned === true) return "is pinned";
  return panel.addedBy === "user" ? "was placed by the user" : "was not added by the agent";
}

/**
 * What an agent-proposed document would do to panels that are not its to touch.
 *
 * Checked on the finished document rather than per action, so the wholesale
 * replace and the patch path get the same guarantee and a future action cannot
 * quietly escape it. Adding panels is always fine; curation appends.
 */
export function provenanceViolations(
  before: DashboardDocument,
  after: DashboardDocument,
): string[] {
  const violations: string[] = [];
  for (const dashboard of before.dashboards) {
    const protectedPanels = dashboard.panels.filter(isProtectedPanel);
    if (protectedPanels.length === 0) continue;

    const target = after.dashboards.find((d) => d.id === dashboard.id);
    if (!target) {
      violations.push(
        `dashboard "${dashboard.id}" holds ${protectedPanels.length} panel(s) the user placed or pinned, so it cannot be removed`,
      );
      continue;
    }

    for (const panel of protectedPanels) {
      const kept = target.panels.find((p) => p.id === panel.id);
      if (!kept) {
        violations.push(`panel "${panel.id}" ${reasonProtected(panel)}, so it cannot be removed`);
      } else if (!samePanel(panel, kept)) {
        violations.push(`panel "${panel.id}" ${reasonProtected(panel)}, so it cannot be changed`);
      }
    }

    // Relative order of the protected panels, compared as a subsequence: new
    // panels may land between them, but they may not be shuffled past each
    // other.
    const expected = protectedPanels
      .map((p) => p.id)
      .filter((id) => target.panels.some((p) => p.id === id));
    const actual = target.panels.map((p) => p.id).filter((id) => expected.includes(id));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      violations.push(
        `reordering the panels the user placed in "${dashboard.id}" is not the agent's to do`,
      );
    }
  }
  return violations;
}

/**
 * Widget types this change brings into the document: a panel id the dashboard
 * did not have, or one whose widget type changed. Panels already on disk are
 * left alone even when their type is unknown to this build, because that is how
 * a layout written by a newer build survives being opened by an older one.
 */
export function introducedWidgetTypes(
  before: DashboardDocument,
  after: DashboardDocument,
): string[] {
  const introduced = new Set<string>();
  for (const dashboard of after.dashboards) {
    const previous = before.dashboards.find((d) => d.id === dashboard.id);
    for (const panel of dashboard.panels) {
      const existing = previous?.panels.find((p) => p.id === panel.id);
      if (!existing || existing.widget !== panel.widget) introduced.add(panel.widget);
    }
  }
  return [...introduced];
}

/** Refuse a widget type the agent is not allowed to create. */
export function unsupportedWidgetMessage(type: string): string | null {
  if (creatableWidgetTypes().includes(type)) return null;
  if (type === "html-sandbox") {
    return sandboxWidgetEnabled()
      ? null
      : 'The "html-sandbox" custom view is behind a feature flag that is not on in this build, so it cannot be added.';
  }
  return `"${type}" is not a widget this build can draw. Available: ${creatableWidgetTypes().join(", ")}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export type DashboardAction = {
  action: string;
  dashboardId?: string;
  panelId?: string;
  widget?: string;
  title?: string;
  config?: string;
  span?: number;
  rows?: number;
  position?: number;
  preset?: string;
};

export type ApplyResult =
  { ok: true; document: DashboardDocument; notes: string[] } | { ok: false; error: string };

function fail(error: string): ApplyResult {
  return { ok: false, error };
}

function cloneDocument(document: DashboardDocument): DashboardDocument {
  return JSON.parse(JSON.stringify(document)) as DashboardDocument;
}

function findDashboard(document: DashboardDocument, id: string | undefined): Dashboard | null {
  const wanted = (id ?? document.activeId).trim();
  return document.dashboards.find((d) => d.id === wanted) ?? null;
}

function dashboardIds(document: DashboardDocument): string {
  return document.dashboards.map((d) => d.id).join(", ");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniquePanelId(dashboard: Dashboard, base: string): string {
  const slug = slugify(base) || "panel";
  if (!dashboard.panels.some((p) => p.id === `p-${slug}`)) return `p-${slug}`;
  let n = 2;
  while (dashboard.panels.some((p) => p.id === `p-${slug}-${n}`)) n++;
  return `p-${slug}-${n}`;
}

function uniqueDashboardId(document: DashboardDocument, base: string): string {
  const slug = slugify(base) || "dashboard";
  if (!document.dashboards.some((d) => d.id === slug)) return slug;
  let n = 2;
  while (document.dashboards.some((d) => d.id === `${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

type ParsedConfig = { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

function parseConfig(raw: string | undefined): ParsedConfig {
  if (raw === undefined || raw.trim() === "") return { ok: true, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'config must be a JSON object, e.g. {"follow":false}' };
  }
  return { ok: true, config: parsed as Record<string, unknown> };
}

function clampRows(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) return 2;
  return Math.min(6, Math.max(1, Math.round(rows)));
}

function clampPosition(position: number | undefined, length: number): number {
  if (position === undefined || !Number.isFinite(position)) return length;
  return Math.min(length, Math.max(0, Math.round(position)));
}

type Located = { dashboard: Dashboard; panel: DashboardPanel; index: number } | { error: string };

function locatePanel(document: DashboardDocument, action: DashboardAction): Located {
  const panelId = (action.panelId ?? "").trim();
  if (!panelId) return { error: `${action.action} needs a panelId.` };
  const wanted = action.dashboardId?.trim();
  const scoped = wanted ? document.dashboards.filter((d) => d.id === wanted) : document.dashboards;
  if (wanted && scoped.length === 0) {
    return { error: `no dashboard "${wanted}". Have: ${dashboardIds(document)}.` };
  }
  for (const dashboard of scoped) {
    const index = dashboard.panels.findIndex((p) => p.id === panelId);
    if (index >= 0) return { dashboard, panel: dashboard.panels[index], index };
  }
  return { error: `no panel "${panelId}". Call dashboard_read to see the panel ids.` };
}

/**
 * Apply the agent's actions to a copy of the document.
 *
 * Nothing here enforces provenance or the widget allowlist; both are checked
 * against the finished document by the caller, so the patch path and the
 * wholesale-replace path cannot diverge.
 */
export function applyDashboardActions(
  document: DashboardDocument,
  actions: DashboardAction[],
  reason: string,
): ApplyResult {
  if (actions.length === 0) return fail("No actions given.");
  if (actions.length > MAX_ACTIONS) {
    return fail(`${actions.length} actions in one call; at most ${MAX_ACTIONS}.`);
  }

  const next = cloneDocument(document);
  const notes: string[] = [];

  for (const [index, action] of actions.entries()) {
    const at = `actions[${index}]`;
    switch (action.action) {
      case "add_panel": {
        const dashboard = findDashboard(next, action.dashboardId);
        if (!dashboard) {
          return fail(`${at}: no dashboard "${action.dashboardId}". Have: ${dashboardIds(next)}.`);
        }
        const widget = (action.widget ?? "").trim();
        if (!widget) return fail(`${at}: add_panel needs a widget type.`);
        const config = parseConfig(action.config);
        if (!config.ok) return fail(`${at}: ${config.error}`);
        const panel: DashboardPanel = {
          id: uniquePanelId(dashboard, widget),
          widget,
          config: config.config,
          layout: { span: action.span === 2 ? 2 : 1, rows: clampRows(action.rows) },
          addedBy: "agent",
          reason,
        };
        if (action.title && action.title.trim()) panel.title = action.title.trim();
        const insertAt = clampPosition(action.position, dashboard.panels.length);
        dashboard.panels.splice(insertAt, 0, panel);
        notes.push(`added ${widget} as "${panel.id}" in "${dashboard.id}"`);
        break;
      }

      case "remove_panel": {
        const found = locatePanel(next, action);
        if ("error" in found) return fail(`${at}: ${found.error}`);
        found.dashboard.panels.splice(found.index, 1);
        notes.push(`removed "${found.panel.id}" from "${found.dashboard.id}"`);
        break;
      }

      case "update_panel": {
        const found = locatePanel(next, action);
        if ("error" in found) return fail(`${at}: ${found.error}`);
        const panel = found.panel;
        if (action.widget && action.widget.trim()) panel.widget = action.widget.trim();
        if (action.title !== undefined) {
          const title = action.title.trim();
          if (title) panel.title = title;
          else delete panel.title;
        }
        if (action.config !== undefined) {
          const config = parseConfig(action.config);
          if (!config.ok) return fail(`${at}: ${config.error}`);
          // Merge: a model changing one setting should not silently drop the
          // rest of a panel's config.
          panel.config = { ...panel.config, ...config.config };
        }
        if (action.span !== undefined) panel.layout.span = action.span === 2 ? 2 : 1;
        if (action.rows !== undefined) panel.layout.rows = clampRows(action.rows);
        panel.reason = reason;
        notes.push(`updated "${panel.id}" in "${found.dashboard.id}"`);
        break;
      }

      case "move_panel": {
        const found = locatePanel(next, action);
        if ("error" in found) return fail(`${at}: ${found.error}`);
        if (action.position === undefined) return fail(`${at}: move_panel needs a position.`);
        const [panel] = found.dashboard.panels.splice(found.index, 1);
        const to = clampPosition(action.position, found.dashboard.panels.length);
        found.dashboard.panels.splice(to, 0, panel);
        notes.push(`moved "${panel.id}" to position ${to} in "${found.dashboard.id}"`);
        break;
      }

      case "create_dashboard": {
        const fromPreset = action.preset?.trim();
        let dashboard: Dashboard;
        if (fromPreset) {
          const preset = dashboardFromPreset(fromPreset);
          if (!preset) {
            return fail(
              `${at}: no preset "${fromPreset}". Have: ${DASHBOARD_PRESETS.map((p) => p.id).join(", ")}.`,
            );
          }
          dashboard = preset;
        } else {
          dashboard = { id: "", title: "", panels: [] };
        }
        const title = (action.title ?? dashboard.title ?? "").trim();
        if (!title) return fail(`${at}: create_dashboard needs a title or a preset.`);
        dashboard.title = title;
        dashboard.id = uniqueDashboardId(next, action.dashboardId ?? fromPreset ?? title);
        next.dashboards.push(dashboard);
        notes.push(`created dashboard "${dashboard.id}"`);
        break;
      }

      case "switch_dashboard": {
        const dashboard = findDashboard(next, action.dashboardId);
        if (!dashboard) {
          return fail(`${at}: no dashboard "${action.dashboardId}". Have: ${dashboardIds(next)}.`);
        }
        next.activeId = dashboard.id;
        notes.push(`showing "${dashboard.id}"`);
        break;
      }

      default:
        return fail(
          `${at}: unknown action "${action.action}". Use add_panel, remove_panel, update_panel, move_panel, create_dashboard or switch_dashboard.`,
        );
    }
  }

  return { ok: true, document: next, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// The write, end to end
// ─────────────────────────────────────────────────────────────────────────────

export type CommitOutcome =
  | {
      ok: true;
      document: DashboardDocument;
      problems: DashboardProblem[];
      notes: string[];
      path: string;
    }
  | { ok: false; error: string; problems?: DashboardProblem[] };

type Refusal = { error: string; problems?: DashboardProblem[] };

/**
 * Validate the candidate, check it against what it is replacing, and persist it.
 *
 * Shared by the tool's patch path, the tool's replace path and the parts of
 * `/dashboard` that write, so every one of them gets the same refusals. The
 * checks run inside the store's compare-and-swap callback, so they are made
 * against the document as it is on disk at the moment of the write, not against
 * a copy read earlier.
 */
export async function commitDashboardChange(
  build: (current: DashboardDocument, exists: boolean) => ApplyResult,
  options: { enforceProvenance?: boolean } = {},
): Promise<CommitOutcome> {
  const enforce = options.enforceProvenance !== false;
  // A holder rather than plain locals: the callback below runs inside the
  // store's retry loop, and what it learns has to survive back out here.
  const seen: { problems: DashboardProblem[]; notes: string[]; refusal: Refusal | null } = {
    problems: [],
    notes: [],
    refusal: null,
  };

  const written = await updateDashboardDocument((current, exists) => {
    seen.problems = [];
    seen.notes = [];
    seen.refusal = null;

    const built = build(current, exists);
    if (!built.ok) {
      seen.refusal = { error: built.error };
      return { ok: false, error: built.error };
    }

    const validated = validateDashboardDocument(built.document);
    if (!validated.ok) {
      seen.refusal = {
        error: "That layout is not a valid dashboard document.",
        problems: validated.problems,
      };
      return { ok: false, error: seen.refusal.error };
    }
    seen.problems = validated.problems;
    seen.notes = built.notes;

    if (enforce) {
      for (const type of introducedWidgetTypes(current, validated.document)) {
        const message = unsupportedWidgetMessage(type);
        if (message) {
          seen.refusal = { error: `${message} Nothing was changed.` };
          return { ok: false, error: seen.refusal.error };
        }
      }

      const violations = provenanceViolations(current, validated.document);
      if (violations.length > 0) {
        seen.refusal = {
          error: `Nothing was changed: ${violations.join("; ")}. Ask the user to make that change in the dashboard's own controls.`,
        };
        return { ok: false, error: seen.refusal.error };
      }
    }

    return { ok: true, document: validated.document };
  });

  if (!written.ok) {
    return seen.refusal
      ? { ok: false, error: seen.refusal.error, problems: seen.refusal.problems }
      : { ok: false, error: written.error };
  }
  return {
    ok: true,
    document: written.document,
    problems: seen.problems,
    notes: seen.notes,
    path: written.path,
  };
}

/** One line per dashboard, for a tool result or a slash command. */
export function summarizeDocument(document: DashboardDocument): string[] {
  return document.dashboards.map((dashboard) => {
    const mark = dashboard.id === document.activeId ? "* " : "  ";
    const panels = dashboard.panels.length
      ? dashboard.panels.map(describePanel).join(", ")
      : "no panels";
    return `${mark}${dashboard.id} (${dashboard.title}): ${panels}`;
  });
}

function describePanel(panel: DashboardPanel): string {
  const marks: string[] = [];
  if (panel.pinned) marks.push("pinned");
  if (panel.addedBy && panel.addedBy !== "preset") marks.push(`added by ${panel.addedBy}`);
  return `${panel.id} [${panel.widget}]${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

/** True when a shell with a dashboard pane is attached. */
function hasPane(): boolean {
  return process.env.LOOM_SHELL_KIND === "orbit";
}

/** Where the change landed, said in one line, honestly, in either shell. */
export function landedLine(): string {
  return hasPane()
    ? "The Dashboard tab picks this up within a few seconds."
    : "There is no dashboard pane in the terminal; the layout file is updated and the next Orbit session will show it.";
}

/**
 * Note the change in the activity log. The only durable trace that the agent,
 * rather than the user, rearranged what they are looking at.
 */
export function logDashboardChange(filePath: string, notes: string[], source: string): void {
  try {
    appendActivityEvent(path.dirname(filePath), {
      timestamp: new Date().toISOString(),
      kind: "dashboard.changed",
      source,
      payload: { changes: notes },
    });
  } catch {
    // The layout is written; failing to note it is not worth failing the call.
  }
}

export function countPanels(document: DashboardDocument): number {
  return document.dashboards.reduce((total, d) => total + d.panels.length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

const UPDATE_DESCRIPTION = [
  "Change the analysis dashboard: the panels the user sees beside the chat.",
  "",
  "Only when the user asks. Do not add, remove or rearrange panels on your own",
  "initiative -- not to be helpful, not because a run started, not because you",
  "think another view would suit them better. A panel the user placed or pinned",
  "is refused outright; ask them to change that one in the dashboard's own controls.",
  "",
  "Call dashboard_read first so you use the real panel ids. Pass EITHER `actions`",
  "(add_panel, remove_panel, update_panel, move_panel, create_dashboard,",
  "switch_dashboard) or `document` (the whole layout as JSON text), never both.",
  "`reason` is required and is recorded on every panel you add or change, so the",
  'user can see why it is there -- name the fact, e.g. "you asked to watch the',
  'alignment run".',
  "",
  `Widget types: ${widgetCatalogLines().join("; ")}.`,
  `Presets for create_dashboard: ${presetLines().join("; ")}.`,
  "Panels sit in a two-column grid: span is 1 or 2 columns, rows is 1-6 height",
  "units, position is the index within the dashboard (omit it to append).",
].join("\n");

const ActionSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("add_panel"),
      Type.Literal("remove_panel"),
      Type.Literal("update_panel"),
      Type.Literal("move_panel"),
      Type.Literal("create_dashboard"),
      Type.Literal("switch_dashboard"),
    ],
    { description: "What to do." },
  ),
  dashboardId: Type.Optional(
    Type.String({ description: "Which dashboard. Defaults to the one on screen." }),
  ),
  panelId: Type.Optional(
    Type.String({ description: "Panel to act on, for remove_panel/update_panel/move_panel." }),
  ),
  widget: Type.Optional(Type.String({ description: "Widget type, for add_panel." })),
  title: Type.Optional(
    Type.String({ description: "Panel or dashboard title. Omit to use the widget's own label." }),
  ),
  config: Type.Optional(
    Type.String({
      description:
        'Widget config as a JSON object in a string, e.g. {"follow":false}. On update_panel it is merged into the panel\'s existing config.',
    }),
  ),
  span: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, description: "Columns: 1 or 2." })),
  rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Height units: 1-6." })),
  position: Type.Optional(
    Type.Integer({ minimum: 0, description: "Index within the dashboard. Omit to append." }),
  ),
  preset: Type.Optional(
    Type.String({ description: "Preset id to build a new dashboard from, for create_dashboard." }),
  ),
});

function toolFailure(error: string, problems?: DashboardProblem[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: false, error, ...(problems ? { problems } : {}) }, null, 2),
      },
    ],
    details: { error: true } as Record<string, unknown>,
  };
}

export function registerDashboardTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dashboard_read",
    label: "Read Dashboard Layout",
    description:
      "Read the analysis dashboard: the named dashboards, their panels, which one is on screen " +
      "and who put each panel there. Call this before dashboard_update so you change panels by " +
      "their real ids.",
    parameters: Type.Object({}),
    async execute() {
      const read = await readDashboardDocument();
      if (!read.ok) return toolFailure(read.error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                exists: read.exists,
                document: read.document,
                summary: summarizeDocument(read.document),
                widgetTypes: widgetCatalogLines(),
                presets: presetLines(),
                ...(read.problems.length ? { problems: read.problems } : {}),
                ...(read.exists
                  ? {}
                  : { note: "No layout file yet; this is the default the user sees." }),
              },
              null,
              2,
            ),
          },
        ],
        details: { panels: countPanels(read.document) },
      };
    },
    renderResult: (result) => {
      const d = result.details as { panels?: number; error?: boolean } | undefined;
      if (d?.error) return new Text("Could not read the dashboard");
      return new Text(`Dashboard: ${d?.panels ?? 0} panel(s)`);
    },
  });

  pi.registerTool({
    name: "dashboard_update",
    label: "Update Dashboard Layout",
    description: UPDATE_DESCRIPTION,
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        description:
          "Why this change, in the user's terms. Recorded on every panel you add or change.",
      }),
      actions: Type.Optional(
        Type.Array(ActionSchema, {
          minItems: 1,
          maxItems: MAX_ACTIONS,
          description: "The changes to make, applied in order.",
        }),
      ),
      document: Type.Optional(
        Type.String({
          description:
            "The whole layout as JSON text, replacing what is there. Use actions instead unless the user asked for a wholesale rebuild.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const reason = (params.reason ?? "").trim();
      const actions = (params.actions ?? []) as DashboardAction[];
      const documentText = params.document;

      if (!reason) return toolFailure("reason is required: say why the user wants this change.");
      if (actions.length > 0 && documentText !== undefined) {
        return toolFailure("Pass either actions or document, not both.");
      }
      if (actions.length === 0 && documentText === undefined) {
        return toolFailure("Nothing to do: pass actions or document.");
      }

      const outcome = await commitDashboardChange((current) => {
        if (documentText !== undefined) {
          const parsed = parseDashboardDocument(documentText);
          if (!parsed.ok) {
            return {
              ok: false,
              error: `document could not be read: ${parsed.problems
                .map((p) => `${p.path || "document"}: ${p.message}`)
                .join("; ")}`,
            };
          }
          return { ok: true, document: parsed.document, notes: ["replaced the whole layout"] };
        }
        return applyDashboardActions(current, actions, reason);
      });

      if (!outcome.ok) return toolFailure(outcome.error, outcome.problems);

      logDashboardChange(outcome.path, outcome.notes, "dashboard_update");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                changes: outcome.notes,
                summary: summarizeDocument(outcome.document),
                where: landedLine(),
                undo: "The user can put this back with /dashboard undo.",
                ...(outcome.problems.length ? { repairs: outcome.problems } : {}),
              },
              null,
              2,
            ),
          },
        ],
        details: { changes: outcome.notes.length },
      };
    },
    renderResult: (result) => {
      const d = result.details as { changes?: number; error?: boolean } | undefined;
      if (d?.error) return new Text("Dashboard unchanged");
      return new Text(`Dashboard updated (${d?.changes ?? 0} change(s))`);
    },
  });
}
