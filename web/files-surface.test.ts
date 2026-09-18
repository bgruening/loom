import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listFilesForWeb, readFileForWeb, resolveInJail } from "./files-surface.js";
import type { FileNode } from "../app/src/preload/preload.js";

// A home the fixtures are not inside, so the sensitive-path policy's
// home-relative rules stay out of the way and only its basename rules fire.
const HOME = path.join(os.tmpdir(), "files-surface-home");

// ── The jail, as a pure function ─────────────────────────────────────────────

describe("resolveInJail", () => {
  const CWD = path.join(path.sep, "tmp", "analysis");
  const jail = (p: unknown) => resolveInJail(CWD, p, { home: HOME });

  it("accepts a plain file in the analysis directory", () => {
    expect(jail("notebook.md")).toEqual({
      ok: true,
      abs: path.join(CWD, "notebook.md"),
      rel: "notebook.md",
    });
  });

  it("accepts a nested file and normalizes a leading ./", () => {
    expect(jail("results/plot.png")).toMatchObject({ ok: true, rel: "results/plot.png" });
    expect(jail("./notebook.md")).toMatchObject({ ok: true, rel: "notebook.md" });
  });

  it.each([["../secrets.txt"], ["a/../../b"], ["results/../../etc/passwd"], [".."], ["."]])(
    "refuses %s as leaving the working directory",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "path leaves the working directory" });
    },
  );

  it.each([["/etc/passwd"], ["C:\\Windows\\win.ini"], ["\\\\server\\share\\x"], ["/"]])(
    "refuses the absolute path %s",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "absolute paths are not served" });
    },
  );

  it("refuses a NUL, which would truncate the path at the syscall", () => {
    expect(jail("notebook.md\u0000.png")).toEqual({ ok: false, error: "invalid file path" });
  });

  it.each([[""], ["   "], [null], [undefined], [42], [{}], [["notebook.md"]]])(
    "refuses %o as not a path",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "a file path is required" });
    },
  );

  // Nothing between the browser and here URL-decodes, so percent-encoding is
  // just an unusual filename -- it must stay inside rather than escape.
  it("treats percent-encoded traversal as a literal name", () => {
    const res = jail("%2e%2e%2fetc%2fpasswd");
    expect(res).toMatchObject({ ok: true, rel: "%2e%2e%2fetc%2fpasswd" });
    if (res.ok) expect(res.abs.startsWith(CWD + path.sep)).toBe(true);
  });

  it("refuses a half-encoded traversal, which reads as a dot-prefixed name", () => {
    expect(jail("..%2f..%2fetc/passwd")).toEqual({
      ok: false,
      error: "hidden files are not served",
    });
  });

  it.each([[".env"], [".git/config"], ["sub/.hidden/x"], [".loom-dashboard.json"]])(
    "refuses the hidden path %s",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "hidden files are not served" });
    },
  );

  it.each([["node_modules/pkg/index.js"], ["venv/bin/python"], ["__pycache__/m.pyc"]])(
    "refuses %s as a directory the tree does not serve",
    (p) => {
      expect(jail(p)).toEqual({ ok: false, error: "that directory is not served" });
    },
  );

  it.each([["id_rsa"], ["keys/server.pem"], ["deploy.key"], ["credentials"], ["ID_ED25519"]])(
    "refuses %s under the sensitive-path policy",
    (p) => {
      expect(jail(p)).toEqual({
        ok: false,
        error: "that file matches the sensitive-path policy",
      });
    },
  );
});

// ── Against a real directory ─────────────────────────────────────────────────

const MAX_READ_BYTES = 5 * 1024 * 1024;

let cwd: string;
let outside: string;

function child(root: FileNode, name: string): FileNode | undefined {
  return (root.children ?? []).find((c) => c.name === name);
}

function names(root: FileNode): string[] {
  return (root.children ?? []).map((c) => c.name);
}

