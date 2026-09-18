// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planWidget } from "../app/src/renderer/dashboard/widgets/plan.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type { DataSource, WidgetContext } from "../app/src/renderer/dashboard/widget-api.js";

type PlanConfig = { plan: "latest" | "all"; showCompleted: boolean };

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext<PlanConfig>;
  sources: DashboardSources;
  setConfig: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  cleanups: Array<() => void>;
  /** Feed the widget a notebook through the real parser the host uses. */
  notebook(markdown: string): void;
  text(): string;
  buttons(): HTMLButtonElement[];
}

function harness(config: Partial<PlanConfig> = {}): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  const sources = new DashboardSources();
  const cleanups: Array<() => void> = [];
  const setConfig = vi.fn();
  const fail = vi.fn();
  const ctx = {
    panelId: "p-plan",
    config: { ...planWidget.defaultConfig, ...config },
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
  } as unknown as WidgetContext<PlanConfig>;

  return {
    el,
    header,
    ctx,
    sources,
    setConfig,
    fail,
    cleanups,
    notebook: (markdown: string) => sources.setNotebook(markdown),
    text: () => el.textContent ?? "",
    buttons: () => Array.from(header.querySelectorAll("button")),
  };
}

/** Whitespace-insensitive contains, because the DOM concatenates siblings. */
function has(h: Harness, needle: string): boolean {
  return h.text().replace(/\s+/g, " ").includes(needle);
}

const ONE_PLAN = `# Notebook

## Plan A: chrM Variant Calling [hybrid]

### Steps

- [x] 1. **QC FASTQ** {#plan-a-step-1} -- fastp adapter trim
  - Routing: local
  - Verification: confirm the fastp report exists
- [x] 2. **Reference index** {#plan-a-step-2} -- bwa index of chrM
  - Routing: local
  - Verification: confirm the index sidecars exist
- [ ] 3. **Read alignment** {#plan-a-step-3} -- bwa mem PE 4 samples
  - Routing: Galaxy (bwa-mem2/2.2.1)
  - Verification: poll Galaxy jobs to ok and inspect the BAMs
- [ ] 4. **Call variants** {#plan-a-step-4} -- bcftools
  - Routing: Galaxy
  - Verification: VCF header and record counts
`;

const TWO_PLANS = `${ONE_PLAN}
## Plan B: Tissue comparison [galaxy]

### Steps

- [ ] 1. **Normalise counts** -- DESeq2
  - Routing: Galaxy
  - Verification: sizeFactors written
- [ ] 2. **Plot** -- volcano
  - Routing: Galaxy
  - Verification: PNG exists
`;

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("plan widget -- registration", () => {
  it("keeps the type and config the document and registry expect", () => {
    expect(planWidget.type).toBe("plan");
    expect(planWidget.label).toBe("Plan");
    expect(planWidget.defaultConfig).toEqual({ plan: "latest", showCompleted: true });
  });
});

describe("plan widget -- empty and odd notebooks", () => {
  it("asks for a plan when there is none", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    expect(h.text()).toContain("No plan yet -- ask Loom to draft one.");
  });

  it("stays on the empty state for a notebook with no plan heading", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("# Notebook\n\n## Findings\n\n- [ ] not a plan step\n");
    expect(h.text()).toContain("No plan yet");
  });

  it("draws a plan heading that has no steps under it", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("## Plan A: Nothing yet [local]\n\nJust a title so far.\n");
    expect(has(h, "Plan A: Nothing yet")).toBe(true);
    expect(has(h, "No steps written down yet")).toBe(true);
    expect(h.el.querySelector(".dash-bar")).toBeNull();
  });

  it("shows a step that is written without a number or an anchor", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("## Plan A: Bare [local]\n\n- [ ] **Do the thing** -- with a detail\n");
    expect(has(h, "1. Do the thing")).toBe(true);
    expect(has(h, "with a detail")).toBe(true);
  });

  // The host's own parser reads nothing out of a CRLF notebook today, so this
  // is really a test of the widget's normalisation. It keeps passing, for the
  // right reason, once the parser is fixed.
  it("reads a CRLF notebook the same as an LF one", () => {
    const lf = harness();
    planWidget.mount(lf.el, lf.ctx);
    lf.notebook(ONE_PLAN);
    const crlf = harness();
    planWidget.mount(crlf.el, crlf.ctx);
    crlf.notebook(ONE_PLAN.replace(/\n/g, "\r\n"));
    expect(crlf.text().replace(/\s+/g, " ")).toBe(lf.text().replace(/\s+/g, " "));
    expect(has(crlf, "In progress -- 2 of 4 steps done")).toBe(true);
  });

  it("keeps the nested Routing and Verification bullets off the step list", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    // Four steps, not eight: the sub-bullets are step metadata, not steps.
    expect(h.el.querySelectorAll(".dash-row-item").length).toBe(4);
  });

  it("carries the anchor's step through without printing the anchor", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    expect(has(h, "1. QC FASTQ")).toBe(true);
    expect(h.text()).not.toContain("plan-a-step-1");
    expect(h.text()).not.toContain("{#");
  });
});

