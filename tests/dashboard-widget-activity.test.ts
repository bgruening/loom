// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityWidget,
  buildRows,
  formatDetail,
  formatEventDay,
  formatEventTime,
  isAtBottom,
  normalizeBool,
  normalizeKinds,
  normalizeMaxEntries,
  redactForDisplay,
  statusWord,
  summarizeEvent,
  truncate,
  type ActivityConfig,
} from "../app/src/renderer/dashboard/widgets/activity.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type {
  ActivityEvent,
  DataSource,
  WidgetContext,
} from "../app/src/renderer/dashboard/widget-api.js";

// -- helpers -----------------------------------------------------------------

function event(
  kind: string,
  payload: Record<string, unknown> = {},
  over: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    timestamp: "2026-09-18T10:11:12.000Z",
    kind,
    source: "agent",
    payload,
    ...over,
  };
}

function summaryOf(e: ActivityEvent): string {
  return summarizeEvent(e).text;
}

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext<ActivityConfig>;
  sources: DashboardSources;
  setConfig: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  cleanups: Array<() => void>;
  /** Push a snapshot into the activity source the widget is subscribed to. */
  emit(events: ActivityEvent[], available?: boolean): void;
  scroller(): HTMLElement;
  rows(): HTMLElement[];
}

function harness(config: Partial<ActivityConfig> = {}): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  const sources = new DashboardSources();
  const cleanups: Array<() => void> = [];
  const setConfig = vi.fn();
  const fail = vi.fn();
  const ctx = {
    panelId: "p-activity",
    config: { ...activityWidget.defaultConfig, ...config },
    sources: sources.sources,
    header,
    setConfig,
    fail,
    onDispose(fn: () => void) {
      cleanups.push(fn);
    },
    subscribe<T>(source: DataSource<T>, listener: (value: T) => void) {
      const off = source.subscribe(listener);
      listener(source.get());
      return off;
    },
  } as WidgetContext<ActivityConfig>;

  // The activity source is fed by a shell file read, which there is no shell
  // for here, so drive its private MutableSource the way the shell would.
  const emit = (events: ActivityEvent[], available = true): void => {
    (sources.sources.activity as unknown as { set(v: unknown): void }).set({
      events,
      available,
      updatedAt: Date.now(),
    });
  };

  return {
    el,
    header,
    ctx,
    sources,
    setConfig,
    fail,
    cleanups,
    emit,
    scroller: () => el.querySelector(".dash-activity-scroll") as HTMLElement,
    rows: () => [...el.querySelectorAll(".dash-activity-row")] as HTMLElement[],
  };
}

function textOf(h: Harness): string {
  return h.el.textContent ?? "";
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.querySelector("#dash-activity-styles")?.remove();
});

// -- contract ----------------------------------------------------------------

describe("activity widget contract", () => {
  it("keeps the type and label the registry and the layout document expect", () => {
    expect(activityWidget.type).toBe("activity");
    expect(activityWidget.label).toBe("Analysis log");
    expect(activityWidget.defaultConfig).toEqual({
      kinds: "all",
      maxEntries: 200,
      showDetail: true,
    });
  });
});

// -- one sentence per kind ---------------------------------------------------

