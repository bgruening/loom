/**
 * Running jobs widget -- the panel that answers "is my analysis still running,
 * and is it going well?"
 *
 * Two kinds of run reach it through `ctx.sources.invocations`, both derived
 * from the notebook markdown: `loom-invocation` blocks (a workflow) and
 * `loom-job` blocks (a single tool run, and the only thing that moves in a
 * session that never invoked a workflow).
 *
 * Three rules shape everything below.
 *
 * A failure is never quiet. A run with a failed job sorts to the top, gets a
 * red row and a red strip at the top of the panel, and the strip names the plan
 * step when the notebook binds the run to one. The person reading this cannot
 * open a terminal; if they miss the failure here they miss it entirely.
 *
 * A number nobody refreshed is not a live number. `last_polled_at` is the only
 * evidence we have that Galaxy was asked recently, so every row says when that
 * was, and a run that has gone quiet says "can't tell" rather than drawing a
 * confident stale bar. That heartbeat is trustworthy for invocations and not
 * for jobs -- see `isStaleTracked`.
 *
 * Nothing here polls anything. The only timer repaints relative times already
 * on screen, because "checked 40 s ago" frozen at 40 s for an hour is the exact
 * lie the staleness line exists to prevent.
 */

import type { Invocation } from "../../galaxy-invocations.js";
import type {
  DashboardJob,
  InvocationSnapshot,
  PlanSection,
  WidgetDefinition,
  WidgetDispose,
} from "../widget-api.js";

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * A `type`, not an `interface`: an interface has no implicit index signature
 * and will not assign to the registry's `WidgetDefinition<Record<string, unknown>>`.
 */
export type JobsConfig = {
  /** `active` also keeps anything that failed -- a failure is never hidden. */
  show: "active" | "all";
  /** How many rows to draw before collapsing the rest into a count. */
  limit: number;
  /** One line per run: no progress bar, no sentence, no link. */
  compact: boolean;
};

export const JOBS_DEFAULT_CONFIG: JobsConfig = { show: "active", limit: 6, compact: false };

const LIMIT_MIN = 1;
const LIMIT_MAX = 40;

/** The document is hand-editable and model-written, so nothing in it is trusted. */
export function normalizeJobsConfig(raw: Partial<Record<keyof JobsConfig, unknown>>): JobsConfig {
  const limitRaw = typeof raw.limit === "number" ? Math.floor(raw.limit) : NaN;
  return {
    show: raw.show === "all" ? "all" : "active",
    limit: Number.isFinite(limitRaw)
      ? Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, limitRaw))
      : JOBS_DEFAULT_CONFIG.limit,
    compact: raw.compact === true,
  };
}

// ── The normalized row ───────────────────────────────────────────────────────

export type RunState =
  | "running"
  | "queued"
  | "stopping"
  | "paused"
  | "finished"
  | "failed"
  | "cancelled"
  | "skipped"
  | "unknown";

export interface RunRow {
  kind: "invocation" | "job";
  id: string;
  label: string;
  state: RunState;
  /** True while Galaxy could still move this run. */
  live: boolean;
  jobs: { done: number; failed: number; total: number };
  steps: { done: number; total: number } | null;
  serverUrl: string;
  serverHost: string;
  anchor: string;
  /** The plan step this run is bound to, when the plan names it. */
  step: { number: number; title: string } | null;
  /** Epoch ms, or null when the block's timestamp will not parse. */
  submittedAt: number | null;
  lastPolledAt: number | null;
  /** The brain's own one-line note from the block. */
  summary: string | null;
  /** Galaxy's raw job state at the last poll. Jobs only. */
  galaxyState: string | null;
  toolId: string | null;
  /** Galaxy never confirmed this id exists. */
  unconfirmed: boolean;
  /** Live, and nobody has heard from Galaxy in a while. */
  stale: boolean;
}

/**
 * How long a live run may go without a fresh `last_polled_at` before the panel
 * stops believing its own numbers. The poller ticks every 15s, so this is
 * twenty missed ticks: far outside a slow Galaxy round trip or a tick that
 * waited on the notebook lock, and squarely in "Galaxy is unreachable, the
 * credentials are gone, or nothing is running to do the asking". A tighter
 * threshold cried wolf in the browser inside two minutes of a healthy run.
 */
