// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attentionMessage,
  countsSentence,
  describeRun,
  findStep,
  foldInvocationState,
  foldJobState,
  formatAgo,
  formatDuration,
  galaxyRunUrl,
  isActiveRun,
  jobsWidget,
  metaLine,
  needsAttention,
  normalizeJobsConfig,
  stateGlyph,
  stateWord,
  toRunRows,
  type JobsConfig,
  type RunRow,
  type RunState,
} from "../app/src/renderer/dashboard/widgets/jobs.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type {
  DataSource,
  DashboardJob,
  InvocationSnapshot,
  WidgetContext,
} from "../app/src/renderer/dashboard/widget-api.js";
import type { Invocation } from "../app/src/renderer/galaxy-invocations.js";

/** A fixed clock, so "1 h 34 m ago" is the same string on every machine. */
const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function invocation(over: Partial<Invocation> = {}): Invocation {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-3",
    label: "Count features",
    submittedAt: ago(2 * HOUR),
    status: "in_progress",
    lastPolledAt: ago(30_000),
    totalSteps: 5,
    completedSteps: 2,
    totalJobs: 12,
    completedJobs: 7,
    failedJobs: 0,
    ...over,
  };
}

function job(over: Partial<DashboardJob> = {}): DashboardJob {
  return {
    jobId: "job-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "BWA alignment",
    toolId: "bwa_mem",
    submittedAt: ago(20 * MINUTE),
    status: "in_progress",
    galaxyState: "running",
    lastPolledAt: ago(30_000),
    ...over,
  };
}

function snapshot(over: Partial<InvocationSnapshot> = {}): InvocationSnapshot {
  return { invocations: [], jobs: [], updatedAt: NOW, ...over };
}

function rowFor(inv: Partial<Invocation>): RunRow {
  return toRunRows(snapshot({ invocations: [invocation(inv)] }), [], NOW)[0];
}

function jobRowFor(over: Partial<DashboardJob>): RunRow {
  return toRunRows(snapshot({ jobs: [job(over)] }), [], NOW)[0];
}

/** The notebook the renderer actually receives, so the parse path is covered too. */
function notebookWith(blocks: string[], plan = ""): string {
  return `# Analysis\n\n${plan}\n\n## Runs\n\n${blocks.join("\n")}\n`;
}

function invocationBlock(fields: Record<string, string | number>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return "```loom-invocation\n" + body + "\n```\n";
}

function jobBlock(fields: Record<string, string | number>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return "```loom-job\n" + body + "\n```\n";
}

// ── Config ───────────────────────────────────────────────────────────────────

describe("jobs widget config", () => {
  it("declares the type and default config the registry and document expect", () => {
    expect(jobsWidget.type).toBe("jobs");
    expect(jobsWidget.defaultConfig).toEqual({ show: "active", limit: 6, compact: false });
  });

  it("repairs a hostile config rather than trusting it", () => {
    expect(normalizeJobsConfig({})).toEqual({ show: "active", limit: 6, compact: false });
    expect(normalizeJobsConfig({ show: "everything", limit: -5, compact: "yes" })).toEqual({
      show: "active",
      limit: 1,
      compact: false,
    });
    expect(normalizeJobsConfig({ limit: 1e9 }).limit).toBe(40);
    expect(normalizeJobsConfig({ limit: "4" }).limit).toBe(6);
    expect(normalizeJobsConfig({ limit: 3.7 }).limit).toBe(3);
    expect(normalizeJobsConfig({ show: "all", compact: true })).toEqual({
      show: "all",
      limit: 6,
      compact: true,
    });
  });
});

// ── State folding ────────────────────────────────────────────────────────────