describe("summarizeEvent", () => {
  it("names the analysis directory when the session starts", () => {
    const out = summarizeEvent(event("session.started", { cwd: "/home/ann/rnaseq-liver" }));
    expect(out.text).toBe("Opened this analysis in rnaseq-liver");
    expect(out.tone).toBe("info");
  });

  it("quotes the prompt back", () => {
    const out = summarizeEvent(
      event("user.prompt", { text: "align these reads" }, { source: "user" }),
    );
    expect(out.text).toBe("You asked: align these reads");
  });

  it("does not claim the user typed a prompt that came from somewhere else", () => {
    expect(summaryOf(event("user.prompt", { text: "go on" }, { source: "hook" }))).toBe(
      "A prompt arrived: go on",
    );
  });

  it("reads a tool start and a tool end", () => {
    expect(summaryOf(event("tool.start", { toolName: "galaxy_run_workflow" }))).toBe(
      "Started galaxy_run_workflow",
    );
    expect(summarizeEvent(event("tool.end", { toolName: "bash" }))).toEqual({
      text: "Finished bash",
      tone: "ok",
    });
    expect(summarizeEvent(event("tool.end", { toolName: "bash", isError: true }))).toEqual({
      text: "bash failed",
      tone: "failed",
    });
  });

  it("reports a Galaxy transition with its counts, and in the user's words", () => {
    const finished = summarizeEvent(
      event("poll.transition", {
        blockKind: "invocation",
        label: "Variant calling",
        from: "in_progress",
        to: "completed",
        counters: { ok: 11, error: 1, running: 0 },
      }),
    );
    expect(finished.text).toBe('Galaxy workflow run "Variant calling" finished (11 ok, 1 failed)');
    expect(finished.tone).toBe("ok");

    const failed = summarizeEvent(
      event("poll.transition", { blockKind: "job", label: "BWA-MEM2", to: "failed" }),
    );
    expect(failed).toEqual({ text: 'Galaxy job "BWA-MEM2" failed', tone: "failed" });
  });

  it("calls a transitional Galaxy state cancelled, not failed", () => {
    for (const to of ["deleting", "deleted", "stop"]) {
      const out = summarizeEvent(event("poll.transition", { label: "Trim", to }));
      expect(out.text).toBe('Galaxy workflow run "Trim" was cancelled');
      expect(out.tone).not.toBe("failed");
    }
  });

  it("says a run stopped being followed, and what Galaxy last thought of it", () => {
    const out = summarizeEvent(
      event("poll.block_missing", { label: "Trim", galaxyState: "running" }),
    );
    expect(out.text).toBe(
      'Stopped following "Trim" -- its record is gone from the notebook, and Galaxy still says it is running',
    );
    expect(out.tone).toBe("blocked");
  });

  it("distinguishes the four evidence-gate outcomes", () => {
    const base = { completions: ["plan-a-step-2"], contradictions: [{ step: "plan-a-step-2" }] };
    expect(summaryOf(event("evidence.decision", { ...base, outcome: "blocked" }))).toBe(
      'Refused to mark "plan-a-step-2" done -- that Galaxy run did not succeed',
    );
    expect(summaryOf(event("evidence.decision", { ...base, outcome: "warned" }))).toBe(
      'Marked "plan-a-step-2" done even though that Galaxy run did not succeed',
    );
    expect(summaryOf(event("evidence.decision", { ...base, outcome: "overridden" }))).toBe(
      'Marked "plan-a-step-2" done, using the override you granted',
    );
    expect(
      summaryOf(event("evidence.decision", { completions: ["a", "b"], outcome: "recorded" })),
    ).toBe("Marked 2 steps done -- nothing on Galaxy contradicts it");
  });

  it("reads an override back to the person who granted it", () => {
    expect(
      summaryOf(event("evidence.override", { step: "plan-a-step-3" }, { source: "user" })),
    ).toBe('You allowed "plan-a-step-3" to be marked done without Galaxy confirming it');
  });

  it("separates a guard block from a decline, and keeps the human reason", () => {
    expect(
      summaryOf(
        event("guard.decision", {
          toolName: "bash",
          outcome: "blocked",
          reason: "this command deletes files outside the analysis",
        }),
      ),
    ).toBe("Blocked bash -- this command deletes files outside the analysis");
    expect(summaryOf(event("guard.decision", { toolName: "bash", outcome: "blocked:user" }))).toBe(
      "You declined bash",
    );
    expect(summaryOf(event("guard.decision", { toolName: "write", outcome: "allowed" }))).toBe(
      "Allowed write",
    );
    expect(summaryOf(event("guard.decision", { toolName: "write", outcome: "allowed:once" }))).toBe(
      "You approved write",
    );
    expect(
      summaryOf(event("guard.decision", { toolName: "write", outcome: "allowed:session" })),
    ).toBe("Allowed write -- you approved it earlier this session");
  });

  it("falls back to the raw kind for a kind it has never seen, rather than throwing", () => {
    const out = summarizeEvent(event("galaxy.history_created", { id: "abc" }, { source: "brain" }));
    expect(out).toEqual({ text: "galaxy.history_created (brain)", tone: "unknown" });
  });

  it("survives a payload that is missing, empty, or the wrong type throughout", () => {
    const hostile = [
      { timestamp: "", kind: "", source: "", payload: {} },
      event("tool.end", { toolName: 42, isError: "true" }),
      event("poll.transition", { label: { nope: true }, to: [], counters: "lots" }),
      event("evidence.decision", { completions: "not-a-list", contradictions: 7 }),
      event("guard.decision", { outcome: null }),
      event("session.started", { cwd: 5 }),
      { timestamp: "x", kind: "user.prompt", source: "user" } as unknown as ActivityEvent,
    ];
    for (const e of hostile) {
      expect(() => summarizeEvent(e as ActivityEvent)).not.toThrow();
      expect(typeof summarizeEvent(e as ActivityEvent).text).toBe("string");
    }
  });

  it("caps one entry so a pasted transcript cannot become one enormous row", () => {
    const out = summarizeEvent(
      event("user.prompt", { text: "x".repeat(5000) }, { source: "user" }),
    );
    expect(out.text.length).toBeLessThanOrEqual(201);
  });

  it("flattens newlines and strips bidi overrides, so a row cannot lie about its order", () => {
    const out = summaryOf(
      event("user.prompt", { text: "line one\nline two\u202erm -rf /" }, { source: "user" }),
    );
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\u202e");
    expect(out).toContain("line one line two");
  });
});