describe("plan widget -- the current plan", () => {
  it("names the plan and says what its routing tag means", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    expect(has(h, "Plan A: chrM Variant Calling")).toBe(true);
    expect(has(h, "Part on Galaxy, part on this computer")).toBe(true);
    // The machine word never reaches the screen.
    expect(h.text()).not.toContain("hybrid");
  });

  it("puts the progress in one sentence and in a bar", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    expect(has(h, "In progress -- 2 of 4 steps done")).toBe(true);
    const bar = h.el.querySelector(".dash-bar") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe("2 of 4 steps done");
    expect((bar.querySelector(".dash-bar-done") as HTMLElement).style.width).toBe("50%");
    expect((bar.querySelector(".dash-bar-fail") as HTMLElement).style.width).toBe("0%");
  });

  it("calls out the next pending step with its routing and its verification", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    const next = h.el.querySelector(".dash-plan-next") as HTMLElement;
    const text = (next.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Next");
    expect(text).toContain("3. Read alignment");
    expect(text).toContain("On Galaxy (bwa-mem2/2.2.1)");
    expect(text).toContain("Done when: poll Galaxy jobs to ok");
    expect(next.classList.contains("is-failed")).toBe(false);
  });

  it("says a finished plan is finished and calls nothing out", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("## Plan A: Done [local]\n\n- [x] 1. **One** -- a\n- [x] 2. **Two** -- b\n");
    expect(has(h, "Finished -- all 2 steps done")).toBe(true);
    expect(h.el.querySelector(".dash-plan-next")).toBeNull();
  });

  it("says an untouched plan has not started", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("## Plan A: Fresh [galaxy]\n\n- [ ] 1. **One** -- a\n- [ ] 2. **Two** -- b\n");
    expect(has(h, "No steps done yet -- 2 steps to do")).toBe(true);
    expect(has(h, "Runs on Galaxy")).toBe(true);
  });

  it("leads with the failure rather than the next pending step", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(
      "## Plan A: Broken [galaxy]\n\n- [x] 1. **One** -- a\n- [!] 2. **Two** -- ran out of memory\n- [ ] 3. **Three** -- c\n",
    );
    expect(has(h, "1 step failed -- 1 still to do")).toBe(true);
    const next = h.el.querySelector(".dash-plan-next") as HTMLElement;
    expect(next.classList.contains("is-failed")).toBe(true);
    const text = (next.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Needs you");
    expect(text).toContain("2. Two");
    expect(text).toContain("ran out of memory");
    expect(text).not.toContain("3. Three");
    const bar = h.el.querySelector(".dash-bar") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe("1 of 3 steps done, 1 failed");
    expect((bar.querySelector(".dash-bar-fail") as HTMLElement).style.width).toContain("33.3");
  });

  it("does not claim a plan stopped when it carried on past the failure", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(
      "## Plan A: Carried on [galaxy]\n\n- [x] 1. **One**\n- [!] 2. **Two**\n- [x] 3. **Three**\n",
    );
    expect(has(h, "Finished, but 1 step failed")).toBe(true);
    expect(h.text()).not.toContain("still to do");
  });

  it("marks the failed row and gives every row a word, not only a colour", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(
      "## Plan A: Mixed [local]\n\n- [x] 1. **One**\n- [!] 2. **Two**\n- [ ] 3. **Three**\n",
    );
    const rows = Array.from(h.el.querySelectorAll(".dash-row-item"));
    expect(rows.map((r) => r.querySelector(".dash-row-title")?.textContent)).toEqual([
      "1. One",
      "2. Two",
      "3. Three",
    ]);
    // The word, not only the colour and not only the glyph.
    expect(rows.map((r) => r.querySelector(".dash-meta")?.textContent)).toEqual([
      "Done",
      "Failed",
      "To do",
    ]);
    expect(rows[1].classList.contains("is-failed")).toBe(true);
    // Glyphs are decoration, so they stay out of the accessibility tree.
    for (const row of rows) {
      expect(row.querySelector(".state-glyph")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("redraws when the notebook changes", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    expect(has(h, "In progress -- 2 of 4 steps done")).toBe(true);
    h.notebook(ONE_PLAN.replace("- [ ] 3.", "- [x] 3."));
    expect(has(h, "In progress -- 3 of 4 steps done")).toBe(true);
    expect(has(h, "2 of 4")).toBe(false);
  });
});