describe("state folding", () => {
  it("maps every Galaxy job state the brain knows about", () => {
    const cases: Array<[string, RunState]> = [
      ["ok", "finished"],
      ["error", "failed"],
      ["failed", "failed"],
      ["deleted", "cancelled"],
      ["stopped", "cancelled"],
      ["skipped", "skipped"],
      ["running", "running"],
      ["new", "queued"],
      ["queued", "queued"],
      ["waiting", "queued"],
      ["paused", "paused"],
      ["upload", "running"],
      ["setting_metadata", "running"],
      ["resubmitted", "queued"],
    ];
    for (const [state, expected] of cases) {
      expect(foldJobState("in_progress", state), state).toBe(expected);
    }
  });

  it("treats deleting and stop as transitional, not as an outcome", () => {
    expect(foldJobState("in_progress", "deleting")).toBe("stopping");
    expect(foldJobState("in_progress", "stop")).toBe("stopping");
    // Still moving, so still shown as live and still worth watching.
    expect(jobRowFor({ galaxyState: "deleting" }).live).toBe(true);
    expect(jobRowFor({ galaxyState: "stop" }).live).toBe(true);
    expect(needsAttention(jobRowFor({ galaxyState: "deleting" }))).toBe(false);
  });

  it("is case insensitive about Galaxy's state string", () => {
    expect(foldJobState("in_progress", "RUNNING")).toBe("running");
    expect(foldJobState("in_progress", "Paused")).toBe("paused");
  });

  it("keeps watching a state this build has never heard of", () => {
    expect(foldJobState("in_progress", "quantum_superposition")).toBe("unknown");
    const row = jobRowFor({ galaxyState: "quantum_superposition" });
    expect(row.live).toBe(true);
    expect(describeRun(row, NOW)).toContain("does not recognise");
  });

  it("lets the block's own terminal status win over a stale raw state", () => {
    expect(foldJobState("completed", "running")).toBe("finished");
    expect(foldJobState("failed", "running")).toBe("failed");
    expect(foldJobState("cancelled", "running")).toBe("cancelled");
    expect(foldJobState("skipped", "running")).toBe("skipped");
  });

  it("falls back to queued for an in-flight job Galaxy has not been asked about", () => {
    expect(foldJobState("in_progress", null)).toBe("queued");
    expect(describeRun(jobRowFor({ galaxyState: undefined, lastPolledAt: undefined }), NOW)).toBe(
      "Submitted. Waiting for Galaxy's first answer.",
    );
  });

  it("does not invent a state for a status outside the union", () => {
    expect(foldJobState("bogus" as DashboardJob["status"], "running")).toBe("unknown");
    expect(foldInvocationState("bogus" as Invocation["status"])).toBe("unknown");
  });

  it("maps the three invocation statuses", () => {
    expect(foldInvocationState("in_progress")).toBe("running");
    expect(foldInvocationState("completed")).toBe("finished");
    expect(foldInvocationState("failed")).toBe("failed");
  });

  it("gives every state a word and a glyph, so colour is never the only signal", () => {
    const states: RunState[] = [
      "running",
      "queued",
      "stopping",
      "paused",
      "finished",
      "failed",
      "cancelled",
      "skipped",
      "unknown",
    ];
    for (const state of states) {
      expect(stateWord(state), state).toBeTruthy();
      expect(stateGlyph(state), state).toBeTruthy();
    }
    expect(stateWord("nonsense" as RunState)).toBe("Working");
    expect(stateGlyph("nonsense" as RunState)).toBe("?");
  });
});

// ── Counts ───────────────────────────────────────────────────────────────────

describe("job counts", () => {
  it("reads the counters the invocation block carries", () => {
    expect(rowFor({}).jobs).toEqual({ done: 7, failed: 0, total: 12 });
    expect(rowFor({}).steps).toEqual({ done: 2, total: 5 });
  });

  it("believes the parts when a hand-edited block's total is too small", () => {
    expect(rowFor({ totalJobs: 12, completedJobs: 10, failedJobs: 5 }).jobs).toEqual({
      done: 10,
      failed: 5,
      total: 15,
    });
  });

  it("drops negative, fractional and missing counters instead of rendering them", () => {
    expect(rowFor({ totalJobs: -4, completedJobs: undefined, failedJobs: 2.9 }).jobs).toEqual({
      done: 0,
      failed: 2,
      total: 2,
    });
    expect(rowFor({ totalSteps: undefined }).steps).toBeNull();
    expect(rowFor({ totalSteps: 3, completedSteps: 9 }).steps).toEqual({ done: 3, total: 3 });
  });

  it("says the counts in words, and says none rather than zero", () => {
    expect(countsSentence(rowFor({}))).toBe("7 of 12 jobs done, none failed");
    expect(countsSentence(rowFor({ failedJobs: 2 }))).toBe("7 of 12 jobs done, 2 failed");
    // One job is its own progress report.
    expect(countsSentence(jobRowFor({}))).toBe("");
    expect(countsSentence(rowFor({ totalJobs: undefined, completedJobs: undefined }))).toBe("");
  });
});

// ── Elapsed time ─────────────────────────────────────────────────────────────