describe("statusWord", () => {
  it("never shows the machine word for a state it knows", () => {
    expect(statusWord("queued")).toBe("waiting for Galaxy");
    expect(statusWord("in_progress")).toBe("running");
    expect(statusWord("ok")).toBe("finished");
    expect(statusWord("error")).toBe("failed");
    expect(statusWord("deleting")).toBe("cancelled");
    expect(statusWord("paused")).toBe("paused");
  });

  it("passes an unknown state through rather than inventing one", () => {
    expect(statusWord("resubmitted")).toBe("resubmitted");
    expect(statusWord("")).toBe("in a state Galaxy did not name");
  });
});

// -- the credential fence ----------------------------------------------------

describe("redaction", () => {
  it("hides the value of anything that looks like a credential, at any depth", () => {
    const out = redactForDisplay({
      toolName: "galaxy_connect",
      apiKey: "abc123",
      nested: { AUTHORIZATION: "Bearer xyz", url: "https://usegalaxy.org" },
      list: [{ access_token: "t0ken" }],
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("Bearer xyz");
    expect(text).not.toContain("t0ken");
    // The key names survive: knowing a credential was passed is useful.
    expect(text).toContain("apiKey");
    expect(text).toContain("https://usegalaxy.org");
  });

  it("cuts a cycle instead of blowing the stack", () => {
    const payload: Record<string, unknown> = { name: "loop" };
    payload.self = payload;
    expect(() => JSON.stringify(redactForDisplay(payload))).not.toThrow();
    expect(JSON.stringify(redactForDisplay(payload))).toContain("[circular]");
  });

  it("stops at a depth and a breadth, so a deep or wide payload cannot run away", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 50; i++) deep = { down: deep };
    expect(() => JSON.stringify(redactForDisplay(deep))).not.toThrow();

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) wide[`k${i}`] = i;
    const out = redactForDisplay(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBeLessThanOrEqual(41);
  });

  it("carries values JSON cannot, rather than throwing on them", () => {
    const out = redactForDisplay({ big: BigInt(7), nan: NaN, fn: () => 1 }) as Record<
      string,
      unknown
    >;
    expect(out.big).toBe("7");
    expect(out.nan).toBe("NaN");
    expect(out.fn).toBeUndefined();
  });

  it("puts the kind and source in the detail block and caps the whole thing", () => {
    const detail = formatDetail(event("tool.end", { resultSummary: "y".repeat(9000) }));
    expect(detail).toContain("kind: tool.end");
    expect(detail).toContain("source: agent");
    expect(detail.length).toBeLessThanOrEqual(2001);
  });
});

// -- config coercion ---------------------------------------------------------