export const STALE_AFTER_MS = 300_000;

/**
 * Galaxy's job states, folded to what the panel draws. Mirrors
 * `JOB_STATE_OUTCOME` in `extensions/loom/galaxy-job-block.ts` and adds the
 * non-terminal states that table deliberately omits.
 *
 * `deleting` and `stop` are the two that cost the brain a bug and would cost
 * this panel another: they are Galaxy on its way to `deleted` and `stopped`,
 * not Galaxy having arrived. A run in either is still moving.
 */
const GALAXY_JOB_STATE: Readonly<Record<string, RunState>> = {
  ok: "finished",
  error: "failed",
  failed: "failed",
  deleted: "cancelled",
  stopped: "cancelled",
  skipped: "skipped",
  running: "running",
  new: "queued",
  queued: "queued",
  waiting: "queued",
  paused: "paused",
  deleting: "stopping",
  stop: "stopping",
  upload: "running",
  setting_metadata: "running",
  resubmitted: "queued",
};

const LIVE_STATES: ReadonlySet<RunState> = new Set([
  "running",
  "queued",
  "stopping",
  "paused",
  "unknown",
]);

/**
 * What a `loom-job` block is actually doing. The block's own status wins when
 * it is terminal -- the brain decided that, and Galaxy's raw state is only kept
 * alongside for display. While it is `in_progress` the raw state is the finer
 * answer, and a state this build has never heard of reads as `unknown` rather
 * than being guessed into `running`: the brain's own table treats an
 * unrecognised state as "keep watching", and so does this.
 */
export function foldJobState(status: DashboardJob["status"], galaxyState: string | null): RunState {
  if (status === "completed") return "finished";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  if (status !== "in_progress") return "unknown";
  if (!galaxyState) return "queued";
  return GALAXY_JOB_STATE[galaxyState.toLowerCase()] ?? "unknown";
}

/**
 * `loom-invocation` has three statuses and no fourth for a cancel: a workflow
 * the user stopped is written `failed`, with a summary that begins "Workflow
 * cancelled". That summary is rendered verbatim beneath the state so the row
 * explains itself, but the word above it still reads Failed. Fixing that
 * properly is a brain-side change to `InvocationYaml["status"]`.
 */
export function foldInvocationState(status: Invocation["status"]): RunState {
  if (status === "completed") return "finished";
  if (status === "failed") return "failed";
  if (status === "in_progress") return "running";
  return "unknown";
}

function parseTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Is this run's `last_polled_at` a heartbeat we can reason about?
 *
 * For an invocation, yes: `checkInvocations` rewrites the block on every poll
 * whether or not anything changed, precisely so the renderer can draw live
 * counters. For a job, no: `tickJobs` polls every 15s but only writes on a
 * terminal transition or the one-off `server_verified` upgrade, so a job that
 * has been running happily for two hours still carries the timestamp of its
 * first poll. Calling that stale would put "can't tell right now" on a run we
 * are checking four times a minute, which is a worse lie than the one the
 * staleness rule exists to prevent.
 */
function isStaleTracked(kind: RunRow["kind"]): boolean {
  return kind === "invocation";
}

/** `plan-a-step-1` -> the step it addresses, when the plan still has one. */
export function findStep(plans: PlanSection[], anchor: string): RunRow["step"] {
  if (!anchor) return null;
  for (const plan of plans) {
    for (const step of plan.steps) {
      // Either spelling notebook-anchors.ts accepts: the explicit `{#...}`
      // marker a step carries, or the positional address derived for a step
      // that carries none.
      if (step.anchor === anchor || `${plan.id}-step-${step.number}` === anchor) {
        return { number: step.number, title: step.title };
      }
    }
  }
  return null;
}