describe("elapsed formatting", () => {
  it("reads like a person wrote it at every scale", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(8 * MINUTE)).toBe("8 m");
    expect(formatDuration(59 * MINUTE + 59_000)).toBe("59 m");
    expect(formatDuration(HOUR)).toBe("1 h 00 m");
    expect(formatDuration(HOUR + 34 * MINUTE)).toBe("1 h 34 m");
    expect(formatDuration(6 * DAY + 2 * HOUR)).toBe("6 d 2 h");
  });

  it("refuses a nonsense duration rather than printing one", () => {
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(NaN)).toBe("");
    expect(formatDuration(Infinity)).toBe("");
  });

  it("never prints a negative age when a server clock runs ahead", () => {
    expect(formatAgo(NOW + 5 * MINUTE, NOW)).toBe("just now");
    expect(formatAgo(NOW - HOUR, NOW)).toBe("1 h 00 m ago");
    expect(formatAgo(null, NOW)).toBe("");
  });

  it("drops a timestamp that will not parse instead of rendering Invalid Date", () => {
    const row = rowFor({ submittedAt: "not a date", lastPolledAt: "also not a date" });
    expect(row.submittedAt).toBeNull();
    expect(row.lastPolledAt).toBeNull();
    expect(metaLine(row, NOW)).not.toContain("NaN");
    expect(metaLine(row, NOW)).not.toContain("Invalid");
  });

  it("says when Galaxy was last asked, not just how long the run has been going", () => {
    const line = metaLine(rowFor({ submittedAt: ago(2 * HOUR), lastPolledAt: ago(40_000) }), NOW);
    expect(line).toContain("started 2 h 00 m ago");
    expect(line).toContain("checked 40 s ago");
    expect(line).toContain("usegalaxy.org");
  });

  it("says a live run has not been checked at all rather than staying silent", () => {
    expect(metaLine(rowFor({ lastPolledAt: undefined }), NOW)).toContain("not checked yet");
    // A terminal run was checked when it ended; the absence says nothing.
    expect(metaLine(rowFor({ status: "completed", lastPolledAt: undefined }), NOW)).not.toContain(
      "not checked yet",
    );
  });

  it("flags a block Galaxy never confirmed", () => {
    expect(metaLine(rowFor({ serverVerified: false }), NOW)).toContain("unconfirmed by Galaxy");
    expect(metaLine(rowFor({ serverVerified: true }), NOW)).not.toContain("unconfirmed");
    expect(metaLine(rowFor({ serverVerified: undefined }), NOW)).not.toContain("unconfirmed");
  });
});

// ── Staleness ────────────────────────────────────────────────────────────────

describe("staleness", () => {
  it("stops believing an invocation nobody has polled in minutes", () => {
    expect(rowFor({ lastPolledAt: ago(30_000) }).stale).toBe(false);
    expect(rowFor({ lastPolledAt: ago(30 * MINUTE) }).stale).toBe(true);
    expect(rowFor({ lastPolledAt: undefined, submittedAt: ago(6 * DAY) }).stale).toBe(true);
  });

  it("leads with the staleness rather than the number it cannot vouch for", () => {
    const row = rowFor({ lastPolledAt: ago(6 * DAY) });
    expect(describeRun(row, NOW)).toBe(
      "Can't tell right now. Galaxy was last checked 6 d 0 h ago.",
    );
  });

  it("never calls a finished run stale -- nothing is going to move it", () => {
    expect(rowFor({ status: "completed", lastPolledAt: ago(6 * DAY) }).stale).toBe(false);
    expect(rowFor({ status: "failed", lastPolledAt: ago(6 * DAY) }).stale).toBe(false);
  });

  it("does not call a running job stale, because its timestamp is not a heartbeat", () => {
    // tickJobs polls a running job every 15s but only writes on a transition,
    // so last_polled_at freezes at the first poll for the whole run.
    const row = jobRowFor({ lastPolledAt: ago(2 * HOUR) });
    expect(row.live).toBe(true);
    expect(row.stale).toBe(false);
    expect(describeRun(row, NOW)).toContain("Running");
  });
});

// ── Sentences ────────────────────────────────────────────────────────────────