describe("config coercion", () => {
  it("clamps maxEntries and ignores what is not a number", () => {
    expect(normalizeMaxEntries(25)).toBe(25);
    expect(normalizeMaxEntries(0)).toBe(1);
    expect(normalizeMaxEntries(-5)).toBe(1);
    expect(normalizeMaxEntries(1e9)).toBe(500);
    expect(normalizeMaxEntries("banana")).toBe(200);
    expect(normalizeMaxEntries(undefined)).toBe(200);
    expect(normalizeMaxEntries(12.7)).toBe(12);
  });

  it("treats an unusable or empty kinds list as no filter at all", () => {
    expect(normalizeKinds("all")).toBeNull();
    expect(normalizeKinds([])).toBeNull();
    expect(normalizeKinds([1, null])).toBeNull();
    expect(normalizeKinds(["tool.end", 3, "user.prompt"])).toEqual(
      new Set(["tool.end", "user.prompt"]),
    );
  });

  it("reads a boolean written as a string and falls back otherwise", () => {
    expect(normalizeBool(false, true)).toBe(false);
    expect(normalizeBool("false", true)).toBe(false);
    expect(normalizeBool("true", false)).toBe(true);
    expect(normalizeBool("maybe", true)).toBe(true);
  });
});

// -- rows --------------------------------------------------------------------

