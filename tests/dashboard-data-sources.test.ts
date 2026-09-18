// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  DashboardSources,
  parseActivityLines,
  parsePlanSections,
} from "../app/src/renderer/dashboard/data-sources.js";

const NOTEBOOK = `# Analysis

## Plan A: chrM Variant Calling [hybrid]

Question: how do mtDNA variants distribute across tissues?

### Steps

- [x] 1. **QC FASTQ** {#plan-a-step-1} \u2014 fastp adapter trim + per-base QC
  - Routing: local
  - Verification: confirm the fastp report exists
- [ ] 2. **Read alignment** {#plan-a-step-2} \u2014 bwa mem PE 4 samples
  - Routing: Galaxy (bwa-mem2/2.2.1)
- [!] 3. **Variant calling** {#plan-a-step-3} \u2014 freebayes

## Results

Not a plan section.

- [ ] this checkbox is outside any plan

## Plan B: Follow-up [galaxy]

- [ ] Draft the comparison

\`\`\`loom-invocation
invocation_id: inv-1
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-2
label: bwa alignment
submitted_at: 2026-09-18T05:00:00Z
status: in_progress
total_jobs: 4
completed_jobs: 1
\`\`\`
`;

describe("parsePlanSections", () => {
  it("finds every plan heading and stops at the next h2", () => {
    const plans = parsePlanSections(NOTEBOOK);
    expect(plans.map((p) => p.id)).toEqual(["plan-a", "plan-b"]);
    expect(plans[0].steps).toHaveLength(3);
    // The checkbox under "## Results" belongs to no plan and must not be stolen.
    expect(plans[1].steps.map((s) => s.title)).toEqual(["Draft the comparison"]);
  });

  it("reads the routing tag off the heading and trims it from the title", () => {
    const [planA, planB] = parsePlanSections(NOTEBOOK);
    expect(planA.routing).toBe("hybrid");
    expect(planA.title).toBe("Plan A: chrM Variant Calling");
    expect(planB.routing).toBe("galaxy");
  });

  it("maps the three checkbox markers to statuses", () => {
    const steps = parsePlanSections(NOTEBOOK)[0].steps;
    expect(steps.map((s) => s.status)).toEqual(["done", "pending", "failed"]);
  });

  it("pulls anchor, number, title and detail off a step line", () => {
    const step = parsePlanSections(NOTEBOOK)[0].steps[1];
    expect(step).toMatchObject({
      anchor: "plan-a-step-2",
      number: 2,
      title: "Read alignment",
      detail: "bwa mem PE 4 samples",
    });
  });

  it("attaches a Routing sub-bullet to the step above it", () => {
    const steps = parsePlanSections(NOTEBOOK)[0].steps;
    expect(steps[0].routing).toBe("local");
    expect(steps[1].routing).toBe("Galaxy (bwa-mem2/2.2.1)");
    expect(steps[2].routing).toBeNull();
  });

  it("copes with a hand-edited step that has no number, anchor or bold", () => {
    const plans = parsePlanSections("## Plan C: Ad hoc\n\n- [ ] just do the thing -- somehow\n");
    expect(plans[0].steps[0]).toMatchObject({
      anchor: null,
      number: 1,
      title: "just do the thing",
      detail: "somehow",
    });
  });

  it("returns nothing for a notebook with no plans", () => {
    expect(parsePlanSections("# Notes\n\nnothing here\n")).toEqual([]);
    expect(parsePlanSections("")).toEqual([]);
  });
});

describe("parseActivityLines", () => {
  it("skips blank and unparsable lines instead of throwing", () => {
    const events = parseActivityLines(
      [
        '{"timestamp":"t1","kind":"prompt","source":"user","payload":{"a":1}}',
        "",
        "not json",
        "[]",
      ].join("\n"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ timestamp: "t1", kind: "prompt", source: "user" });
  });

  it("defaults the fields a line is missing", () => {
    const [event] = parseActivityLines("{}");
    expect(event).toEqual({ timestamp: "", kind: "event", source: "", payload: {} });
  });

  it("keeps only the newest 200 events", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `{"kind":"e${i}"}`).join("\n");
    const events = parseActivityLines(lines);
    expect(events).toHaveLength(200);
    expect(events[events.length - 1].kind).toBe("e249");
  });
});

describe("DashboardSources", () => {
  it("derives invocations and plan steps from one notebook push", () => {
    const sources = new DashboardSources();
    sources.setNotebook(NOTEBOOK, "/tmp/a/notebook.md");

    expect(sources.sources.notebook.get().path).toBe("/tmp/a/notebook.md");
    expect(sources.sources.invocations.get().invocations.map((i) => i.invocationId)).toEqual([
      "inv-1",
    ]);
    expect(sources.sources.plan.get().plans).toHaveLength(2);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const sources = new DashboardSources();
    const seen: number[] = [];
    const off = sources.sources.plan.subscribe((snap) => seen.push(snap.plans.length));
    sources.setNotebook(NOTEBOOK);
    off();
    sources.setNotebook("## Plan Z: Later\n");
    expect(seen).toEqual([2]);
  });

  it("keeps fanning out when one subscriber throws", () => {
    const sources = new DashboardSources();
    let reached = false;
    sources.sources.notebook.subscribe(() => {
      throw new Error("boom");
    });
    sources.sources.notebook.subscribe(() => {
      reached = true;
    });
    sources.setNotebook("hello");
    expect(reached).toBe(true);
  });

  it("reports activity and files as unavailable when the shell has no file surface", async () => {
    const sources = new DashboardSources({});
    await sources.refreshActivity();
    await sources.refreshFiles();
    expect(sources.sources.activity.get().available).toBe(false);
    expect(sources.sources.files.get().available).toBe(false);
  });

  it("reads the activity tail when the shell does have one", async () => {
    const bytes = new TextEncoder().encode('{"kind":"tool_call","source":"bash"}');
    const sources = new DashboardSources({
      readFile: async () => ({ ok: true, bytes }),
    });
    await sources.refreshActivity();
    const snap = sources.sources.activity.get();
    expect(snap.available).toBe(true);
    expect(snap.events[0].kind).toBe("tool_call");
  });

  it("stays unavailable when the shell's file read rejects", async () => {
    const sources = new DashboardSources({
      readFile: () => Promise.reject(new Error("nope")),
    });
    await sources.refreshActivity();
    expect(sources.sources.activity.get().available).toBe(false);
  });

  it("discards a pulled read that was in flight when the directory changed", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = new TextEncoder().encode('{"kind":"from_the_old_workspace"}');
    const sources = new DashboardSources({
      readFile: async () => {
        await gate;
        return { ok: true, bytes };
      },
    });

    const inFlight = sources.refreshActivity();
    sources.reset();
    release!();
    await inFlight;

    expect(sources.sources.activity.get().events).toEqual([]);
    expect(sources.sources.activity.get().available).toBe(false);
  });

  it("clears every source on a cwd switch", () => {
    const sources = new DashboardSources();
    sources.setNotebook(NOTEBOOK);
    sources.setSession({ cwd: "/tmp/a", status: "running" });
    sources.reset();
    expect(sources.sources.notebook.get().markdown).toBe("");
    expect(sources.sources.invocations.get().invocations).toEqual([]);
    expect(sources.sources.plan.get().plans).toEqual([]);
    expect(sources.sources.session.get().cwd).toBe("");
    expect(sources.sources.session.get().status).toBe("unknown");
  });
});
