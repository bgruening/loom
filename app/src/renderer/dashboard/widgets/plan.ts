/**
 * Plan widget -- where the analysis stands against the plan it is following.
 *
 * Reads `ctx.sources.plan`, which the host derives from the notebook markdown
 * per `docs/agent/notebook-schema.md`, so the desktop and the web shell show
 * the same thing without either of them reading a file. The one exception is a
 * notebook with Windows line endings; see `plansFor`.
 *
 * The target reader cannot read a terminal, so nothing here shows a machine
 * word: `[hybrid]` becomes a sentence, `- [!]` becomes "Failed", and a step
 * carries a glyph and a word before it carries a colour.
 */

import { parsePlanSections } from "../data-sources.js";
import type {
  PlanSection,
  PlanSnapshot,
  PlanStep,
  WidgetContext,
  WidgetDefinition,
} from "../widget-api.js";

/**
 * A `type`, not an `interface`: an interface has no implicit index signature
 * and will not assign to the registry's `WidgetDefinition<Record<string, unknown>>`.
 */
type PlanConfig = {
  /** `latest` draws only the most recent plan; `all` lists the earlier ones under it. */
  plan: "latest" | "all";
  /** Keep finished steps in the checklist. Off leaves only what is still to do. */
  showCompleted: boolean;
};

const EMPTY = "No plan yet -- ask Loom to draft one.";

/**
 * The four routing tags the notebook schema defines, in the words of someone
 * who has to decide whether to leave the laptop open. Definitions follow
 * `docs/agent/galaxy-routing.md`; an unrecognised tag is shown as written
 * rather than guessed at.
 */
const ROUTING_WORDS: Record<string, string> = {
  galaxy: "Runs on Galaxy",
  local: "Runs on this computer",
  hybrid: "Part on Galaxy, part on this computer",
  remote: "One Galaxy workflow, start to finish",
};

interface StepGlyph {
  glyph: string;
  word: string;
  state: string;
}

/**
 * A checkbox says done, failed or neither. It does not say "running" -- a step
 * Galaxy is working on right now and a step nobody has touched are the same
 * `- [ ]` -- so the pending word is "To do" rather than anything that implies
 * we know what the machine is doing. The jobs panel owns that question.
 */
const STEP_LOOK: Record<PlanStep["status"], StepGlyph> = {
  done: { glyph: "✓", word: "Done", state: "state-done" },
  failed: { glyph: "✕", word: "Failed", state: "state-failed" },
  pending: { glyph: "○", word: "To do", state: "state-waiting" },
};

interface PlanCounts {
  total: number;
  done: number;
  failed: number;
}

function countSteps(steps: PlanStep[]): PlanCounts {
  let done = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.status === "done") done++;
    else if (step.status === "failed") failed++;
  }
  return { total: steps.length, done, failed };
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

function routingSentence(routing: string | null): string | null {
  if (!routing) return null;
  return ROUTING_WORDS[routing.toLowerCase()] ?? `Routed "${routing}"`;
}

/**
 * Step routing is free text (`local`, `Galaxy (bwa-mem2/2.2.1)`, whatever a
 * hand edit left behind), so only the two shapes the schema actually writes
 * are reworded. Everything else is shown as the notebook has it.
 */
