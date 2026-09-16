import { describe, expect, it } from "vitest";
import {
  collectNotebookAnchors,
  listNotebookAnchors,
  resolveNotebookAnchor,
  unknownAnchorMessage,
} from "../extensions/loom/notebook-anchors";

const PLAN = `# Project notebook

## Plan A: chrM Variant Calling [galaxy]

### Steps

- [ ] 1. **QC FASTQs** {#plan-a-step-1} — fastp adapter trim
- [ ] 2. **Align to chrM reference** {#plan-a-step-2} — BWA-MEM
`;

describe("collectNotebookAnchors", () => {
  it("collects explicit {#anchor} markers as written", () => {
    expect(collectNotebookAnchors(PLAN).explicit).toEqual(["plan-a-step-1", "plan-a-step-2"]);
  });

  it("derives a slug from every markdown heading", () => {
    const { headings } = collectNotebookAnchors(PLAN);
    expect(headings).toContain("plan-a-chrm-variant-calling-galaxy");
    expect(headings).toContain("project-notebook");
    expect(headings).toContain("steps");
  });

  it("strips an explicit anchor out of the heading it is attached to", () => {
    const { explicit, headings } = collectNotebookAnchors("## Results {#results-section}\n");
    expect(explicit).toEqual(["results-section"]);
    expect(headings).toEqual(["results"]);
  });

  it("ignores anchors and headings inside fenced blocks", () => {
    // The plan convention's own worked example lives in a ```plan fence, and
    // the chat draft gets pasted into notebooks. Quoted content is not the
    // plan: binding a run to an example step would bind it to nothing.
    const content = `# Notes

\`\`\`plan
## Plan B: Example [galaxy]

- [ ] 1. **Example step** {#plan-b-step-1} — from the template
\`\`\`
`;
    const anchors = listNotebookAnchors(content);
    expect(anchors).toEqual(["notes"]);
  });

  it("does not treat a loom-invocation block's own notebook_anchor as an anchor", () => {
    // Otherwise every recorded block would validate the next record call for
    // the same anchor -- the check would confirm its own writes.
    const content = `# Notes

\`\`\`loom-invocation
invocation_id: inv-1
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-9
label: QC
submitted_at: 2026-09-16T00:00:00Z
status: in_progress
summary: ""
\`\`\`
`;
    expect(listNotebookAnchors(content)).toEqual(["notes"]);
    expect(resolveNotebookAnchor(content, "plan-a-step-9")).toBeNull();
  });

  it("de-duplicates while keeping explicit anchors ahead of heading slugs", () => {
    const anchors = listNotebookAnchors("## Steps {#steps}\n\n## Steps\n");
    expect(anchors).toEqual(["steps"]);
  });
});

describe("resolveNotebookAnchor", () => {
  it("resolves an anchor that exists", () => {
    expect(resolveNotebookAnchor(PLAN, "plan-a-step-2")).toBe("plan-a-step-2");
  });

  it("resolves a heading slug", () => {
    expect(resolveNotebookAnchor(PLAN, "plan-a-chrm-variant-calling-galaxy")).toBe(
      "plan-a-chrm-variant-calling-galaxy",
    );
  });

  it("accepts the markdown spellings a model copies out of the notebook", () => {
    for (const input of ["{#plan-a-step-1}", "#plan-a-step-1", " plan-a-step-1 "]) {
      expect(resolveNotebookAnchor(PLAN, input)).toBe("plan-a-step-1");
    }
  });

  it("canonicalizes case to the spelling in the notebook", () => {
    // The block's notebook_anchor is matched against the step's anchor
    // verbatim (evidence-gate.ts findContradictions), so a case-drifted copy
    // would record a block that binds to no step at all.
    const content = "- [ ] 1. **QC** {#Plan-A-Step-1} — fastp\n";
    expect(resolveNotebookAnchor(content, "plan-a-step-1")).toBe("Plan-A-Step-1");
  });

  it("returns null for an anchor nothing resolves to", () => {
    expect(resolveNotebookAnchor(PLAN, "plan-1-step-3")).toBeNull();
  });

  it("returns null for an empty or brace-only input", () => {
    expect(resolveNotebookAnchor(PLAN, "   ")).toBeNull();
    expect(resolveNotebookAnchor(PLAN, "{#}")).toBeNull();
  });
});

describe("unknownAnchorMessage", () => {
  it("lists the anchors that do exist", () => {
    const msg = unknownAnchorMessage("plan-1-step-3", listNotebookAnchors(PLAN));
    expect(msg).toContain('"plan-1-step-3"');
    expect(msg).toContain("plan-a-step-1");
    expect(msg).toContain("plan-a-step-2");
  });

  it("caps a long list rather than dumping the whole notebook", () => {
    const many = Array.from({ length: 30 }, (_, i) => `anchor-${i}`);
    const msg = unknownAnchorMessage("nope", many);
    expect(msg).toContain("anchor-0");
    expect(msg).not.toContain("anchor-29");
    expect(msg).toContain("10 more");
  });

  it("says what to do when the notebook has no anchors at all", () => {
    const msg = unknownAnchorMessage("plan-a-step-1", []);
    expect(msg).toContain("no headings or {#anchor}");
    expect(msg).toContain("{#plan-a-step-1}");
  });
});