async function readText(rel: string, opts?: { tail?: boolean }): Promise<string> {
  const res = await readFileForWeb(cwd, rel, opts, { home: HOME });
  if (!res.ok) throw new Error(`expected a read, got: ${res.error}`);
  return Buffer.from(res.bytesBase64, "base64").toString("utf-8");
}

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-cwd-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");

  fs.writeFileSync(path.join(cwd, "notebook.md"), "# hello\n");
  fs.writeFileSync(
    path.join(cwd, "activity.jsonl"),
    Array.from({ length: 300 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n",
  );
  fs.mkdirSync(path.join(cwd, "data", "nested"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "data", "table.tsv"), "a\tb\n1\t2\n");
  fs.writeFileSync(path.join(cwd, "data", "nested", "deep.txt"), "deep\n");

  const binary = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) binary[i] = i;
  fs.writeFileSync(path.join(cwd, "image.bin"), binary);

  // Things the surface must not serve.
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1\n");
  fs.mkdirSync(path.join(cwd, ".hidden"));
  fs.writeFileSync(path.join(cwd, ".hidden", "x.txt"), "x\n");
  fs.mkdirSync(path.join(cwd, "node_modules"));
  fs.writeFileSync(path.join(cwd, "node_modules", "pkg.js"), "//\n");
  fs.writeFileSync(path.join(cwd, "id_rsa"), "PRIVATE KEY\n");

  // Symlinks: out of the jail, into it, a cycle, and an innocent name over a
  // sensitive target.
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "link-out"));
  fs.symlinkSync(outside, path.join(cwd, "dir-out"));
  fs.symlinkSync("loop-b", path.join(cwd, "loop-a"));
  fs.symlinkSync("loop-a", path.join(cwd, "loop-b"));
  fs.symlinkSync(path.join(cwd, "notebook.md"), path.join(cwd, "link-in"));
  fs.symlinkSync(path.join(cwd, "id_rsa"), path.join(cwd, "notes.txt"));

  // Deeper than the depth cap.
  let deep = cwd;
  for (let i = 1; i <= 11; i++) {
    deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep);
    fs.writeFileSync(path.join(deep, "marker.txt"), `${i}\n`);
  }
});

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("listFilesForWeb", () => {
  it("returns the analysis directory with directories first", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cwd).toBe(cwd);
    expect(res.root).toMatchObject({ name: path.basename(cwd), relPath: "", type: "directory" });
    const listed = names(res.root);
    expect(listed).toContain("notebook.md");
    expect(listed).toContain("activity.jsonl");
    const firstFile = listed.findIndex((n) => n === "notebook.md");
    const lastDir = listed.findIndex((n) => n === "data");
    expect(lastDir).toBeLessThan(firstFile);
  });

  it("carries file sizes and nested children", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    expect(child(res.root, "notebook.md")).toMatchObject({ type: "file", size: 8 });
    const data = child(res.root, "data");
    expect(names(data!)).toEqual(["nested", "table.tsv"]);
  });

  it("does not serve hidden entries, noise directories or sensitive names", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    const listed = names(res.root);
    for (const hidden of [".env", ".hidden", "node_modules", "id_rsa"]) {
      expect(listed).not.toContain(hidden);
    }
  });

  // Listing an entry the read side will refuse discloses the name and size of a
  // file outside the workspace and offers a click that can only fail.
  it("leaves out symlinks whose target is outside the jail", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    const listed = names(res.root);
    expect(listed).not.toContain("link-out");
    expect(listed).not.toContain("dir-out");
    expect(listed).not.toContain("loop-a");
    expect(listed).not.toContain("notes.txt");
  });

  it("keeps a symlink that stays inside the jail", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    expect(child(res.root, "link-in")).toMatchObject({ type: "file" });
  });

  it("stops at the depth cap", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    let node = child(res.root, "d1");
    let depth = 1;
    while (node && (node.children ?? []).length > 0) {
      const next = (node.children ?? []).find((c) => c.type === "directory");
      if (!next) break;
      node = next;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(9);
    expect(depth).toBeGreaterThan(1);
  });

  it("stops at the entry cap", async () => {
    const res = await listFilesForWeb(cwd, { home: HOME, maxEntries: 3 });
    if (!res.ok) throw new Error(res.error);
    const count = (node: FileNode): number =>
      (node.children ?? []).reduce((n, c) => n + 1 + count(c), 0);
    expect(count(res.root)).toBe(3);
  });

  it("is unavailable in remote mode", async () => {
    expect(await listFilesForWeb(cwd, { home: HOME, remote: true })).toEqual({
      ok: false,
      error: "file listing is unavailable in remote mode",
    });
  });
});