function stepRouting(routing: string | null): string | null {
  if (!routing) return null;
  const trimmed = routing.trim();
  if (!trimmed) return null;
  if (/^local$/i.test(trimmed)) return "On this computer";
  const galaxy = trimmed.match(/^galaxy\b\s*(.*)$/i);
  if (galaxy) return galaxy[1] ? `On Galaxy ${galaxy[1]}` : "On Galaxy";
  return trimmed;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The one line that answers "is this going well".
 *
 * Everything here has to be true of the checkboxes alone. "Stopped" is not --
 * a plan can carry a failed step and go on past it -- and neither is "not
 * started", because an unticked box covers both "nobody has begun" and "Galaxy
 * is running it right now".
 */
function summarize(counts: PlanCounts): { text: string; state: string; glyph: string } {
  if (counts.total === 0) {
    return { text: "No steps written down yet", state: "state-unknown", glyph: "?" };
  }
  if (counts.failed > 0) {
    const what = `${counts.failed} ${plural(counts.failed, "step", "steps")} failed`;
    const left = counts.total - counts.done - counts.failed;
    const text = left > 0 ? `${what} -- ${left} still to do` : `Finished, but ${what}`;
    return { text, state: "state-failed", glyph: "✕" };
  }
  if (counts.done >= counts.total) {
    const what = `all ${counts.total} ${plural(counts.total, "step", "steps")} done`;
    return { text: `Finished -- ${what}`, state: "state-done", glyph: "✓" };
  }
  if (counts.done === 0) {
    const what = `${counts.total} ${plural(counts.total, "step", "steps")} to do`;
    return { text: `No steps done yet -- ${what}`, state: "state-waiting", glyph: "○" };
  }
  return {
    text: `In progress -- ${counts.done} of ${counts.total} steps done`,
    state: "state-running",
    glyph: "●",
  };
}

/**
 * The host's plan source, except on a notebook with Windows line endings.
 *
 * `parsePlanSections` anchors its patterns with `$` and splits on `\n`, and a
 * JS `.` does not match a carriage return, so every line of a CRLF notebook
 * keeps a trailing `\r` that no pattern can reach: the source comes back with
 * no plans at all. Rather than keep a second parser in step with the host's,
 * re-run the host's own on normalised text. Delete this once `data-sources.ts`
 * splits on `/\r?\n/` -- the source will then be right and the branch is dead.
 */
function plansFor(snapshot: PlanSnapshot, ctx: WidgetContext<PlanConfig>): PlanSection[] {
  const markdown = ctx.sources.notebook.get().markdown;
  if (!markdown.includes("\r")) return snapshot.plans;
  return parsePlanSections(markdown.replace(/\r\n?/g, "\n"));
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

function stepLabel(step: PlanStep): string {
  const title = step.title || step.detail || "Untitled step";
  return `${step.number}. ${title}`;
}

function progressBar(counts: PlanCounts): HTMLElement {
  const bar = el("div", "dash-bar");
  bar.setAttribute("role", "img");
  const parts = [`${counts.done} of ${counts.total} steps done`];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  bar.setAttribute("aria-label", parts.join(", "));

  const done = el("span", "dash-bar-done");
  done.style.width = `${percent(counts.done, counts.total)}%`;
  const failed = el("span", "dash-bar-fail");
  failed.style.width = `${percent(counts.failed, counts.total)}%`;
  bar.append(done, failed);
  return bar;
}

function stateChip(look: StepGlyph): HTMLElement {
  const chip = el("span", `state ${look.state}`);
  const glyph = el("span", "state-glyph", look.glyph);
  glyph.setAttribute("aria-hidden", "true");
  chip.append(glyph);
  return chip;
}

function stepRow(step: PlanStep): HTMLElement {
  const look = STEP_LOOK[step.status];
  const row = el("div", "dash-row-item");
  if (step.status === "failed") row.classList.add("is-failed");
  row.append(stateChip(look));

  const main = el("div", "dash-row-main");
  const title = el("div", "dash-row-title", stepLabel(step));
  if (step.status === "pending") title.classList.add("is-muted");
  // The row is one line wide in a 175px panel, so the full text has to be
  // reachable some other way than by reading it.
  title.title = stepLabel(step);
  main.append(title);

  const meta: string[] = [look.word];
  const routing = stepRouting(step.routing);
  if (routing) meta.push(routing);
  if (meta.length > 0) main.append(el("div", "dash-meta", meta.join(" · ")));

  row.append(main);
  return row;
}

/**
 * What to do next, or what went wrong. A failure outranks a pending step:
 * pointing someone at step 4 while step 3 is broken is the wrong instruction.
 */
function calloutFor(steps: PlanStep[]): HTMLElement | null {
  const failed = steps.find((step) => step.status === "failed");
  const next = steps.find((step) => step.status === "pending");
  const step = failed ?? next;
  if (!step) return null;

  const box = el("div", "dash-plan-next");
  if (failed) box.classList.add("is-failed");

  const look = STEP_LOOK[step.status];
  const head = el("div", "dash-plan-next-head");
  head.append(stateChip(look));
  head.append(el("span", "dash-plan-next-label", failed ? "Needs you" : "Next"));
  box.append(head);

  box.append(el("div", "dash-plan-next-title", stepLabel(step)));

  const routing = stepRouting(step.routing);
  if (routing) box.append(el("div", "dash-meta", routing));
  if (step.detail) box.append(el("div", "dash-plan-next-detail", step.detail));
  if (!failed && step.verification) {
    box.append(el("div", "dash-plan-next-detail", `Done when: ${step.verification}`));
  }
  return box;
}

function planHeading(plan: PlanSection): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(el("div", "dash-plan-title", plan.title || "Untitled plan"));
  const routing = routingSentence(plan.routing);
  if (routing) frag.append(el("div", "dash-plan-routing dash-meta", routing));
  return frag;
}

function stepList(steps: PlanStep[], showCompleted: boolean): HTMLElement {
  const list = el("div", "dash-rows");
  const shown = showCompleted ? steps : steps.filter((step) => step.status !== "done");
  for (const step of shown) list.append(stepRow(step));

  const hidden = steps.length - shown.length;
  if (hidden > 0) {
    list.append(
      el(
        "div",
        "dash-meta dash-plan-hidden",
        `${hidden} finished ${plural(hidden, "step", "steps")} hidden`,
      ),
    );
  }
  if (shown.length === 0 && hidden === 0) {
    list.append(el("div", "dash-meta", "This plan has no steps written down yet."));
  }
  return list;
}

export const planWidget: WidgetDefinition<PlanConfig> = {
  type: "plan",
  label: "Plan",
  description: "Where the analysis plan stands.",
  defaultConfig: { plan: "latest", showCompleted: true },

  mount(root, ctx) {
    ensureStyles();
    root.classList.add("dash-plan");

    // Which earlier plans the reader has opened. Kept here rather than in the
    // config so that idly looking at an old plan does not write to disk; a
    // remount is the only thing that forgets it.
    const opened = new Set<string>();

    const showCompleted = ctx.config.showCompleted !== false;
    const scope: PlanConfig["plan"] = ctx.config.plan === "all" ? "all" : "latest";

    const completedBtn = el("button", "dash-panel-btn");
    completedBtn.type = "button";
    completedBtn.textContent = showCompleted ? "all steps" : "to do";
    completedBtn.title = showCompleted
      ? "Hide the steps that are already done"
      : "Show the steps that are already done";
    completedBtn.classList.toggle("active", !showCompleted);
    completedBtn.addEventListener("click", () => ctx.setConfig({ showCompleted: !showCompleted }));

    const scopeBtn = el("button", "dash-panel-btn", "older");
    scopeBtn.type = "button";
    scopeBtn.title =
      scope === "all" ? "Show only the current plan" : "List the earlier plans as well";
    scopeBtn.classList.toggle("active", scope === "all");
    scopeBtn.addEventListener("click", () =>
      ctx.setConfig({ plan: scope === "all" ? "latest" : "all" }),
    );
    // Only meaningful once a second plan exists; the subscription reveals it.
    scopeBtn.hidden = true;

    ctx.header.append(completedBtn, scopeBtn);

    const body = el("div", "dash-plan-body");
    root.append(body);

    const draw = (snapshot: PlanSnapshot): void => {
      body.textContent = "";
      const plans = plansFor(snapshot, ctx);
      scopeBtn.hidden = plans.length < 2;

      if (plans.length === 0) {
        body.append(el("p", "dash-plan-empty", EMPTY));
        return;
      }

      // The schema appends new plans at the bottom, so the last one is current.
      const current = plans[plans.length - 1];
      const counts = countSteps(current.steps);
      const verdict = summarize(counts);

      body.append(planHeading(current));
      if (counts.total > 0) body.append(progressBar(counts));

      const summary = el("div", `dash-plan-summary state ${verdict.state}`);
      const glyph = el("span", "state-glyph", verdict.glyph);
      glyph.setAttribute("aria-hidden", "true");
      summary.append(glyph, el("span", undefined, verdict.text));
      body.append(summary);

      const callout = calloutFor(current.steps);
      if (callout) body.append(callout);

      body.append(stepList(current.steps, showCompleted));

      if (scope === "all" && plans.length > 1)
        body.append(olderPlans(plans, opened, showCompleted));
    };

    ctx.subscribe(ctx.sources.plan, draw);

    return () => {
      root.classList.remove("dash-plan");
      root.textContent = "";
    };
  },
};

/**
 * Earlier plans, newest first, collapsed. Each is a real button with
 * `aria-expanded` so the keyboard and a screen reader get the same affordance
 * the mouse does.
 */
function olderPlans(
  plans: PlanSection[],
  opened: Set<string>,
  showCompleted: boolean,
): HTMLElement {
  const wrap = el("div", "dash-plan-older");
  const earlier = plans.slice(0, -1);
  wrap.append(
    el(
      "div",
      "dash-plan-older-head dash-meta",
      `${earlier.length} earlier ${plural(earlier.length, "plan", "plans")}`,
    ),
  );

  for (let i = earlier.length - 1; i >= 0; i--) {
    const plan = earlier[i];
    // Plan ids are slugged from the heading and two plans can slug alike, so
    // the open/closed key carries the position as well.
    const key = `${i}:${plan.title}`;
    const counts = countSteps(plan.steps);
    // The same verdict the current plan gets, so the two never disagree about
    // what "finished" or "stopped" means.
    const verdict = summarize(counts);

    const title = plan.title || "Untitled plan";
    const row = el("button", "dash-plan-older-row");
    row.type = "button";
    row.append(stateChip({ glyph: verdict.glyph, word: verdict.text, state: verdict.state }));
    const label = el("span", "dash-row-title", title);
    label.title = title;
    row.append(label);
    row.append(
      el(
        "span",
        "dash-meta dash-plan-older-count",
        counts.total > 0 ? `${counts.done}/${counts.total}` : "--",
      ),
    );
    // The row is too narrow for the state word beside the title, and the glyph
    // is aria-hidden decoration, so the word reaches a screen reader through
    // the button's name instead.
    row.setAttribute("aria-label", `${title} -- ${verdict.text}`);

    const detail = el("div", "dash-plan-older-detail");
    const paint = (): void => {
      const isOpen = opened.has(key);
      row.setAttribute("aria-expanded", isOpen ? "true" : "false");
      row.classList.toggle("is-open", isOpen);
      detail.hidden = !isOpen;
      detail.textContent = "";
      if (!isOpen) return;
      const routing = routingSentence(plan.routing);
      if (routing) detail.append(el("div", "dash-plan-routing dash-meta", routing));
      detail.append(stepList(plan.steps, showCompleted));
    };
    row.addEventListener("click", () => {
      if (opened.has(key)) opened.delete(key);
      else opened.add(key);
      paint();
    });
    paint();

    wrap.append(row, detail);
  }
  return wrap;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const STYLE_ID = "dash-plan-styles";

/**
 * The stylesheet lives here rather than in `dashboard.css` so that this widget
 * is one file, which is what lets several widgets be written at once without
 * colliding in a shared file. Move the block into `dashboard.css` and delete
 * this when the branches come back together.
 */
function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PLAN_STYLES;
  document.head.append(style);
}

const PLAN_STYLES = `
.dash-plan {
  /* The word carries the state, the colour only reinforces it -- but the
     colour still has to pass AA, and --accent and --error as text do not. */
  --plan-done: var(--success);
  --plan-running: var(--accent);
  --plan-failed: #fca5a5;
  /* Inherited by everything below. A step detail is usually a file path, and
     one unbroken 180-character path will otherwise scroll the whole panel
     sideways in a pane that is 360px wide. */
  overflow-wrap: anywhere;
}
:root[data-theme="light"] .dash-plan {
  --plan-running: var(--accent-hover);
  --plan-failed: var(--error);
}

.dash-plan-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dash-plan-empty {
  margin: 0;
  color: var(--dash-text-meta);
  line-height: 1.5;
}

.dash-plan-title {
  font-weight: 600;
  color: var(--text-bright);
  line-height: 1.35;
}

.dash-plan-routing {
  line-height: 1.4;
}

.dash-plan .dash-meta {
  font-size: 11px;
  color: var(--dash-text-meta);
}

.dash-plan .state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}

.dash-plan .state-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1;
}

.dash-plan .state-done {
  color: var(--plan-done);
}
.dash-plan .state-running {
  color: var(--plan-running);
}
.dash-plan .state-failed {
  color: var(--plan-failed);
}
.dash-plan .state-waiting,
.dash-plan .state-unknown {
  color: var(--dash-text-meta);
}

.dash-plan .state-running .state-glyph {
  animation: dash-plan-pulse 1.6s ease-in-out infinite;
}
@keyframes dash-plan-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dash-plan .state-running .state-glyph {
    animation: none;
  }
}

.dash-plan .dash-bar {
  display: flex;
  height: 6px;
  background: var(--bg-subtle-hover);
  border-radius: 3px;
  overflow: hidden;
}
.dash-plan .dash-bar-done {
  background: var(--success);
}
.dash-plan .dash-bar-fail {
  background: var(--error);
  /* Hatched so the failed slice is findable in greyscale. */
  background-image: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.32) 0 3px, transparent 3px 6px);
}

.dash-plan-next {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  background: var(--bg-subtle);
  padding: 6px 8px;
}
.dash-plan-next.is-failed {
  border-left-color: var(--error);
  background: var(--error-bg);
}
.dash-plan-next-head {
  display: flex;
  align-items: center;
  gap: 5px;
}
.dash-plan-next-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--dash-text-meta);
}
.dash-plan-next-title {
  margin-top: 2px;
  color: var(--text);
  line-height: 1.35;
}
.dash-plan-next-detail {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--dash-text-meta);
}

.dash-plan .dash-rows {
  display: flex;
  flex-direction: column;
}
.dash-plan .dash-row-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.dash-plan .dash-row-item:last-child {
  border-bottom: 0;
}
.dash-plan .dash-row-item.is-failed {
  background: var(--error-bg);
  margin: 0 -10px;
  padding: 4px 10px;
  border-bottom-color: transparent;
}
.dash-plan .dash-row-main {
  flex: 1;
  min-width: 0;
}
.dash-plan .dash-row-title {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-plan .dash-row-title.is-muted {
  color: var(--dash-text-meta);
}
.dash-plan-hidden {
  padding-top: 4px;
}

.dash-plan-older {
  margin-top: 2px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
.dash-plan-older-head {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  font-weight: 700;
  margin-bottom: 2px;
}
.dash-plan-older-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 4px 0;
  cursor: pointer;
}
.dash-plan-older-row:hover .dash-row-title {
  color: var(--text-bright);
}
.dash-plan-older-row:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
.dash-plan-older-count {
  margin-left: auto;
  flex-shrink: 0;
  font-family: var(--font);
  font-variant-numeric: tabular-nums;
}
.dash-plan-older-detail {
  padding: 0 0 4px 20px;
}
`;