describe("plain-language status", () => {
  it("leads with the failure when one is still in flight", () => {
    const row = rowFor({ status: "in_progress", completedJobs: 7, failedJobs: 2, totalJobs: 12 });
    expect(describeRun(row, NOW)).toBe("2 jobs have failed. 7 finished, 3 still going.");
  });

  it("uses the singular for one failed job", () => {
    const row = rowFor({ status: "in_progress", completedJobs: 7, failedJobs: 1, totalJobs: 12 });
    expect(describeRun(row, NOW)).toBe("1 job has failed. 7 finished, 4 still going.");
  });

  it("says what happened for every terminal outcome", () => {
    expect(describeRun(rowFor({ status: "failed", failedJobs: 2, completedJobs: 10 }), NOW)).toBe(
      "Failed -- 2 of 12 jobs errored, 10 succeeded.",
    );
    expect(describeRun(rowFor({ status: "completed", completedJobs: 12 }), NOW)).toBe(
      "Finished -- all 12 jobs succeeded.",
    );
    expect(describeRun(jobRowFor({ status: "completed" }), NOW)).toBe("Finished.");
    expect(describeRun(jobRowFor({ status: "cancelled" }), NOW)).toBe(
      "Cancelled. It produced no outputs.",
    );
    expect(describeRun(jobRowFor({ status: "skipped" }), NOW)).toBe(
      "Skipped. Its step's condition was not met.",
    );
  });

  it("never says Failed without a because-clause", () => {
    expect(describeRun(jobRowFor({ status: "failed" }), NOW)).toBe(
      "Failed. Ask the agent what Galaxy reported.",
    );
  });

  it("admits it has no counts rather than drawing a zero bar", () => {
    const row = rowFor({ totalJobs: undefined, completedJobs: undefined, failedJobs: undefined });
    expect(describeRun(row, NOW)).toBe("Running. Galaxy has not reported any job counts yet.");
  });

  it("says a paused run needs the user, and a stopping one is still stopping", () => {
    expect(describeRun(jobRowFor({ galaxyState: "paused" }), NOW)).toContain("needs you");
    expect(describeRun(jobRowFor({ galaxyState: "deleting" }), NOW)).toBe(
      "Stopping. Galaxy is still shutting this down.",
    );
  });
});

// ── Attention ────────────────────────────────────────────────────────────────

describe("the failure strip", () => {
  it("stays empty when nothing has failed", () => {
    expect(attentionMessage(toRunRows(snapshot({ invocations: [invocation()] }), [], NOW))).toBe(
      "",
    );
  });

  it("names the run and the plan step it is bound to", () => {
    const plan =
      "## Plan A: chrM\n\n- [ ] 3. **Count features** {#plan-a-step-3} -- twelve samples";
    const sources = new DashboardSources();
    sources.setNotebook(
      notebookWith(
        [
          invocationBlock({
            invocation_id: "inv-1",
            galaxy_server_url: "https://usegalaxy.org",
            notebook_anchor: "plan-a-step-3",
            label: "Count features",
            submitted_at: ago(2 * HOUR),
            status: "in_progress",
            total_jobs: 12,
            completed_jobs: 10,
            failed_jobs: 2,
            last_polled_at: ago(30_000),
          }),
        ],
        plan,
      ),
    );
    const rows = toRunRows(
      sources.sources.invocations.get(),
      sources.sources.plan.get().plans,
      NOW,
    );
    expect(attentionMessage(rows)).toBe(
      '2 of 12 jobs failed in "Count features" (step 3, Count features).',
    );
  });

  it("counts across runs when several failed", () => {
    const rows = toRunRows(
      snapshot({
        invocations: [
          invocation({ invocationId: "a", status: "failed", failedJobs: 2 }),
          invocation({ invocationId: "b", status: "failed", failedJobs: 3 }),
        ],
      }),
      [],
      NOW,
    );
    expect(attentionMessage(rows)).toBe("5 jobs failed across 2 runs.");
  });

  it("still reports a failed run that carries no counters", () => {
    const rows = toRunRows(snapshot({ jobs: [job({ status: "failed" })] }), [], NOW);
    expect(attentionMessage(rows)).toBe('"BWA alignment" failed.');
  });
});

// ── Ordering and filtering ───────────────────────────────────────────────────