describe("readFileForWeb", () => {
  it("reads a text file", async () => {
    const res = await readFileForWeb(cwd, "notebook.md", undefined, { home: HOME });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.size).toBe(8);
    expect(res.preview).toBeUndefined();
    expect(Buffer.from(res.bytesBase64, "base64").toString("utf-8")).toBe("# hello\n");
  });

  it("round-trips binary bytes", async () => {
    const res = await readFileForWeb(cwd, "image.bin", null, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    const bytes = Buffer.from(res.bytesBase64, "base64");
    expect(bytes.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(bytes[i]).toBe(i);
  });

  it("reads through a symlink that stays inside the jail", async () => {
    expect(await readText("link-in")).toBe("# hello\n");
  });

  it("reads a nested file", async () => {
    expect(await readText("data/nested/deep.txt")).toBe("deep\n");
  });

  it("refuses a missing file without naming the absolute path", async () => {
    const res = await readFileForWeb(cwd, "nope.txt", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "no such file" });
  });

  it("refuses a directory", async () => {
    const res = await readFileForWeb(cwd, "data", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "Not a regular file" });
  });

  it("refuses a symlink that points out of the jail", async () => {
    const res = await readFileForWeb(cwd, "link-out", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "path leaves the working directory" });
  });

  it("refuses a symlink cycle rather than hanging on it", async () => {
    const res = await readFileForWeb(cwd, "loop-a", undefined, { home: HOME });
    expect(res.ok).toBe(false);
  });

  // The jail has to hold on the target's name as well as the link's, or an
  // innocuous name is a way around the sensitive-path policy.
  it("refuses an innocent name that resolves onto a sensitive one", async () => {
    const res = await readFileForWeb(cwd, "notes.txt", undefined, { home: HOME });
    expect(res).toEqual({
      ok: false,
      error: "that file matches the sensitive-path policy",
    });
  });

  it("refuses a traversal before it touches the disk", async () => {
    const res = await readFileForWeb(cwd, "../secret.txt", undefined, { home: HOME });
    expect(res).toEqual({ ok: false, error: "path leaves the working directory" });
  });

  it("is unavailable in remote mode", async () => {
    expect(
      await readFileForWeb(cwd, "notebook.md", undefined, { home: HOME, remote: true }),
    ).toEqual({ ok: false, error: "file read is unavailable in remote mode" });
  });
});

// Orbit's default workspace is ~/.loom/analyses/<name>, which sits under two
// dotted segments and inside the directory holding ~/.loom/config.json. If the
// sensitive-path policy read that as a credential store the whole surface would
// be dead in the default configuration.
describe("the default Orbit workspace", () => {
  it("serves an analysis that lives under ~/.loom/analyses", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "files-surface-loomhome-"));
    const analysis = path.join(home, ".loom", "analyses", "demo");
    fs.mkdirSync(analysis, { recursive: true });
    fs.writeFileSync(path.join(home, ".loom", "config.json"), "{}");
    fs.writeFileSync(path.join(analysis, "notebook.md"), "# demo\n");
    try {
      const listed = await listFilesForWeb(analysis, { home });
      expect(listed.ok && names(listed.root)).toEqual(["notebook.md"]);
      const read = await readFileForWeb(analysis, "notebook.md", undefined, { home });
      expect(read.ok).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("readFileForWeb tail", () => {
  it("returns the last 200 lines of a short file", async () => {
    const text = await readText("activity.jsonl", { tail: true });
    // The trailing newline costs one slot of the 200-line window, exactly as it
    // does on the desktop.
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(199);
    expect(JSON.parse(lines[lines.length - 1]).n).toBe(299);
    expect(JSON.parse(lines[0]).n).toBe(101);
  });

  it("drops the partial first line when it starts mid-file", async () => {
    const wide = path.join(cwd, "wide.jsonl");
    const line = (n: number) => JSON.stringify({ n, pad: "y".repeat(120) });
    fs.writeFileSync(wide, Array.from({ length: 2000 }, (_, i) => line(i)).join("\n") + "\n");
    const text = await readText("wide.jsonl", { tail: true });
    const lines = text.split("\n").filter(Boolean);
    // Every line that comes back parses -- none of them is a fragment.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[lines.length - 1]).n).toBe(1999);
    fs.rmSync(wide, { force: true });
  });
});

describe("readFileForWeb size caps", () => {
  it("head-previews a text file over the full-read cap", async () => {
    const big = path.join(cwd, "big.txt");
    const head = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
    fs.writeFileSync(big, head + "x".repeat(MAX_READ_BYTES));
    const res = await readFileForWeb(cwd, "big.txt", undefined, { home: HOME });
    if (!res.ok) throw new Error(res.error);
    expect(res.size).toBeGreaterThan(MAX_READ_BYTES);
    expect(res.preview).toEqual({ kind: "head", lineCount: 10, byteBudgetHit: false });
    expect(Buffer.from(res.bytesBase64, "base64").toString("utf-8").split("\n")).toHaveLength(10);
    fs.rmSync(big, { force: true });
  });

  it("refuses a non-text file over the full-read cap", async () => {
    const big = path.join(cwd, "big.png");
    fs.writeFileSync(big, Buffer.alloc(MAX_READ_BYTES + 1));
    const res = await readFileForWeb(cwd, "big.png", undefined, { home: HOME });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/File too large/);
    expect(res.size).toBe(MAX_READ_BYTES + 1);
    fs.rmSync(big, { force: true });
  });

  it("refuses a pathological size outright, text or not", async () => {
    const huge = path.join(cwd, "huge.txt");
    const fd = fs.openSync(huge, "w");
    try {
      fs.ftruncateSync(fd, 2 * 1024 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    const res = await readFileForWeb(cwd, "huge.txt", undefined, { home: HOME });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/hard limit/);
    fs.rmSync(huge, { force: true });
  });
});
