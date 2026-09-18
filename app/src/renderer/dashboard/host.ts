/**
 * Renders a dashboard document into a CSS grid and owns the widget lifecycle.
 *
 * Three things this file exists to guarantee:
 *  - one widget throwing never takes the dashboard down; it is replaced by an
 *    error card in its own panel and everything else keeps updating;
 *  - a widget type this build does not know about draws a placeholder rather
 *    than disappearing, so a layout from a newer build survives a round trip;
 *  - the editor can add its whole UX through `editor.ts` and the two header
 *    slots without anyone editing this file.
 *
 * Every string that comes out of the document reaches the DOM through
 * `textContent`. The document is untrusted -- it can be hand-edited or written
 * by a model.
 */

import {
  createDefaultDashboardDocument,
  validateDashboardDocument,
} from "../../../../shared/dashboard-contract.js";
import type {
  Dashboard,
  DashboardDocument,
  DashboardPanel,
  DashboardProblem,
} from "../../../../shared/dashboard-contract.js";
import { widgetRegistry, type WidgetRegistry } from "./registry.js";
import { dashboardEditor } from "./editor.js";
import type {
  DashboardDataSources,
  DashboardEditorContext,
  DashboardHostApi,
  DataSource,
  WidgetContext,
  WidgetDefinition,
  WidgetDispose,
  Unsubscribe,
} from "./widget-api.js";

export interface DashboardHostOptions {
  sources: DashboardDataSources;
  registry?: WidgetRegistry;
  /** Called with the serialized document whenever a change should be saved. */
  persist?: (document: DashboardDocument) => void;
}

/** How many times one render may be restarted by a widget reconfiguring itself. */
const MAX_RENDER_PASSES = 3;