describe("ordering", () => {
  it("puts failures first, then what needs the user, then what is moving", () => {
    const rows = toRunRows(
      snapshot({
        invocations: [
          invocation({ invocationId: "done", status: "completed", submittedAt: ago(MINUTE) }),
          invocation({ invocationId: "run", status: "in_progress", submittedAt: ago(3 * HOUR) }),
          invocation({
            invocationId: "bad",
            status: "in_progress",
            failedJobs: 1,
            submittedAt: ago(9 * HOUR),
          }),
        ],
        jobs: [job({ jobId: "held", galaxyState: "paused", submittedAt: ago(5 * HOUR) })],
      }),
      [],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["bad", "held", "run", "done"]);
  });

  it("orders newest first inside a band, with the id as a stable tiebreak", () => {
    const at = ago(HOUR);
    const rows = toRunRows(
      snapshot({
        invocations: [
          invocation({ invocationId: "b", submittedAt: at }),
          invocation({ invocationId: "a", submittedAt: at }),
          invocation({ invocationId: "newer", submittedAt: ago(MINUTE) }),
        ],
      }),
      [],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["newer", "a", "b"]);
  });

  it("sorts a block with an unparseable timestamp to the back of its band", () => {
    const rows = toRunRows(
      snapshot({
        invocations: [
          invocation({ invocationId: "broken", submittedAt: "whenever" }),
          invocation({ invocationId: "real", submittedAt: ago(9 * DAY) }),
        ],
      }),
      [],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["real", "broken"]);
  });

  it("keeps a failed run visible under the active filter and hides a finished one", () => {
    expect(isActiveRun(rowFor({ status: "in_progress" }))).toBe(true);
    expect(isActiveRun(rowFor({ status: "failed" }))).toBe(true);
    expect(isActiveRun(rowFor({ status: "in_progress", failedJobs: 1 }))).toBe(true);
    expect(isActiveRun(rowFor({ status: "completed" }))).toBe(false);
    expect(isActiveRun(jobRowFor({ status: "cancelled" }))).toBe(false);
    expect(isActiveRun(jobRowFor({ status: "skipped" }))).toBe(false);
    expect(isActiveRun(jobRowFor({ galaxyState: "deleting" }))).toBe(true);
  });
});

// ── Plan binding ─────────────────────────────────────────────────────────────

describe("the plan step a run is bound to", () => {
  const sources = new DashboardSources();
  const plan = [
    "## Plan A: chrM",
    "",
    "- [x] 1. **Quality control** {#plan-a-step-1} -- fastp",
    "- [ ] 3. **Count features** {#plan-a-step-3} -- twelve samples",
    "",
    "## Plan B: reruns",
    "",
    "- [ ] 1. **Realign** -- no anchor of its own",
  ].join("\n");
  sources.setNotebook(notebookWith([], plan));
  const plans = sources.sources.plan.get().plans;

  it("matches an explicit {#...} anchor", () => {
    expect(findStep(plans, "plan-a-step-3")).toEqual({ number: 3, title: "Count features" });
  });

  it("matches the positional address derived for a step with no marker", () => {
    expect(findStep(plans, "plan-b-step-1")).toEqual({ number: 1, title: "Realign" });
  });

  it("returns nothing rather than guessing when the anchor names no step", () => {
    expect(findStep(plans, "results")).toBeNull();
    expect(findStep(plans, "")).toBeNull();
    expect(findStep([], "plan-a-step-3")).toBeNull();
  });
});

// ── Link out ─────────────────────────────────────────────────────────────────

describe("the Galaxy link", () => {
  it("points an invocation at the invocation view and a job at the job view", () => {
    expect(galaxyRunUrl(rowFor({}))).toBe("https://usegalaxy.org/workflows/invocations/inv-1");
    expect(galaxyRunUrl(jobRowFor({}))).toBe("https://usegalaxy.org/jobs/job-1/view");
  });

  it("keeps a path prefix the configured server carries", () => {
    expect(galaxyRunUrl(rowFor({ galaxyServerUrl: "https://example.org/galaxy" }))).toBe(
      "https://example.org/galaxy/workflows/invocations/inv-1",
    );
    expect(galaxyRunUrl(rowFor({ galaxyServerUrl: "https://example.org/galaxy/" }))).toBe(
      "https://example.org/galaxy/workflows/invocations/inv-1",
    );
  });

  it("refuses anything that is not http(s), because the notebook is not trusted", () => {
    expect(galaxyRunUrl(rowFor({ galaxyServerUrl: "javascript:alert(1)" }))).toBeNull();
    expect(galaxyRunUrl(rowFor({ galaxyServerUrl: "file:///etc/passwd" }))).toBeNull();
    expect(galaxyRunUrl(rowFor({ galaxyServerUrl: "not a url" }))).toBeNull();
    expect(galaxyRunUrl(rowFor({ galaxyServerUrl: "" }))).toBeNull();
  });

  it("cannot be walked out of the server with a crafted id", () => {
    const url = galaxyRunUrl(rowFor({ invocationId: "../../admin" }));
    expect(url).toBe("https://usegalaxy.org/workflows/invocations/..%2F..%2Fadmin");
    expect(new URL(url as string).origin).toBe("https://usegalaxy.org");
  });

  it("shows the host, not the whole URL, in the meta line", () => {
    expect(rowFor({ galaxyServerUrl: "https://usegalaxy.eu/" }).serverHost).toBe("usegalaxy.eu");
    expect(rowFor({ galaxyServerUrl: "not a url" }).serverHost).toBe("not a url");
  });
});