function invocationRow(inv: Invocation, plans: PlanSection[], now: number): RunRow {
  const state = foldInvocationState(inv.status);
  const done = count(inv.completedJobs);
  const failed = count(inv.failedJobs);
  // A hand-edited block can claim 12 total and 14 done. Believe the parts.
  const total = Math.max(count(inv.totalJobs), done + failed);
  const stepsTotal = count(inv.totalSteps);
  const lastPolledAt = parseTime(inv.lastPolledAt);
  const submittedAt = parseTime(inv.submittedAt);
  const live = LIVE_STATES.has(state);
  const heardFrom = lastPolledAt ?? submittedAt;
  return {
    kind: "invocation",
    id: inv.invocationId,
    label: inv.label,
    state,
    live,
    jobs: { done, failed, total },
    steps:
      stepsTotal > 0
        ? { done: Math.min(count(inv.completedSteps), stepsTotal), total: stepsTotal }
        : null,
    serverUrl: inv.galaxyServerUrl,
    serverHost: hostOf(inv.galaxyServerUrl),
    anchor: inv.notebookAnchor,
    step: findStep(plans, inv.notebookAnchor),
    submittedAt,
    lastPolledAt,
    summary: inv.summary?.trim() || null,
    galaxyState: null,
    toolId: null,
    unconfirmed: inv.serverVerified === false,
    stale:
      isStaleTracked("invocation") &&
      live &&
      (heardFrom === null || now - heardFrom > STALE_AFTER_MS),
  };
}

function jobRow(job: DashboardJob, plans: PlanSection[], now: number): RunRow {
  const galaxyState = job.galaxyState?.trim() || null;
  const state = foldJobState(job.status, galaxyState);
  const live = LIVE_STATES.has(state);
  const lastPolledAt = parseTime(job.lastPolledAt);
  const submittedAt = parseTime(job.submittedAt);
  const heardFrom = lastPolledAt ?? submittedAt;
  return {
    kind: "job",
    id: job.jobId,
    label: job.label,
    state,
    live,
    jobs: { done: state === "finished" ? 1 : 0, failed: state === "failed" ? 1 : 0, total: 1 },
    steps: null,
    serverUrl: job.galaxyServerUrl,
    serverHost: hostOf(job.galaxyServerUrl),
    anchor: job.notebookAnchor,
    step: findStep(plans, job.notebookAnchor),
    submittedAt,
    lastPolledAt,
    summary: job.summary?.trim() || null,
    galaxyState,
    toolId: job.toolId,
    unconfirmed: job.serverVerified === false,
    stale:
      isStaleTracked("job") && live && (heardFrom === null || now - heardFrom > STALE_AFTER_MS),
  };
}

/** Does this row deserve the user's attention right now? */
export function needsAttention(row: RunRow): boolean {
  return row.state === "failed" || row.jobs.failed > 0;
}

function rank(row: RunRow): number {
  if (needsAttention(row)) return 0;
  if (row.state === "paused") return 1;
  if (row.live) return 2;
  return 3;
}

/**
 * Every tracked run, normalized and ordered: failures first, then anything
 * waiting on the user, then whatever is still moving, then the finished work.
 * Newest first inside each band, with the id as a tiebreak so the order is
 * stable across renders.
 */
export function toRunRows(
  snapshot: InvocationSnapshot,
  plans: PlanSection[],
  now: number,
): RunRow[] {
  const rows: RunRow[] = [
    ...snapshot.invocations.map((inv) => invocationRow(inv, plans, now)),
    ...snapshot.jobs.map((job) => jobRow(job, plans, now)),
  ];
  return rows.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const bySubmitted = (b.submittedAt ?? 0) - (a.submittedAt ?? 0);
    if (bySubmitted !== 0) return bySubmitted;
    return a.id.localeCompare(b.id);
  });
}

/** What `show: "active"` keeps. A failure is never filtered away. */
export function isActiveRun(row: RunRow): boolean {
  return row.live || needsAttention(row);
}

// ── Words ────────────────────────────────────────────────────────────────────

const STATE_WORD: Readonly<Record<RunState, string>> = {
  running: "Running",
  queued: "Waiting for Galaxy",
  stopping: "Stopping",
  paused: "Paused",
  finished: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  unknown: "Working",
};

/**
 * A glyph and a word before a colour: printed in greyscale, or read by someone
 * who cannot separate red from green, every row still says what it is.
 */
const STATE_GLYPH: Readonly<Record<RunState, string>> = {
  running: "●",
  queued: "○",
  stopping: "◐",
  paused: "⏸",
  finished: "✓",
  failed: "✕",
  cancelled: "⊘",
  skipped: "⊘",
  unknown: "?",
};