describe("plan widget -- hostile and odd input", () => {
  it("never puts notebook text into the DOM as markup", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(
      "## Plan A: <img src=x onerror=alert(1)> [local]\n\n- [ ] 1. **<script>bad()</script>** -- <b>no</b>\n",
    );
    expect(h.el.querySelector("img")).toBeNull();
    expect(h.el.querySelector("script")).toBeNull();
    expect(h.el.querySelector("b")).toBeNull();
    expect(has(h, "<script>bad()</script>")).toBe(true);
  });

  it("shows an unrecognised routing tag as written instead of guessing", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("## Plan A: Odd [draft]\n\n- [ ] 1. **One**\n");
    expect(has(h, 'Routed "draft"')).toBe(true);
  });

  it("drops no step when the heading carries no routing tag", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("## Plan A: Untagged\n\n- [ ] 1. **One**\n");
    expect(has(h, "Plan A: Untagged")).toBe(true);
    expect(h.el.querySelectorAll(".dash-row-item").length).toBe(1);
  });

  it("survives a config the document could carry but the type forbids", () => {
    const h = harness({ plan: "nonsense" as "all", showCompleted: "yes" as unknown as boolean });
    expect(() => planWidget.mount(h.el, h.ctx)).not.toThrow();
    h.notebook(TWO_PLANS);
    // A bad `plan` falls back to the current plan only.
    expect(h.el.querySelector(".dash-plan-older")).toBeNull();
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("labels a step that has only a detail", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook("## Plan A: Sparse [local]\n\n- [ ] just some prose\n");
    expect(has(h, "1. just some prose")).toBe(true);
  });
});

describe("plan widget -- header controls", () => {
  it("hides finished steps when asked, and says how many it hid", () => {
    const h = harness({ showCompleted: false });
    planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    expect(h.el.querySelectorAll(".dash-row-item").length).toBe(2);
    expect(has(h, "2 finished steps hidden")).toBe(true);
    // Progress still counts everything; hiding is a filter, not a rewrite.
    expect(has(h, "In progress -- 2 of 4 steps done")).toBe(true);
  });

  it("asks the host to persist the completed toggle", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    const btn = h.buttons()[0];
    expect(btn.textContent).toBe("all steps");
    btn.click();
    expect(h.setConfig).toHaveBeenCalledWith({ showCompleted: false });
  });

  it("reflects showCompleted: false in the toggle", () => {
    const h = harness({ showCompleted: false });
    planWidget.mount(h.el, h.ctx);
    const btn = h.buttons()[0];
    expect(btn.textContent).toBe("to do");
    expect(btn.classList.contains("active")).toBe(true);
  });

  it("only offers the older-plans toggle once a second plan exists", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    const btn = h.buttons()[1];
    expect(btn.hidden).toBe(true);
    h.notebook(ONE_PLAN);
    expect(btn.hidden).toBe(true);
    h.notebook(TWO_PLANS);
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(h.setConfig).toHaveBeenCalledWith({ plan: "all" });
  });
});