// ── Mounted ──────────────────────────────────────────────────────────────────

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext<JobsConfig>;
  sources: DashboardSources;
  setConfig: ReturnType<typeof vi.fn>;
  cleanups: Array<() => void>;
  offs: Array<() => void>;
}

function harness(config: Partial<JobsConfig> = {}): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  const sources = new DashboardSources();
  const cleanups: Array<() => void> = [];
  const offs: Array<() => void> = [];
  const setConfig = vi.fn();
  const ctx = {
    panelId: "p-jobs",
    config: { ...jobsWidget.defaultConfig, ...config },
    sources: sources.sources,
    header,
    setConfig,
    fail: vi.fn(),
    onDispose(fn: () => void) {
      cleanups.push(fn);
    },
    subscribe<T>(source: DataSource<T>, listener: (value: T) => void) {
      const off = source.subscribe(listener);
      offs.push(off);
      listener(source.get());
      return off;
    },
  } as unknown as WidgetContext<JobsConfig>;
  return { el, header, ctx, sources, setConfig, cleanups, offs };
}

function teardown(h: Harness, dispose?: (() => void) | void): void {
  dispose?.();
  h.cleanups.forEach((fn) => fn());
  h.offs.forEach((fn) => fn());
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mounted jobs widget", () => {
  it("explains itself instead of drawing a blank panel", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    expect(h.el.textContent).toContain("Nothing is running on Galaxy right now.");
    expect(h.el.textContent).toContain("appear here as soon as the agent starts one");
    teardown(h, dispose);
  });

  it("renders a workflow run from the notebook the brain pushed", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "plan-a-step-3",
          label: "Count features",
          submitted_at: ago(2 * HOUR),
          status: "in_progress",
          total_steps: 5,
          completed_steps: 2,
          total_jobs: 12,
          completed_jobs: 7,
          failed_jobs: 0,
          last_polled_at: ago(40_000),
        }),
      ]),
    );
    expect(h.el.textContent).toContain("Count features");
    expect(h.el.textContent).toContain("Running -- 7 of 12 jobs done, none failed.");
    expect(h.el.textContent).toContain("2 of 5 steps");
    expect(h.el.textContent).toContain("checked 40 s ago");
    expect(h.el.querySelector("a.dash-jobs-link")?.getAttribute("href")).toBe(
      "https://usegalaxy.org/workflows/invocations/inv-1",
    );
    teardown(h, dispose);
  });

  it("renders a single tool run, which is all a workflow-free session has", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        jobBlock({
          job_id: "job-9",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "plan-a-step-1",
          label: "BWA alignment",
          tool_id: "bwa_mem",
          submitted_at: ago(20 * MINUTE),
          status: "in_progress",
          galaxy_state: "running",
        }),
      ]),
    );
    expect(h.el.textContent).toContain("BWA alignment");
    expect(h.el.querySelector("a.dash-jobs-link")?.getAttribute("href")).toBe(
      "https://usegalaxy.org/jobs/job-9/view",
    );
    teardown(h, dispose);
  });

  it("makes a failure impossible to miss and says which step", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith(
        [
          invocationBlock({
            invocation_id: "inv-1",
            galaxy_server_url: "https://usegalaxy.org",
            notebook_anchor: "plan-a-step-3",
            label: "Count features",
            submitted_at: ago(2 * HOUR),
            status: "failed",
            total_jobs: 12,
            completed_jobs: 10,
            failed_jobs: 2,
            summary: '"Workflow failed: 2 job(s) errored, 10 succeeded"',
            last_polled_at: ago(20 * MINUTE),
          }),
        ],
        "## Plan A: chrM\n\n- [!] 3. **Count features** {#plan-a-step-3} -- twelve samples",
      ),
    );
    const alert = h.el.querySelector(".dash-jobs-alert") as HTMLElement;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('2 of 12 jobs failed in "Count features" (step 3');
    expect(alert.getAttribute("role")).toBe("status");
    const row = h.el.querySelector(".dash-jobs-row") as HTMLElement;
    expect(row.classList.contains("is-failed")).toBe(true);
    // The brain's own note is shown, not paraphrased.
    expect(h.el.textContent).toContain("Workflow failed: 2 job(s) errored, 10 succeeded");
    teardown(h, dispose);
  });

  it("hides the strip again once the failure is gone", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    const block = (failed: number, status: string): string =>
      invocationBlock({
        invocation_id: "inv-1",
        galaxy_server_url: "https://usegalaxy.org",
        notebook_anchor: "plan-a-step-3",
        label: "Count features",
        submitted_at: ago(2 * HOUR),
        status,
        total_jobs: 12,
        completed_jobs: 10,
        failed_jobs: failed,
        last_polled_at: ago(20_000),
      });
    h.sources.setNotebook(notebookWith([block(2, "in_progress")]));
    expect((h.el.querySelector(".dash-jobs-alert") as HTMLElement).hidden).toBe(false);
    h.sources.setNotebook(notebookWith([block(0, "in_progress")]));
    expect((h.el.querySelector(".dash-jobs-alert") as HTMLElement).hidden).toBe(true);
    teardown(h, dispose);
  });

  it("puts a count badge and a filter toggle in the panel header", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    const badge = h.header.querySelector(".dash-jobs-count") as HTMLElement;
    const button = h.header.querySelector("button") as HTMLButtonElement;
    expect(badge.textContent).toBe("0");
    expect(badge.classList.contains("zero")).toBe(true);
    expect(button.textContent).toBe("active");

    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "in_progress",
          last_polled_at: ago(20_000),
        }),
      ]),
    );
    expect(badge.textContent).toBe("1");
    expect(badge.classList.contains("zero")).toBe(false);

    button.click();
    expect(h.setConfig).toHaveBeenCalledWith({ show: "all" });
    teardown(h, dispose);
  });

  it("turns the badge red and counts the failures instead of the runs", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "failed",
          total_jobs: 4,
          failed_jobs: 2,
          last_polled_at: ago(20_000),
        }),
      ]),
    );
    const badge = h.header.querySelector(".dash-jobs-count") as HTMLElement;
    expect(badge.textContent).toBe("1");
    expect(badge.classList.contains("bad")).toBe(true);
    teardown(h, dispose);
  });

  it("offers a way back to runs the active filter is hiding", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "completed",
          last_polled_at: ago(20 * MINUTE),
        }),
      ]),
    );
    expect(h.el.textContent).toContain("One finished run is hidden.");
    (h.el.querySelector(".dash-jobs-empty button") as HTMLButtonElement).click();
    expect(h.setConfig).toHaveBeenCalledWith({ show: "all" });
    teardown(h, dispose);
  });

  it("shows the finished run under show: all", () => {
    const h = harness({ show: "all" });
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "completed",
          total_jobs: 4,
          completed_jobs: 4,
          last_polled_at: ago(20 * MINUTE),
        }),
      ]),
    );
    expect(h.el.textContent).toContain("Finished -- all 4 jobs succeeded.");
    expect(h.header.querySelector("button")?.textContent).toBe("all");
    teardown(h, dispose);
  });

  it("caps the rows it draws and says how many it left out", () => {
    const h = harness({ limit: 2 });
    const dispose = jobsWidget.mount(h.el, h.ctx);
    const blocks = [1, 2, 3, 4].map((n) =>
      invocationBlock({
        invocation_id: `inv-${n}`,
        galaxy_server_url: "https://usegalaxy.org",
        notebook_anchor: "a",
        label: `Run ${n}`,
        submitted_at: ago(n * HOUR),
        status: "in_progress",
        last_polled_at: ago(20_000),
      }),
    );
    h.sources.setNotebook(notebookWith(blocks));
    expect(h.el.querySelectorAll(".dash-jobs-row").length).toBe(2);
    expect(h.el.textContent).toContain("2 more not shown.");
    teardown(h, dispose);
  });

  it("drops the bar, the sentence and the link in compact mode", () => {
    const h = harness({ compact: true });
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "in_progress",
          total_jobs: 12,
          completed_jobs: 7,
          last_polled_at: ago(20_000),
        }),
      ]),
    );
    expect(h.el.querySelector(".dash-jobs-bar")).toBeNull();
    expect(h.el.querySelector(".dash-jobs-say")).toBeNull();
    expect(h.el.querySelector(".dash-jobs-link")).toBeNull();
    // The state and the counts still have to be there.
    expect(h.el.textContent).toContain("Running");
    expect(h.el.textContent).toContain("Count features");
    teardown(h, dispose);
  });

  it("draws a failed segment in the bar and describes it for a screen reader", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "failed",
          total_jobs: 12,
          completed_jobs: 10,
          failed_jobs: 2,
          last_polled_at: ago(20_000),
        }),
      ]),
    );
    const bar = h.el.querySelector(".dash-jobs-bar") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe("10 of 12 jobs finished, 2 failed");
    expect((bar.querySelector(".dash-jobs-bar-fail") as HTMLElement).style.width).toBe("16.7%");
    teardown(h, dispose);
  });

  it("does not present a stale run in the colour of the state it cannot vouch for", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(7 * DAY),
          status: "in_progress",
          total_jobs: 12,
          completed_jobs: 7,
          last_polled_at: ago(6 * DAY),
        }),
      ]),
    );
    const state = h.el.querySelector(".dash-jobs-state") as HTMLElement;
    expect(state.className).toContain("state-unknown");
    expect(state.textContent).toContain("Can't tell");
    expect(h.el.textContent).toContain("Galaxy was last checked 6 d 0 h ago");
    teardown(h, dispose);
  });

  it("writes every value from the notebook as text, never as markup", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: '"<img src=x onerror=alert(1)>"',
          submitted_at: ago(HOUR),
          status: "in_progress",
          last_polled_at: ago(20_000),
        }),
      ]),
    );
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.textContent).toContain("<img src=x onerror=alert(1)>");
    teardown(h, dispose);
  });

  it("keeps a disclosure the user opened open across a notebook rewrite", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    const block = (done: number): string =>
      invocationBlock({
        invocation_id: "inv-1",
        galaxy_server_url: "https://usegalaxy.org",
        notebook_anchor: "a",
        label: "Count features",
        submitted_at: ago(HOUR),
        status: "in_progress",
        total_jobs: 12,
        completed_jobs: done,
        last_polled_at: ago(20_000),
      });
    h.sources.setNotebook(notebookWith([block(7)]));
    const details = h.el.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    h.sources.setNotebook(notebookWith([block(8)]));
    expect((h.el.querySelector("details") as HTMLDetailsElement).open).toBe(true);
    teardown(h, dispose);
  });

  it("repaints the relative times without anything new arriving", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "in_progress",
          last_polled_at: ago(20_000),
        }),
      ]),
    );
    expect(h.el.textContent).toContain("checked 20 s ago");
    vi.setSystemTime(NOW + 10 * MINUTE);
    vi.advanceTimersByTime(10 * MINUTE);
    // The panel now admits it has not heard from Galaxy, rather than still
    // saying "checked 20 s ago" ten minutes later.
    expect(h.el.textContent).toContain("Can't tell right now");
    teardown(h, dispose);
  });

  it("registers its timer through onDispose, so a failure still tears it down", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    expect(h.cleanups.length).toBeGreaterThan(0);
    const before = vi.getTimerCount();
    h.cleanups.forEach((fn) => fn());
    expect(vi.getTimerCount()).toBeLessThan(before);
    teardown(h, dispose);
  });

  it("empties its element on dispose", () => {
    const h = harness();
    const dispose = jobsWidget.mount(h.el, h.ctx);
    h.sources.setNotebook(
      notebookWith([
        invocationBlock({
          invocation_id: "inv-1",
          galaxy_server_url: "https://usegalaxy.org",
          notebook_anchor: "a",
          label: "Count features",
          submitted_at: ago(HOUR),
          status: "in_progress",
          last_polled_at: ago(20_000),
        }),
      ]),
    );
    teardown(h, dispose);
    expect(h.el.textContent).toBe("");
  });

  it("adds its stylesheet once, however many panels mount it", () => {
    const a = harness();
    const b = harness();
    const d1 = jobsWidget.mount(a.el, a.ctx);
    const d2 = jobsWidget.mount(b.el, b.ctx);
    expect(document.querySelectorAll("#dash-jobs-style").length).toBe(1);
    teardown(a, d1);
    teardown(b, d2);
  });
});