describe("buildRows", () => {
  const events = [
    event("user.prompt", { text: "align these reads" }, { source: "user" }),
    event("tool.start", { toolName: "bash" }),
    event("tool.end", { toolName: "bash" }),
  ];

  it("keeps the log in the order it happened, newest last", () => {
    const rows = buildRows(events, { kinds: "all", maxEntries: 10, showDetail: true });
    expect(rows.map((r) => r.text)).toEqual([
      "You asked: align these reads",
      "Started bash",
      "Finished bash",
    ]);
  });

  it("drops kinds the config did not ask for", () => {
    const rows = buildRows(events, { kinds: ["tool.end"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Finished bash");
  });

  it("matches the text filter against the sentence, the kind and the source", () => {
    expect(buildRows(events, {}, "align")).toHaveLength(1);
    expect(buildRows(events, {}, "tool.")).toHaveLength(2);
    expect(buildRows(events, {}, "USER")).toHaveLength(1);
    expect(buildRows(events, {}, "nothing here")).toHaveLength(0);
  });

  it("keeps the newest maxEntries rows, not the oldest", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      event(
        "tool.end",
        { toolName: `t${i}` },
        { timestamp: `2026-09-18T10:00:${String(i % 60).padStart(2, "0")}.000Z` },
      ),
    );
    const rows = buildRows(many, { maxEntries: 5 });
    expect(rows).toHaveLength(5);
    expect(rows[4].text).toBe("Finished t39");
  });

  it("gives two events in the same second distinct keys", () => {
    const twice = [
      event("tool.start", { toolName: "bash" }),
      event("tool.start", { toolName: "bash" }),
    ];
    const rows = buildRows(twice, {});
    expect(rows[0].key).not.toBe(rows[1].key);
  });

  it("keeps a row's key stable when a filter hides the rows around it", () => {
    const all = buildRows(events, {});
    const filtered = buildRows(events, {}, "Finished");
    expect(filtered[0].key).toBe(all[2].key);
  });

  it("labels the first visible row with its day and then only on a change", () => {
    const across = [
      event("tool.end", { toolName: "a" }, { timestamp: "2026-09-17T09:00:00.000Z" }),
      event("tool.end", { toolName: "b" }, { timestamp: "2026-09-17T09:00:01.000Z" }),
      event("tool.end", { toolName: "c" }, { timestamp: "2026-09-18T09:00:00.000Z" }),
    ];
    const days = buildRows(across, {}).map((r) => r.day);
    expect(days[0]).not.toBeNull();
    expect(days[1]).toBeNull();
    expect(days[2]).not.toBeNull();
    expect(days[2]).not.toBe(days[0]);
  });

  it("leaves the detail out entirely when the panel is configured without it", () => {
    expect(buildRows(events, { showDetail: false }).every((r) => r.detail === "")).toBe(true);
    expect(buildRows(events, { showDetail: true }).every((r) => r.detail.length > 0)).toBe(true);
  });
});

// -- the auto-scroll decision ------------------------------------------------

describe("isAtBottom", () => {
  it("follows while the view is at or near the bottom", () => {
    expect(isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isAtBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("stops following once the user has scrolled up", () => {
    expect(isAtBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it("follows a view too short to scroll, and a panel with no height yet", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 300 })).toBe(true);
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });

  it("follows rather than stalling when the measurements are not numbers", () => {
    expect(isAtBottom({ scrollTop: NaN, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("honours a caller-supplied threshold", () => {
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }, 200)).toBe(true);
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }, 10)).toBe(false);
  });
});

describe("time formatting", () => {
  it("renders a wall-clock time and a day label", () => {
    const iso = "2026-09-18T10:11:12.000Z";
    const local = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, "0");
    expect(formatEventTime(iso)).toBe(
      `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`,
    );
    expect(formatEventDay(iso)).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  });

  it("says so rather than rendering Invalid Date", () => {
    expect(formatEventTime("not a time")).toBe("--:--:--");
    expect(formatEventTime("")).toBe("--:--:--");
    expect(formatEventDay("not a time")).toBeNull();
  });
});

describe("truncate", () => {
  it("does not split a surrogate pair", () => {
    const out = truncate("ab\u{1F600}cd", 3);
    expect(out).toBe("ab\u{1F600}…");
  });
});

// -- mounted behaviour -------------------------------------------------------

describe("mounted activity widget", () => {
  it("says the log is not readable here instead of drawing an empty log", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([], false);
    expect(textOf(h)).toContain("not readable in this window");
    expect(h.rows()).toHaveLength(0);
  });

  it("invites the user to wait when the log exists but is empty", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([]);
    expect(textOf(h)).toContain("Nothing yet.");
  });

  it("draws a row per event and updates when the log grows", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.start", { toolName: "bash" })]);
    expect(h.rows()).toHaveLength(1);
    h.emit([event("tool.start", { toolName: "bash" }), event("tool.end", { toolName: "bash" })]);
    expect(h.rows()).toHaveLength(2);
    expect(textOf(h)).toContain("Finished bash");
  });

  it("never turns a payload into markup", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([
      event(
        "user.prompt",
        { text: '<img src=x onerror="alert(1)"><b>bold</b>' },
        { source: "user" },
      ),
    ]);
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.querySelector("b")).toBeNull();
    expect(textOf(h)).toContain("<b>bold</b>");
  });

  it("never renders a credential value, in the row or in its detail", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([
      event("tool.start", {
        toolName: "galaxy_connect",
        args: { url: "https://usegalaxy.org", api_key: "SUPERSECRET" },
      }),
    ]);
    expect(h.el.innerHTML).not.toContain("SUPERSECRET");
    expect(textOf(h)).toContain("api_key");
    expect(textOf(h)).toContain("[hidden]");
  });

  it("keeps the DOM under the configured cap", () => {
    const h = harness({ maxEntries: 5 });
    activityWidget.mount(h.el, h.ctx);
    h.emit(Array.from({ length: 60 }, (_, i) => event("tool.end", { toolName: `t${i}` })));
    expect(h.rows()).toHaveLength(5);
    expect(textOf(h)).toContain("Showing 5 of 60 entries.");
  });

  it("filters from the header without asking the host to persist anything", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([
      event("user.prompt", { text: "align these reads" }, { source: "user" }),
      event("tool.end", { toolName: "bash" }),
    ]);
    const filter = h.header.querySelector("input") as HTMLInputElement;
    filter.value = "align";
    filter.dispatchEvent(new Event("input"));
    expect(h.rows()).toHaveLength(1);
    expect(textOf(h)).toContain("align these reads");
    expect(h.setConfig).not.toHaveBeenCalled();
  });

  it("says so when the filter matches nothing", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const filter = h.header.querySelector("input") as HTMLInputElement;
    filter.value = "zzzz";
    filter.dispatchEvent(new Event("input"));
    expect(textOf(h)).toContain("matches that filter");
  });

  it("persists the detail toggle, because that one is a panel setting", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    const buttons = [...h.header.querySelectorAll("button")];
    const detail = buttons.find((b) => b.textContent === "detail") as HTMLButtonElement;
    expect(detail.getAttribute("aria-pressed")).toBe("true");
    detail.click();
    expect(h.setConfig).toHaveBeenCalledWith({ showDetail: false });
  });

  it("draws plain rows with no disclosure when detail is off", () => {
    const h = harness({ showDetail: false });
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    expect(h.el.querySelector("details")).toBeNull();
    expect(h.el.querySelector(".dash-activity-row-plain")).not.toBeNull();
  });

  it("leaves an entry the user opened open when the next event arrives", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    const first = event("tool.start", { toolName: "bash" });
    h.emit([first]);
    const details = h.el.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    h.emit([first, event("tool.end", { toolName: "bash" })]);
    const after = [...h.el.querySelectorAll("details")] as HTMLDetailsElement[];
    expect(after).toHaveLength(2);
    expect(after[0].open).toBe(true);
    expect(after[1].open).toBe(false);
  });

  it("offers a way back to the newest entry once the user scrolls up", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const scroller = h.scroller();
    const jump = h.el.querySelector(".dash-activity-jump") as HTMLButtonElement;
    expect(jump.hidden).toBe(true);

    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(false);

    jump.click();
    expect(jump.hidden).toBe(true);
    expect(scroller.scrollTop).toBe(1000);
  });

  it("stops following while the user is reading further up", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "a" })]);
    const scroller = h.scroller();
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));

    scroller.scrollTop = 0;
    h.emit([event("tool.end", { toolName: "a" }), event("tool.end", { toolName: "b" })]);
    expect(scroller.scrollTop).toBe(0);
  });

  it("installs its stylesheet once, however many panels mount", () => {
    const a = harness();
    activityWidget.mount(a.el, a.ctx);
    const b = harness();
    activityWidget.mount(b.el, b.ctx);
    expect(document.head.querySelectorAll("#dash-activity-styles")).toHaveLength(1);
  });

  it("leaves the panel element clean when it is disposed", () => {
    const h = harness();
    const dispose = activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    for (const fn of h.cleanups) fn();
    dispose?.();
    expect(h.el.textContent).toBe("");
    expect(h.el.classList.contains("dash-activity")).toBe(false);
  });

  it("never asks the host to fail the panel over a hostile log", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    h.emit([
      event("who.knows", cyclic, { timestamp: "nonsense", source: "" }),
      event("tool.end", { toolName: "\u202eevil" }),
    ]);
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.rows()).toHaveLength(2);
    expect(textOf(h)).toContain("--:--:--");
  });

  it("puts the reader back where they were when the log grows under them", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "a" })]);
    const scroller = h.scroller();
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 250;
    scroller.dispatchEvent(new Event("scroll"));

    h.emit([event("tool.end", { toolName: "a" }), event("tool.end", { toolName: "b" })]);
    expect(scroller.scrollTop).toBe(250);
  });

  it("keeps the count of what it is hiding out of the scrolling list", () => {
    const h = harness({ maxEntries: 2 });
    activityWidget.mount(h.el, h.ctx);
    h.emit(Array.from({ length: 6 }, (_, i) => event("tool.end", { toolName: `t${i}` })));
    const trim = h.el.querySelector(".dash-activity-trim") as HTMLElement;
    expect(trim.hidden).toBe(false);
    expect(trim.textContent).toBe("Showing 2 of 6 entries.");
    expect(h.el.querySelector(".dash-activity-scroll")?.contains(trim)).toBe(false);
  });

  it("does not also count what it is hiding when nothing matches at all", () => {
    const h = harness();
    activityWidget.mount(h.el, h.ctx);
    h.emit([event("tool.end", { toolName: "bash" })]);
    const filter = h.header.querySelector("input") as HTMLInputElement;
    filter.value = "zzzz";
    filter.dispatchEvent(new Event("input"));
    expect((h.el.querySelector(".dash-activity-trim") as HTMLElement).hidden).toBe(true);
  });
});