describe("plan widget -- more than one plan", () => {
  it("shows the last plan in the notebook, not the first", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(TWO_PLANS);
    const title = h.el.querySelector(".dash-plan-title")?.textContent;
    expect(title).toBe("Plan B: Tissue comparison");
    expect(has(h, "No steps done yet -- 2 steps to do")).toBe(true);
  });

  it("leaves the earlier plans out entirely on the default config", () => {
    const h = harness();
    planWidget.mount(h.el, h.ctx);
    h.notebook(TWO_PLANS);
    expect(h.el.querySelector(".dash-plan-older")).toBeNull();
    expect(h.text()).not.toContain("chrM Variant Calling");
  });

  it("lists the earlier plans collapsed, newest first, when asked for all", () => {
    const h = harness({ plan: "all" });
    planWidget.mount(h.el, h.ctx);
    h.notebook(`${TWO_PLANS}\n## Plan C: Follow-up [local]\n\n- [ ] 1. **One**\n`);
    expect(h.el.querySelector(".dash-plan-title")?.textContent).toBe("Plan C: Follow-up");
    const rows = Array.from(h.el.querySelectorAll(".dash-plan-older-row"));
    expect(rows.map((r) => r.querySelector(".dash-row-title")?.textContent)).toEqual([
      "Plan B: Tissue comparison",
      "Plan A: chrM Variant Calling",
    ]);
    expect(has(h, "2 earlier plans")).toBe(true);
    for (const row of rows) expect(row.getAttribute("aria-expanded")).toBe("false");
    // Collapsed means collapsed: no earlier plan's steps on screen.
    expect(h.text()).not.toContain("Reference index");
  });

  it("puts the state word for an earlier plan in the button's name, not only in a glyph", () => {
    const h = harness({ plan: "all" });
    planWidget.mount(h.el, h.ctx);
    h.notebook(TWO_PLANS);
    const row = h.el.querySelector(".dash-plan-older-row") as HTMLButtonElement;
    expect(row.getAttribute("aria-label")).toBe(
      "Plan A: chrM Variant Calling -- In progress -- 2 of 4 steps done",
    );
  });

  it("expands an earlier plan in place and collapses it again", () => {
    const h = harness({ plan: "all" });
    planWidget.mount(h.el, h.ctx);
    h.notebook(TWO_PLANS);
    const row = h.el.querySelector(".dash-plan-older-row") as HTMLButtonElement;
    expect(row.querySelector(".dash-plan-older-count")?.textContent).toBe("2/4");
    row.click();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(has(h, "2. Reference index")).toBe(true);
    expect(has(h, "Part on Galaxy, part on this computer")).toBe(true);
    row.click();
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(h.text()).not.toContain("Reference index");
  });

  it("keeps an expanded earlier plan open across a notebook update", () => {
    const h = harness({ plan: "all" });
    planWidget.mount(h.el, h.ctx);
    h.notebook(TWO_PLANS);
    (h.el.querySelector(".dash-plan-older-row") as HTMLButtonElement).click();
    expect(has(h, "2. Reference index")).toBe(true);
    h.notebook(TWO_PLANS.replace("- [ ] 1. **Normalise counts**", "- [x] 1. **Normalise counts**"));
    expect(has(h, "In progress -- 1 of 2 steps done")).toBe(true);
    expect(h.el.querySelector(".dash-plan-older-row")?.getAttribute("aria-expanded")).toBe("true");
    expect(has(h, "2. Reference index")).toBe(true);
  });

  it("tells two same-named plans apart when one is expanded", () => {
    const h = harness({ plan: "all" });
    planWidget.mount(h.el, h.ctx);
    h.notebook(
      "## Plan A: First [local]\n\n- [x] 1. **Alpha**\n\n" +
        "## Plan A: Second [local]\n\n- [ ] 1. **Beta**\n\n" +
        "## Plan A: Third [local]\n\n- [ ] 1. **Gamma**\n",
    );
    const rows = Array.from(h.el.querySelectorAll(".dash-plan-older-row")) as HTMLButtonElement[];
    expect(rows).toHaveLength(2);
    rows[0].click();
    expect(has(h, "1. Beta")).toBe(true);
    expect(h.text()).not.toContain("Alpha");
    expect(rows[1].getAttribute("aria-expanded")).toBe("false");
  });
});

describe("plan widget -- lifecycle", () => {
  it("adds its stylesheet once, however many panels mount", () => {
    const a = harness();
    planWidget.mount(a.el, a.ctx);
    const b = harness();
    planWidget.mount(b.el, b.ctx);
    expect(document.querySelectorAll("#dash-plan-styles")).toHaveLength(1);
  });

  it("empties its element and drops its class on dispose", () => {
    const h = harness();
    const dispose = planWidget.mount(h.el, h.ctx);
    h.notebook(ONE_PLAN);
    expect(h.el.classList.contains("dash-plan")).toBe(true);
    dispose?.();
    expect(h.el.textContent).toBe("");
    expect(h.el.classList.contains("dash-plan")).toBe(false);
  });

  it("never throws on mount, so the host never has to draw an error card", () => {
    const h = harness();
    expect(() => planWidget.mount(h.el, h.ctx)).not.toThrow();
    expect(h.fail).not.toHaveBeenCalled();
  });
});
