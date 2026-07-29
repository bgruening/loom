import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeNotebook,
  readNotebook,
  withNotebookLock,
  upsertInvocationBlock,
  applyInvocationUpdates,
  statNotebook,
  NotebookChangedError,
  renderInvocationYaml,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";

describe("writeNotebook + withNotebookLock", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-concurrency-"));
    nbPath = join(dir, "notebook.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeNotebook is atomic (no .tmp left behind on success)", async () => {
    await writeNotebook(nbPath, "hello\n");
    expect(readFileSync(nbPath, "utf-8")).toBe("hello\n");
    // tmp file shouldn't survive; rename should have moved it.
    expect(() => readFileSync(`${nbPath}.tmp`, "utf-8")).toThrow();
  });

  it("two parallel upsert+write cycles serialize via the lock — neither update is lost", async () => {
    await writeNotebook(nbPath, "");

    const invA: InvocationYaml = {
      invocationId: "inv-A",
      galaxyServerUrl: "https://x.org",
      notebookAnchor: "plan-1-step-1",
      label: "A",
      submittedAt: "2026-04-25T00:00:00Z",
      status: "in_progress",
    };
    const invB: InvocationYaml = {
      invocationId: "inv-B",
      galaxyServerUrl: "https://x.org",
      notebookAnchor: "plan-1-step-2",
      label: "B",
      submittedAt: "2026-04-25T00:00:01Z",
      status: "in_progress",
    };

    // Race two read-modify-write cycles. Without the lock they would both
    // read the empty file, each writes its own block, the second overwrites
    // the first → only one block survives.
    const work = (inv: InvocationYaml) =>
      withNotebookLock(nbPath, async () => {
        const content = await readNotebook(nbPath);
        await new Promise((r) => setTimeout(r, 5)); // amplify race window
        const updated = upsertInvocationBlock(content, inv);
        await writeNotebook(nbPath, updated);
      });

    await Promise.all([work(invA), work(invB)]);

    const final = readFileSync(nbPath, "utf-8");
    expect(final).toContain("invocation_id: inv-A");
    expect(final).toContain("invocation_id: inv-B");
  });

  it("lock releases even if work() throws", async () => {
    await writeNotebook(nbPath, "init\n");

    let secondRan = false;
    const failing = withNotebookLock(nbPath, async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    await withNotebookLock(nbPath, async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
  });
});

describe("writeNotebook staleness guard", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-stale-"));
    nbPath = join(dir, "notebook.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes when the file is untouched since the stamp was taken", async () => {
    await writeNotebook(nbPath, "one\n");
    const stamp = await statNotebook(nbPath);
    await writeNotebook(nbPath, "two\n", stamp ?? undefined);
    expect(readFileSync(nbPath, "utf-8")).toBe("two\n");
  });

  it("refuses the write, and leaves the file and tmp alone, when the file changed", async () => {
    await writeNotebook(nbPath, "one\n");
    const stamp = await statNotebook(nbPath);
    appendFileSync(nbPath, "appended out of band\n", "utf-8");

    await expect(writeNotebook(nbPath, "clobber\n", stamp ?? undefined)).rejects.toBeInstanceOf(
      NotebookChangedError,
    );
    expect(readFileSync(nbPath, "utf-8")).toBe("one\nappended out of band\n");
    expect(() => readFileSync(`${nbPath}.tmp`, "utf-8")).toThrow();
  });

  it("refuses the write when the file was deleted under us", async () => {
    await writeNotebook(nbPath, "one\n");
    const stamp = await statNotebook(nbPath);
    rmSync(nbPath);

    await expect(writeNotebook(nbPath, "recreated\n", stamp ?? undefined)).rejects.toBeInstanceOf(
      NotebookChangedError,
    );
    expect(() => readFileSync(nbPath, "utf-8")).toThrow();
  });

  it("skips the guard entirely when no stamp is supplied", async () => {
    await writeNotebook(nbPath, "one\n");
    appendFileSync(nbPath, "appended\n", "utf-8");
    await writeNotebook(nbPath, "unguarded\n");
    expect(readFileSync(nbPath, "utf-8")).toBe("unguarded\n");
  });

  it("statNotebook returns null for a missing file", async () => {
    expect(await statNotebook(join(dir, "nope.md"))).toBeNull();
  });
});

describe("applyInvocationUpdates", () => {
  const base: InvocationYaml = {
    invocationId: "inv-1",
    galaxyServerUrl: "https://x.org",
    notebookAnchor: "plan-1-step-1",
    label: "A",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
  };

  it("applies an update in place against the supplied content", () => {
    const content = `# Notes\n\n${renderInvocationYaml(base)}`;
    const { content: next, applied } = applyInvocationUpdates(content, [
      { ...base, status: "completed", lastPolledAt: "2026-04-25T01:00:00Z" },
    ]);
    expect(applied).toBe(1);
    expect(next).toContain("status: completed");
    expect(next).toContain("# Notes");
  });

  it("skips a block that is no longer in the content", () => {
    const { content, applied } = applyInvocationUpdates("# Notes\n\nnothing here\n", [
      { ...base, status: "completed" },
    ]);
    expect(applied).toBe(0);
    expect(content).toBe("# Notes\n\nnothing here\n");
  });

  it("skips an update older than the poll already recorded on disk", () => {
    const onDisk = renderInvocationYaml({
      ...base,
      status: "completed",
      lastPolledAt: "2026-04-25T02:00:00Z",
    });
    const { content, applied } = applyInvocationUpdates(onDisk, [
      { ...base, status: "in_progress", lastPolledAt: "2026-04-25T01:00:00Z" },
    ]);
    expect(applied).toBe(0);
    expect(content).toBe(onDisk);
    expect(content).toContain("status: completed");
  });

  it("applies when the block on disk has never been polled", () => {
    const { applied } = applyInvocationUpdates(renderInvocationYaml(base), [
      { ...base, status: "completed", lastPolledAt: "2026-04-25T01:00:00Z" },
    ]);
    expect(applied).toBe(1);
  });
});