export function stateWord(state: RunState): string {
  return STATE_WORD[state] ?? STATE_WORD.unknown;
}

export function stateGlyph(state: RunState): string {
  return STATE_GLYPH[state] ?? STATE_GLYPH.unknown;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "45 s", "8 m", "1 h 34 m", "6 d 2 h". Never a bare number. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < MINUTE) return `${Math.floor(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} m`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return `${hours} h ${String(minutes).padStart(2, "0")} m`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return `${days} d ${hours} h`;
}

/** "1 h 34 m ago", or "" when the timestamp is missing. */
export function formatAgo(at: number | null, now: number): string {
  if (at === null) return "";
  const delta = now - at;
  // A clock skew between the Galaxy server and this machine must not print
  // a negative age.
  if (delta < 0) return "just now";
  const text = formatDuration(delta);
  return text ? `${text} ago` : "";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "7 of 12 jobs done, none failed" -- the counts, in words, or "". */
export function countsSentence(row: RunRow): string {
  const { done, failed, total } = row.jobs;
  if (row.kind === "job" || total === 0) return "";
  return `${done} of ${total} jobs done, ${failed > 0 ? `${failed} failed` : "none failed"}`;
}

/**
 * The row's headline, in a scientist's words rather than Galaxy's. Staleness
 * beats everything: a run we have not heard about is not a run we can describe.
 */
export function describeRun(row: RunRow, now: number): string {
  if (row.stale) {
    const ago = formatAgo(row.lastPolledAt ?? row.submittedAt, now);
    return ago
      ? `Can't tell right now. Galaxy was last checked ${ago}.`
      : "Can't tell right now. Galaxy has not been checked.";
  }

  const counts = countsSentence(row);
  const remaining = Math.max(0, row.jobs.total - row.jobs.done - row.jobs.failed);

  switch (row.state) {
    case "failed":
      if (row.jobs.total > 1) {
        return `Failed -- ${row.jobs.failed} of ${row.jobs.total} jobs errored, ${row.jobs.done} succeeded.`;
      }
      return "Failed. Ask the agent what Galaxy reported.";
    case "running":
      if (row.jobs.failed > 0) {
        return `${plural(row.jobs.failed, "job has", "jobs have")} failed. ${row.jobs.done} finished, ${remaining} still going.`;
      }
      if (counts) return `Running -- ${counts}.`;
      return "Running. Galaxy has not reported any job counts yet.";
    case "queued":
      return row.lastPolledAt === null
        ? "Submitted. Waiting for Galaxy's first answer."
        : "Waiting for Galaxy to start it.";
    case "stopping":
      return "Stopping. Galaxy is still shutting this down.";
    case "paused":
      return "Paused -- it needs you before it can carry on.";
    case "finished":
      if (row.jobs.total > 1) return `Finished -- all ${row.jobs.total} jobs succeeded.`;
      return "Finished.";
    case "cancelled":
      return "Cancelled. It produced no outputs.";
    case "skipped":
      return "Skipped. Its step's condition was not met.";
    default:
      return "Still going. Galaxy reported a state this version does not recognise.";
  }
}

/** The red strip at the top of the panel, or "" when nothing failed. */
export function attentionMessage(rows: RunRow[]): string {
  const bad = rows.filter(needsAttention);
  if (bad.length === 0) return "";
  if (bad.length === 1) {
    const row = bad[0];
    const name = row.label || row.id;
    // A run is usually labelled after the step it runs, so naming the step's
    // title as well costs a line of a 400px panel to say the same word twice.
    const where = row.step
      ? name.toLowerCase().includes(row.step.title.toLowerCase())
        ? ` (step ${row.step.number})`
        : ` (step ${row.step.number}, ${row.step.title})`
      : "";
    if (row.jobs.total > 1 && row.jobs.failed > 0) {
      return `${row.jobs.failed} of ${row.jobs.total} jobs failed in "${name}"${where}.`;
    }
    return `"${name}"${where} failed.`;
  }
  const jobs = bad.reduce((sum, row) => sum + Math.max(1, row.jobs.failed), 0);
  return `${plural(jobs, "job", "jobs")} failed across ${plural(bad.length, "run", "runs")}.`;
}

/**
 * Where this run lives in Galaxy. Routes read off Galaxy's own client router:
 * `workflows/invocations/:invocationId/:tab?` and `jobs/:jobId/view`.
 *
 * The server URL comes out of the notebook, so it is treated as hostile: only
 * http(s) survives, and the id is encoded, which turns any `../` into `%2F` and
 * keeps the path under the server we were handed.
 */
export function galaxyRunUrl(row: RunRow): string | null {
  if (!row.serverUrl || !row.id) return null;
  let base: URL;
  try {
    base = new URL(row.serverUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  const path =
    row.kind === "invocation"
      ? `workflows/invocations/${encodeURIComponent(row.id)}`
      : `jobs/${encodeURIComponent(row.id)}/view`;
  // A configured URL may carry a path prefix ("https://host/galaxy"); keep it.
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  try {
    return new URL(`${prefix}${path}`, base).toString();
  } catch {
    return null;
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

/**
 * How often to repaint the relative times already on screen. Not a poll: the
 * data arrives when the brain rewrites the notebook. Without it a run whose
 * poller has stopped keeps saying "checked 40 s ago" forever, which is the one
 * thing this panel must never do.
 */
const TICK_MS = 30_000;

const STYLE_ID = "dash-jobs-style";

/**
 * Lives here rather than in `dashboard/dashboard.css` because that file belongs
 * to the dashboard foundation and several branches build against it at once.
 * Lift it across when the branches meet; nothing about it is widget-private.
 */
const STYLE = `
/* State colours as their own tokens, because the product's --accent, --warning
   and --error are each under the 4.5:1 floor for 11px text in one theme or the
   other: amber on white is 3.7:1 in light, salmon on the tinted failed row is
   3.4:1 in dark. Same values the dashboard mockups settled on. */
.dash-jobs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  --jobs-running: var(--accent);
  --jobs-paused: var(--warning);
  --jobs-done: var(--success);
  --jobs-failed: #fca5a5;
}
:root[data-theme="light"] .dash-jobs {
  --jobs-running: var(--accent-hover);
  --jobs-paused: var(--accent-hover);
  --jobs-failed: var(--error);
}
.dash-jobs-alert {
  display: flex; gap: 7px; align-items: flex-start; margin: 0;
  padding: 7px 9px; border: 1px solid var(--error); border-radius: 4px;
  background: var(--error-bg); color: var(--text); font-size: 12px; line-height: 1.45;
}
.dash-jobs-alert-glyph { color: var(--jobs-failed); font-weight: 700; flex-shrink: 0; }
.dash-jobs-rows { display: flex; flex-direction: column; }
.dash-jobs-row { padding: 7px 0; border-bottom: 1px solid var(--border-subtle); }
.dash-jobs-row:first-child { padding-top: 0; }
.dash-jobs-row:last-child { border-bottom: 0; padding-bottom: 0; }
.dash-jobs-row.is-failed {
  margin: 0 -10px; padding-left: 10px; padding-right: 10px;
  background: var(--error-bg); border-bottom-color: transparent;
  box-shadow: inset 3px 0 0 var(--error);
}
.dash-jobs-title {
  font-size: 12.5px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-jobs-row.is-done .dash-jobs-title { color: var(--dash-text-meta); }
.dash-jobs-state {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 600; white-space: nowrap;
}
.dash-jobs-glyph { display: inline-block; width: 14px; text-align: center; flex-shrink: 0; }
.dash-jobs-state.state-running { color: var(--jobs-running); }
.dash-jobs-state.state-queued,
.dash-jobs-state.state-stopping,
.dash-jobs-state.state-unknown,
.dash-jobs-state.state-cancelled,
.dash-jobs-state.state-skipped { color: var(--dash-text-meta); }
.dash-jobs-state.state-paused { color: var(--jobs-paused); }
.dash-jobs-state.state-finished { color: var(--jobs-done); }
.dash-jobs-state.state-failed { color: var(--jobs-failed); }
.dash-jobs-state.state-running .dash-jobs-glyph {
  animation: dash-jobs-pulse 1.6s ease-in-out infinite;
}
@keyframes dash-jobs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .dash-jobs-state.state-running .dash-jobs-glyph { animation: none; }
}
.dash-jobs-bar {
  display: flex; height: 6px; margin: 6px 0 4px; border-radius: 3px;
  background: var(--bg-subtle-hover); overflow: hidden;
}
.dash-jobs-bar-done { background: var(--success); }
.dash-jobs-bar-fail {
  background: var(--error);
  background-image: repeating-linear-gradient(45deg, rgba(0,0,0,0.32) 0 3px, transparent 3px 6px);
}
.dash-jobs-say { margin: 3px 0 0; font-size: 12px; line-height: 1.45; color: var(--text); }
.dash-jobs-row.is-stale .dash-jobs-say { color: var(--dash-text-meta); }
/* A bar nobody has refreshed should not look as solid as one we just read. */
.dash-jobs-row.is-stale .dash-jobs-bar { opacity: 0.5; }
.dash-jobs-why {
  margin: 3px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--dash-text-meta);
}
.dash-jobs-meta {
  margin-top: 3px; font-size: 11px; color: var(--dash-text-meta);
  font-family: var(--font); font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
}
.dash-jobs-link {
  display: inline-block; margin-top: 4px; font-size: 11px;
  color: var(--jobs-running); text-decoration: none;
}
.dash-jobs-link:hover { text-decoration: underline; }
.dash-jobs-raw { margin-top: 5px; font-size: 11px; }
.dash-jobs-raw > summary { cursor: pointer; color: var(--dash-text-meta); }
.dash-jobs-raw dl {
  display: grid; grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 8px; margin: 5px 0 0; font-size: 11px;
}
.dash-jobs-raw dt { color: var(--dash-text-meta); white-space: nowrap; }
.dash-jobs-raw dd {
  margin: 0; color: var(--text); font-family: var(--font); overflow-wrap: anywhere;
}
.dash-jobs-more { margin: 2px 0 0; font-size: 11px; color: var(--dash-text-meta); }
.dash-jobs-empty {
  display: flex; flex-direction: column; gap: 5px; align-items: center;
  justify-content: center; height: 100%; min-height: 48px; padding: 6px;
  text-align: center; font-size: 12px; line-height: 1.45; color: var(--dash-text-meta);
}
.dash-jobs-empty strong { color: var(--text); font-weight: 600; }
/* The host's panel button is borderless until hover, which is too quiet for
   the only way back to the runs this filter is hiding. */
.dash-jobs-empty .dash-panel-btn { border-color: var(--border-strong); }
.dash-jobs-count {
  background: var(--accent-bg); border: 1px solid var(--accent); color: var(--text-bright);
  padding: 0 5px; border-radius: 8px; font-size: 10px; font-weight: 700; font-family: var(--font);
}
.dash-jobs-count.zero {
  background: var(--bg-deep); border-color: var(--border); color: var(--dash-text-meta);
}
.dash-jobs-count.bad {
  background: var(--error-bg); border-color: var(--error); color: var(--text-bright);
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function pct(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.max(0, Math.min(100, (part / total) * 100)).toFixed(1)}%`;
}

function progressBar(row: RunRow): HTMLElement | null {
  const { done, failed, total } = row.jobs;
  // A single job is its own progress bar; two states do not need a chart.
  if (total <= 1) return null;
  const bar = node("div", "dash-jobs-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute(
    "aria-label",
    `${done} of ${total} jobs finished${failed > 0 ? `, ${failed} failed` : ""}`,
  );
  if (done > 0) {
    const span = node("span", "dash-jobs-bar-done");
    span.style.width = pct(done, total);
    bar.append(span);
  }
  if (failed > 0) {
    const span = node("span", "dash-jobs-bar-fail");
    span.style.width = pct(failed, total);
    bar.append(span);
  }
  return bar;
}

/** The small print: steps, how long it has been going, when we last asked. */
export function metaLine(row: RunRow, now: number): string {
  const bits: string[] = [];
  if (row.steps) bits.push(`${row.steps.done} of ${row.steps.total} steps`);
  const started = formatAgo(row.submittedAt, now);
  if (started) bits.push(row.live ? `started ${started}` : `submitted ${started}`);
  const checked = formatAgo(row.lastPolledAt, now);
  if (checked) bits.push(`checked ${checked}`);
  else if (row.live) bits.push("not checked yet");
  if (row.serverHost) bits.push(row.serverHost);
  if (row.unconfirmed) bits.push("unconfirmed by Galaxy");
  return bits.join(" · ");
}

function detailRows(row: RunRow, now: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (row.step) out.push(["Plan step", `${row.step.number}. ${row.step.title}`]);
  else if (row.anchor) out.push(["Notebook anchor", row.anchor]);
  if (row.toolId) out.push(["Tool", row.toolId]);
  out.push([row.kind === "invocation" ? "Invocation" : "Job", row.id]);
  if (row.serverHost) out.push(["Galaxy", row.serverHost]);
  if (row.galaxyState) out.push(["Galaxy state", row.galaxyState]);
  if (row.jobs.total > 1) {
    const left = Math.max(0, row.jobs.total - row.jobs.done - row.jobs.failed);
    out.push([
      "Jobs",
      `${row.jobs.done} finished, ${row.jobs.failed} failed, ${left} to go, ${row.jobs.total} in total`,
    ]);
  }
  const checked = formatAgo(row.lastPolledAt, now);
  if (checked) out.push(["Last checked", checked]);
  return out;
}

/**
 * Show the brain's own note when it says something the headline cannot: why a
 * terminal run ended, or what is failing inside one that is still going. On a
 * healthy running row it would only repeat the counts.
 */
function shouldShowSummary(row: RunRow): boolean {
  return row.summary !== null && (!row.live || needsAttention(row));
}

function renderRow(row: RunRow, now: number, compact: boolean, openIds: Set<string>): HTMLElement {
  const item = node("section", "dash-jobs-row");
  item.dataset.runId = row.id;
  item.dataset.state = row.state;
  if (needsAttention(row)) item.classList.add("is-failed");
  if (row.stale) item.classList.add("is-stale");
  if (!row.live && !needsAttention(row)) item.classList.add("is-done");

  const title = node("div", "dash-jobs-title", row.label || row.id);
  title.title = row.step
    ? `${row.label || row.id} -- step ${row.step.number}, ${row.step.title}`
    : row.label || row.id;
  item.append(title);

  if (!compact) {
    const bar = progressBar(row);
    if (bar) item.append(bar);
  }

  // A stale row must not wear the colour and the pulse of the state it can no
  // longer vouch for.
  const shownState = row.stale ? "unknown" : row.state;
  const state = node("div", `dash-jobs-state state-${shownState}`);
  state.append(node("span", "dash-jobs-glyph", stateGlyph(shownState)));
  state.append(document.createTextNode(row.stale ? "Can't tell" : stateWord(row.state)));
  item.append(state);

  if (!compact) {
    item.append(node("p", "dash-jobs-say", describeRun(row, now)));
    if (shouldShowSummary(row)) {
      item.append(node("p", "dash-jobs-why", row.summary ?? ""));
    }
  }

  item.append(node("div", "dash-jobs-meta", metaLine(row, now)));

  if (!compact) {
    const href = galaxyRunUrl(row);
    if (href) {
      const link = node("a", "dash-jobs-link", "Open in Galaxy ↗");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
    }

    const details = node("details", "dash-jobs-raw");
    // Re-rendering replaces the node, so remember which rows the user opened;
    // this panel redraws every time the poller rewrites the notebook.
    details.open = openIds.has(row.id);
    details.addEventListener("toggle", () => {
      if (details.open) openIds.add(row.id);
      else openIds.delete(row.id);
    });
    details.append(node("summary", undefined, "Details"));
    const list = node("dl");
    for (const [term, value] of detailRows(row, now)) {
      list.append(node("dt", undefined, term));
      list.append(node("dd", undefined, value));
    }
    details.append(list);
    item.append(details);
  }

  return item;
}

function emptyCard(hidden: number, onShowAll: () => void): HTMLElement {
  const card = node("div", "dash-jobs-empty");
  card.append(node("strong", undefined, "Nothing is running on Galaxy right now."));
  if (hidden <= 0) {
    card.append(
      node(
        "span",
        undefined,
        "Workflow runs and single tool runs appear here as soon as the agent starts one.",
      ),
    );
    return card;
  }
  card.append(
    node(
      "span",
      undefined,
      hidden === 1 ? "One finished run is hidden." : `${hidden} finished runs are hidden.`,
    ),
  );
  const button = node("button", "dash-panel-btn", "Show everything");
  button.type = "button";
  button.addEventListener("click", onShowAll);
  card.append(button);
  return card;
}

// ── The widget ───────────────────────────────────────────────────────────────

export const jobsWidget: WidgetDefinition<JobsConfig> = {
  type: "jobs",
  label: "Running on Galaxy",
  description: "Galaxy workflow runs and tool runs, what failed, and how fresh the numbers are.",
  defaultConfig: JOBS_DEFAULT_CONFIG,

  mount(container, ctx): WidgetDispose {
    ensureStyle();
    const config = normalizeJobsConfig(ctx.config);

    const root = node("div", "dash-jobs");
    // One element across renders, so a screen reader hears a failure once when
    // it appears rather than on every notebook rewrite.
    const alert = node("p", "dash-jobs-alert");
    alert.setAttribute("role", "status");
    alert.hidden = true;
    const alertGlyph = node("span", "dash-jobs-alert-glyph", "✕");
    alertGlyph.setAttribute("aria-hidden", "true");
    const alertText = node("span");
    alert.append(alertGlyph, alertText);
    const body = node("div", "dash-jobs-body");
    root.append(alert, body);
    container.append(root);

    const badge = node("span", "dash-jobs-count zero", "0");
    const showBtn = node("button", "dash-panel-btn");
    showBtn.type = "button";
    showBtn.textContent = config.show === "all" ? "all" : "active";
    showBtn.title =
      config.show === "all"
        ? "Showing every run. Click to show only what is running or failed."
        : "Showing what is running or failed. Click to show every run.";
    showBtn.classList.toggle("active", config.show === "all");
    showBtn.addEventListener("click", () =>
      ctx.setConfig({ show: config.show === "all" ? "active" : "all" }),
    );
    ctx.header.append(badge, showBtn);

    const openIds = new Set<string>();
    let snapshot: InvocationSnapshot = ctx.sources.invocations.get();
    let lastAlert: string | null = null;

    const render = (): void => {
      const now = Date.now();
      // Both sources are staged from the same notebook push and notified in
      // order, so the plan read here is this turn's, not last turn's.
      const rows = toRunRows(snapshot, ctx.sources.plan.get().plans, now);
      const shown = config.show === "all" ? rows : rows.filter(isActiveRun);

      const message = attentionMessage(rows);
      if (message !== lastAlert) {
        alertText.textContent = message;
        alert.hidden = message === "";
        lastAlert = message;
      }

      const active = rows.filter((row) => row.live).length;
      const failing = rows.filter(needsAttention).length;
      badge.textContent = String(failing > 0 ? failing : active);
      badge.className = `dash-jobs-count${failing > 0 ? " bad" : active === 0 ? " zero" : ""}`;
      badge.title =
        failing > 0
          ? `${plural(failing, "run needs", "runs need")} your attention`
          : `${plural(active, "run is", "runs are")} still going`;

      body.textContent = "";
      if (shown.length === 0) {
        body.append(emptyCard(rows.length, () => ctx.setConfig({ show: "all" })));
        return;
      }

      const list = node("div", "dash-jobs-rows");
      for (const row of shown.slice(0, config.limit)) {
        list.append(renderRow(row, now, config.compact, openIds));
      }
      body.append(list);

      const hidden = shown.length - Math.min(shown.length, config.limit);
      if (hidden > 0) body.append(node("p", "dash-jobs-more", `${hidden} more not shown.`));
    };

    ctx.subscribe(ctx.sources.invocations, (next) => {
      snapshot = next;
      render();
    });

    // Times on screen age on their own, and nothing else wakes this panel once
    // the notebook stops changing -- which is exactly when staleness matters.
    // Through onDispose, not the returned dispose: a widget that throws never
    // gets to return one, and this interval would outlive the error card.
    const timer = setInterval(render, TICK_MS);
    ctx.onDispose(() => clearInterval(timer));

    return () => {
      container.textContent = "";
    };
  },
};
