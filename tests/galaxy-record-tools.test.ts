/**
 * `galaxy_invocation_record` / `galaxy_job_record` -- the two tools that turn a
 * Galaxy id the model read out of an MCP result into a notebook block.
 *
 * They used to take everything on faith: no anchor check, no server round trip,
 * and an unguarded whole-file write. These tests pin what they now refuse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { findInvocationBlocks } from "../extensions/loom/notebook-writer";
import { findJobBlocks } from "../extensions/loom/galaxy-job-block";
import { registerPlanTools } from "../extensions/loom/tools";

interface ToolDef {
  name: string;
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

function recordTools(): { invocation: ToolDef; job: ToolDef } {
  const tools: ToolDef[] = [];
  const api = { registerTool: (def: ToolDef) => tools.push(def) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPlanTools(api as any);
  const invocation = tools.find((t) => t.name === "galaxy_invocation_record");
  const job = tools.find((t) => t.name === "galaxy_job_record");
  if (!invocation || !job) throw new Error("record tools not registered");
  return { invocation, job };
}

function run(
  tool: ToolDef,
  params: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<{ success: boolean; error?: string; message?: string; [k: string]: unknown }> {
  return tool
    .execute("call-1", params, signal, vi.fn(), {})
    .then((r) => JSON.parse(r.content[0].text));
}

const NOTEBOOK = `# Project notebook

## Plan A: chrM Variant Calling [galaxy]

### Steps

- [ ] 1. **QC FASTQs** {#plan-a-step-1} — fastp adapter trim
- [ ] 2. **Align to chrM reference** {#plan-a-step-2} — BWA-MEM
`;

describe("record tools: anchor validation", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-record-anchor-"));
    nbPath = join(dir, "notebook.md");
    writeFileSync(nbPath, NOTEBOOK, "utf-8");
    setNotebookPath(nbPath);
    // An invocation block with no galaxy_server_url doesn't parse
    // (parseInvocationBlock requires it), so every Galaxy test sets these.
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
  });

  afterEach(() => {
    resetState();
    vi.restoreAllMocks();
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records an invocation against an anchor that exists", async () => {
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: "inv-1",
      notebookAnchor: "plan-a-step-2",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    const blocks = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].notebookAnchor).toBe("plan-a-step-2");
  });

  it("rejects an anchor nothing in the notebook resolves to, and writes nothing", async () => {
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: "inv-1",
      notebookAnchor: "plan-1-step-3",
      label: "BWA alignment",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("plan-1-step-3");
    // The message has to name what the notebook does have, or the model has no
    // way to correct itself except by guessing again.
    expect(res.error).toContain("plan-a-step-1");
    expect(res.error).toContain("plan-a-step-2");
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("accepts a plan heading's slug, for notebooks written without {#anchors}", async () => {
    const { invocation } = recordTools();
    const res = await run(invocation, {
      invocationId: "inv-1",
      notebookAnchor: "plan-a-chrm-variant-calling-galaxy",
      label: "BWA alignment",
    });

    expect(res.success).toBe(true);
    expect(findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0].notebookAnchor).toBe(
      "plan-a-chrm-variant-calling-galaxy",
    );
  });

  it("stores the notebook's spelling of the anchor, not the caller's", async () => {
    const { invocation } = recordTools();
    await run(invocation, {
      invocationId: "inv-1",
      notebookAnchor: "{#PLAN-A-STEP-1}",
      label: "QC",
    });

    expect(findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0].notebookAnchor).toBe(
      "plan-a-step-1",
    );
  });

  it("records a job against an anchor that exists", async () => {
    const { job } = recordTools();
    const res = await run(job, {
      jobId: "job-1",
      notebookAnchor: "plan-a-step-1",
      label: "FastQC",
      toolId: "fastqc",
    });

    expect(res.success).toBe(true);
    const blocks = findJobBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].notebookAnchor).toBe("plan-a-step-1");
  });

  it("rejects a job whose anchor does not resolve, and writes nothing", async () => {
    const { job } = recordTools();
    const res = await run(job, {
      jobId: "job-1",
      notebookAnchor: "step-99",
      label: "FastQC",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("step-99");
    expect(readFileSync(nbPath, "utf-8")).toBe(NOTEBOOK);
  });

  it("does not let a previously recorded block validate the next record call", async () => {
    // The blocks are fences carrying their own notebook_anchor: line. Reading
    // those as anchors would make the check confirm its own writes.
    const { invocation } = recordTools();
    await run(invocation, {
      invocationId: "inv-1",
      notebookAnchor: "plan-a-step-1",
      label: "QC",
    });
    const res = await run(invocation, {
      invocationId: "inv-2",
      notebookAnchor: "plan-a-step-1-typo",
      label: "QC again",
    });

    expect(res.success).toBe(false);
    expect(findInvocationBlocks(readFileSync(nbPath, "utf-8"))).toHaveLength(1);
  });
});
