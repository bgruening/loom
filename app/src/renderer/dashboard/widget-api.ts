/**
 * The interfaces a dashboard widget is written against.
 *
 * A widget never touches `window.orbit`, IPC, or the dashboard document. It is
 * handed an element, a config, and read-only data sources, and it gives back a
 * dispose. Everything else is the host's job, which is what lets the host
 * isolate a widget that throws to its own panel.
 */

import type { FileNode } from "../../preload/preload.js";
import type { Invocation } from "../galaxy-invocations.js";
import type {
  Dashboard,
  DashboardDocument,
  DashboardPanel,
  DashboardProblem,
} from "../../../../shared/dashboard-contract.js";

export type Unsubscribe = () => void;
export type WidgetDispose = () => void;

export interface DataSource<T> {
  get(): T;
  subscribe(listener: (value: T) => void): Unsubscribe;
}

/** Every snapshot carries the epoch-ms it was produced so a widget can show staleness. */
export interface Snapshot {
  updatedAt: number;
}

export interface NotebookSnapshot extends Snapshot {
  /** Raw notebook.md markdown, or "" before the brain has emitted any. */
  markdown: string;
  /** Absolute path the markdown came from, when the shell reported one. */
  path: string | null;
}

export interface InvocationSnapshot extends Snapshot {
  invocations: Invocation[];
}

export type PlanStepStatus = "pending" | "done" | "failed";

export interface PlanStep {
  /** `plan-a-step-1` from a `{#...}` anchor, when the notebook has one. */
  anchor: string | null;
  /** The step's own number as written, or its 1-based position when unnumbered. */
  number: number;
  title: string;
  status: PlanStepStatus;
  /** `Routing: Galaxy (bwa-mem2/2.2.1)` -> `Galaxy (bwa-mem2/2.2.1)`. */
  routing: string | null;
  /** Everything after the em-dash on the step line. */
  detail: string;
}

export interface PlanSection {
  /** Slugified heading, e.g. `plan-a`. */
  id: string;
  /** `Plan A: chrM Variant Calling`. */
  title: string;
  /** The `[hybrid]` / `[galaxy]` tag on the heading, lowercased. */
  routing: string | null;
  steps: PlanStep[];
}

export interface PlanSnapshot extends Snapshot {
  plans: PlanSection[];
}

export interface ActivityEvent {
  timestamp: string;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
}

export interface ActivitySnapshot extends Snapshot {
  /** Oldest first; a tail of the log, not the whole thing. */
  events: ActivityEvent[];
  /** False where the shell has no file read (the web shim), so a widget can say so. */
  available: boolean;
}

export interface FilesSnapshot extends Snapshot {
  root: FileNode | null;
  /** False where the shell has no file listing (the web shim). */
  available: boolean;
}

export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionSnapshot extends Snapshot {
  status: "running" | "stopped" | "error" | "unknown";
  /** True mid-turn. */
  streaming: boolean;
  cwd: string;
  model: string | null;
  costUsd: number | null;
  tokens: SessionTokens;
}

/**
 * The set of sources a widget can read. Adding one -- live Galaxy content
 * fetched by the main process on the renderer's behalf is the next candidate --
 * is a new key here plus a source in `data-sources.ts`. `WidgetDefinition` does
 * not change, existing widgets do not change, and a widget written against the
 * older set keeps compiling. That is the point of passing a bag of sources
 * rather than naming them in the mount signature.
 */
export interface DashboardDataSources {
  notebook: DataSource<NotebookSnapshot>;
  invocations: DataSource<InvocationSnapshot>;
  plan: DataSource<PlanSnapshot>;
  activity: DataSource<ActivitySnapshot>;
  files: DataSource<FilesSnapshot>;
  session: DataSource<SessionSnapshot>;
}

export interface WidgetContext<C extends Record<string, unknown> = Record<string, unknown>> {
  panelId: string;
  /** The panel's config merged over the widget's `defaultConfig`. */
  config: C;
  sources: DashboardDataSources;
  /** Header slot for widget-owned controls -- a filter, a refresh button. */
  header: HTMLElement;
  /** Persist a config change for this panel. Re-mounts the widget. */
  setConfig(patch: Partial<C>): void;
  /**
   * Subscribe with the host's safety net: unsubscribed automatically on
   * dispose, a throwing listener becomes this panel's error card instead of
   * breaking the dashboard, and the listener fires once with the current value
   * unless `immediate: false`.
   */
  subscribe<T>(
    source: DataSource<T>,
    listener: (value: T) => void,
    opts?: { immediate?: boolean },
  ): Unsubscribe;
  /**
   * Register cleanup that runs when the panel goes away **and when the widget
   * fails**. Anything that outlives `mount` -- a timer, an observer, a window
   * listener, a socket -- belongs here rather than in the returned dispose,
   * because a widget that throws never gets to return one.
   */
  onDispose(fn: () => void): void;
  /** Turn this panel into an error card. */
  fail(err: unknown): void;
}

export interface WidgetDefinition<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable key stored in the document. Matches the file base name. */
  type: string;
  label: string;
  description?: string;
  defaultConfig: C;
  mount(el: HTMLElement, ctx: WidgetContext<C>): WidgetDispose | void;
}

/** The slice of the host that the editor and any future chrome may use. */
export interface DashboardHostApi {
  getDocument(): DashboardDocument;
  /**
   * Validates, re-renders, and (unless `persist: false`) writes to disk.
   * Returns the repairs validation made, or -- if the document was fatally
   * malformed, in which case nothing changed -- why it was rejected.
   */
  setDocument(document: DashboardDocument, opts?: { persist?: boolean }): DashboardProblem[];
  getActiveDashboard(): Dashboard | null;
  setActiveDashboardId(id: string): void;
  listWidgets(): WidgetDefinition[];
  /**
   * Re-render the current document without changing or persisting it. For the
   * editor entering or leaving edit mode: `setDocument(getDocument())` would
   * work but would also write to disk.
   */
  refresh(): void;
}

export interface DashboardEditorContext {
  host: DashboardHostApi;
  /** A row above the grid that the editor owns outright. */
  toolbar: HTMLElement;
}

/**
 * Implemented in `editor.ts`. The host calls it if the module exports a
 * non-null `dashboardEditor`, so the editing UX can land without the host
 * changing at all.
 */
export interface DashboardEditor {
  attach(ctx: DashboardEditorContext): void;
  /** Called per panel after its widget mounts. `tools` is the editor's header slot. */
  decoratePanel?(
    panel: DashboardPanel,
    tools: HTMLElement,
    ctx: DashboardEditorContext,
  ): WidgetDispose | void;
  detach?(): void;
}