interface MountedPanel {
  panel: DashboardPanel;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function messageFor(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class DashboardHost implements DashboardHostApi {
  private document: DashboardDocument = createDefaultDashboardDocument();
  private registry: WidgetRegistry;
  private sources: DashboardDataSources;
  private persist?: (document: DashboardDocument) => void;

  private bannerEl: HTMLElement;
  private toolbarEl: HTMLElement;
  private gridEl: HTMLElement;
  private mounted: MountedPanel[] = [];
  private editorCtx: DashboardEditorContext | null = null;
  private rendering = false;
  private renderQueued = false;

  constructor(
    private root: HTMLElement,
    opts: DashboardHostOptions,
  ) {
    this.sources = opts.sources;
    this.registry = opts.registry ?? widgetRegistry;
    this.persist = opts.persist;

    this.root.classList.add("dash-root");
    this.root.textContent = "";
    this.bannerEl = el("div", "dash-banner hidden");
    this.bannerEl.setAttribute("role", "status");
    this.toolbarEl = el("div", "dash-toolbar");
    this.gridEl = el("div", "dash-grid");
    this.root.append(this.bannerEl, this.toolbarEl, this.gridEl);

    if (dashboardEditor) {
      this.editorCtx = { host: this, toolbar: this.toolbarEl };
      try {
        dashboardEditor.attach(this.editorCtx);
      } catch (err) {
        console.error("[dashboard] editor attach failed:", err);
        this.editorCtx = null;
      }
    }

    this.render();
  }

  // ── DashboardHostApi ───────────────────────────────────────────────────────

  getDocument(): DashboardDocument {
    return JSON.parse(JSON.stringify(this.document)) as DashboardDocument;
  }

  /**
   * Validate, adopt, re-render and (by default) persist. Returns the repairs
   * validation made, or the fatal problems -- in which case nothing changed.
   */
  setDocument(next: DashboardDocument, opts: { persist?: boolean } = {}): DashboardProblem[] {
    const result = validateDashboardDocument(next);
    if (!result.ok) {
      console.error("[dashboard] refusing an invalid document:", result.problems);
      return result.problems;
    }
    this.document = result.document;
    this.render();
    if (opts.persist !== false) this.persist?.(this.getDocument());
    return result.problems;
  }

  getActiveDashboard(): Dashboard | null {
    return this.document.dashboards.find((d) => d.id === this.document.activeId) ?? null;
  }

  setActiveDashboardId(id: string): void {
    if (!this.document.dashboards.some((d) => d.id === id)) return;
    if (this.document.activeId === id) return;
    this.setDocument({ ...this.getDocument(), activeId: id });
  }

  listWidgets(): WidgetDefinition[] {
    return this.registry.list();
  }

  // ── Banner ────────────────────────────────────────────────────────────────

  /** A one-line note above the grid. Empty text hides it. */
  setBanner(text: string): void {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.toggle("hidden", text === "");
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * A widget is allowed to call `ctx.setConfig` from inside its own `mount`,
   * which re-enters here while the grid is half-built. Running that nested
   * render would clear the grid under the outer loop and leave duplicate
   * panels behind, so queue it and drain after. The pass cap stops a widget
   * that reconfigures itself on every mount from spinning forever.
   */
  render(): void {
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;
    try {
      let passes = 0;
      do {
        this.renderQueued = false;
        this.renderOnce();
        passes++;
      } while (this.renderQueued && passes < MAX_RENDER_PASSES);
      if (this.renderQueued) {
        console.error(
          "[dashboard] a widget keeps reconfiguring itself on mount; stopped redrawing",
        );
      }
    } finally {
      this.rendering = false;
      this.renderQueued = false;
    }
  }

  private renderOnce(): void {
    this.disposePanels();
    this.gridEl.textContent = "";

    const dashboard = this.getActiveDashboard();
    if (!dashboard || dashboard.panels.length === 0) {
      const empty = el("div", "empty-state");
      empty.append(
        el(
          "p",
          undefined,
          "This dashboard has no panels yet. Add one, pick a preset, or ask the agent for the view you want.",
        ),
      );
      this.gridEl.append(empty);
      return;
    }

    for (const panel of dashboard.panels) {
      this.gridEl.append(this.renderPanel(panel));
    }
  }

  private renderPanel(panel: DashboardPanel): HTMLElement {
    const def = this.registry.get(panel.widget);

    const section = el("section", "dash-panel");
    section.dataset.panelId = panel.id;
    section.dataset.widget = panel.widget;
    section.style.gridColumn = `span ${panel.layout.span}`;
    section.style.setProperty("--dash-panel-rows", String(panel.layout.rows));

    const head = el("header", "dash-panel-head");
    const title = el("span", "dash-panel-title", panel.title ?? def?.label ?? panel.widget);
    const actions = el("div", "dash-panel-actions");
    const tools = el("div", "dash-panel-tools");
    head.append(title, actions, tools);

    const body = el("div", "dash-panel-body");
    section.append(head, body);

    const disposers: WidgetDispose[] = [];
    if (!def) {
      body.append(this.unknownCard(panel.widget));
    } else {
      const dispose = this.mountWidget(def, panel, body, actions);
      if (dispose) disposers.push(dispose);
    }

    if (this.editorCtx && dashboardEditor?.decoratePanel) {
      try {
        const dispose = dashboardEditor.decoratePanel(panel, tools, this.editorCtx);
        if (dispose) disposers.push(dispose);
      } catch (err) {
        console.error("[dashboard] editor decoratePanel failed:", err);
      }
    }

    this.mounted.push({
      panel,
      dispose: () => {
        for (const d of disposers) {
          try {
            d();
          } catch (err) {
            console.error(`[dashboard] widget "${panel.widget}" dispose threw:`, err);
          }
        }
      },
    });

    return section;
  }

  private mountWidget(
    def: WidgetDefinition,
    panel: DashboardPanel,
    body: HTMLElement,
    actions: HTMLElement,
  ): WidgetDispose | null {
    const unsubscribes: Unsubscribe[] = [];
    let failed = false;

    const teardown = (): void => {
      while (unsubscribes.length) {
        const off = unsubscribes.pop();
        try {
          off?.();
        } catch {
          /* an unsubscribe that throws must not block the rest */
        }
      }
    };

    const fail = (err: unknown): void => {
      if (failed) return;
      failed = true;
      console.error(`[dashboard] widget "${def.type}" failed:`, err);
      teardown();
      // Its header controls belong to a widget that is no longer running.
      actions.textContent = "";
      body.textContent = "";
      body.append(this.errorCard(def.type, messageFor(err)));
    };

    const ctx: WidgetContext = {
      panelId: panel.id,
      config: { ...def.defaultConfig, ...panel.config },
      sources: this.sources,
      header: actions,
      setConfig: (patch) => this.updatePanelConfig(panel.id, patch),
      subscribe: <T>(
        source: DataSource<T>,
        listener: (value: T) => void,
        opts?: { immediate?: boolean },
      ): Unsubscribe => {
        const guarded = (value: T): void => {
          if (failed) return;
          try {
            listener(value);
          } catch (err) {
            fail(err);
          }
        };
        const off = source.subscribe(guarded);
        unsubscribes.push(off);
        if (opts?.immediate !== false) guarded(source.get());
        return off;
      },
      fail,
    };

    let widgetDispose: WidgetDispose | void;
    try {
      widgetDispose = def.mount(body, ctx);
    } catch (err) {
      fail(err);
      return teardown;
    }

    return () => {
      teardown();
      try {
        widgetDispose?.();
      } catch (err) {
        console.error(`[dashboard] widget "${def.type}" dispose threw:`, err);
      }
    };
  }

  private updatePanelConfig(panelId: string, patch: Record<string, unknown>): void {
    const next = this.getDocument();
    const dashboard = next.dashboards.find((d) => d.id === next.activeId);
    const panel = dashboard?.panels.find((p) => p.id === panelId);
    if (!panel) return;
    panel.config = { ...panel.config, ...patch };
    this.setDocument(next);
  }

  private unknownCard(widgetType: string): HTMLElement {
    const card = el("div", "dash-card dash-card-unknown");
    card.append(el("p", "dash-card-title", `Unknown widget: ${widgetType}`));
    card.append(
      el(
        "p",
        "dash-card-detail",
        "This build has no widget of that type. It was left in the layout, so a newer build will draw it.",
      ),
    );
    return card;
  }

  private errorCard(widgetType: string, message: string): HTMLElement {
    const card = el("div", "dash-card dash-card-error");
    card.append(el("p", "dash-card-title", `${widgetType} stopped working`));
    card.append(el("p", "dash-card-detail", message));
    return card;
  }

  private disposePanels(): void {
    const panels = this.mounted;
    this.mounted = [];
    for (const entry of panels) entry.dispose();
  }

  dispose(): void {
    this.disposePanels();
    if (this.editorCtx && dashboardEditor?.detach) {
      try {
        dashboardEditor.detach();
      } catch (err) {
        console.error("[dashboard] editor detach failed:", err);
      }
    }
    this.editorCtx = null;
    this.root.textContent = "";
  }
}
