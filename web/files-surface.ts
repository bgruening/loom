/**
 * Read-only file surface for the web shell.
 *
 * The desktop answers `files:list` / `files:read` from the main process, whose
 * only client is a preload-bridged renderer in the same process tree. Here the
 * client is a browser on the other end of a socket, so the same two calls are a
 * network surface onto the analysis directory and the jail is most of the work:
 * every path is clamped to the session cwd by path math, then resolved through
 * `realpath` so a symlink cannot step outside it, and refused outright when it
 * names a dotfile, one of the directories the desktop tree hides, or something
 * the agent's own sensitive-path policy will not let the model read.
 *
 * `files:write` is deliberately not here. The desktop has it; there is no reason
 * to put a writer on a socket for a pane that only displays.
 *
 * Response shapes match `OrbitAPI.listFiles` / `OrbitAPI.readFile` exactly, with
 * one substitution: `bytes` travels as base64 in `bytesBase64` because the
 * transport is JSON. `web/files-wire.ts` turns it back into the `Uint8Array` the
 * renderer is typed against.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

import type { FileNode } from "../app/src/preload/preload.js";
import { isTextLikeForPreview } from "../app/src/main/file-preview-classification.js";
import { isSensitivePath } from "../extensions/loom/exec-guard/sensitive-read.js";

// Mirrors files-handler.ts. Kept in step by hand because that module imports
// `electron` at the top level, which cannot be loaded from here or from a test.
const MAX_DEPTH = 8;
const MAX_ENTRIES_PER_DIR = 2000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1024 * 1024 * 1024;
const PREVIEW_LINE_COUNT = 10;
const PREVIEW_BYTE_BUDGET = 64 * 1024;
const TAIL_LINE_COUNT = 200;

/**
 * A whole-tree ceiling the desktop does not have. Its per-directory cap still
 * allows 2000 entries at each of eight levels, which is a fine amount of work
 * for a local IPC call and a bad amount of JSON to push down a socket.
 */
const MAX_TOTAL_ENTRIES = 20000;

/**
 * The non-hidden names files-handler.ts's FS_BLOCKLIST drops. The dotted ones it
 * also lists are covered by the blanket dotfile rule below, so only these three
 * need naming.
 */
const NOISE_DIRS = new Set(["node_modules", "venv", "__pycache__"]);

export interface FilesSurfaceOptions {
  /**
   * LOOM_MODE=remote. The container deployment curates the filesystem away
   * entirely -- the brain's read tool is pinned to notebook.md and bash/ls/find
   * are blocked -- so the shell must not hand the browser a wider view than the
   * agent running beside it has.
   */
  remote?: boolean;
  /** $HOME for the sensitive-path policy. Injectable so a test does not depend on the runner's. */
  home?: string;
}

export type WebFileReadResult =
  | {
      ok: true;
      size: number;
      bytesBase64: string;
      preview?: { kind: "head"; lineCount: number; byteBudgetHit: boolean };
    }
  | { ok: false; error: string; size?: number };

export type WebFileListResult =
  { ok: true; root: FileNode; cwd: string } | { ok: false; error: string };

export type JailResult = { ok: true; abs: string; rel: string } | { ok: false; error: string };

const REMOTE_LIST_REFUSAL = "file listing is unavailable in remote mode";
const REMOTE_READ_REFUSAL = "file read is unavailable in remote mode";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Why this segment may not appear in a path the browser asked for, or null when
 * it may. Applied to every segment of the clamped relative path, and again to
 * the relative real path once symlinks are collapsed, so a benign-looking name
 * pointing at `.env` is refused on the target rather than on the link.
 */
function segmentRefusal(segment: string): string | null {
  if (segment === "" || segment === ".") return null;
  if (segment === "..") return "path leaves the working directory";
  if (segment.startsWith(".")) return "hidden files are not served";
  if (NOISE_DIRS.has(segment)) return "that directory is not served";
  return null;
}

function pathRefusal(rel: string, abs: string, home: string): string | null {
  for (const segment of rel.split(path.sep)) {
    const refusal = segmentRefusal(segment);
    if (refusal) return refusal;
  }
  // The agent is refused these outright inside the workspace; a socket should
  // not be a way around that.
  if (isSensitivePath(abs, home)) return "that file matches the sensitive-path policy";
  return null;
}

/**
 * Clamp a browser-supplied path to the session cwd. Pure: string and path math
 * only, so the whole refusal table is testable without a filesystem. The
 * symlink question is separate and needs `realpath` -- see `resolveRealWithin`.
 */
export function resolveInJail(
  cwd: string,
  relPath: unknown,
  options: FilesSurfaceOptions = {},
): JailResult {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    return { ok: false, error: "a file path is required" };
  }
  // A NUL truncates the path at the syscall boundary, so `notebook.md\0.png`
  // would pass an extension check and open something else.
  if (relPath.includes("\0")) return { ok: false, error: "invalid file path" };
  // path.isAbsolute is posix-only on posix, so name the Windows forms too --
  // this server is the same code on either platform.
  if (path.isAbsolute(relPath) || /^[/\\]/.test(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    return { ok: false, error: "absolute paths are not served" };
  }

  const abs = path.resolve(cwd, path.normalize(relPath));
  const rel = path.relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "path leaves the working directory" };
  }

  const refusal = pathRefusal(rel, abs, options.home ?? homedir());
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, abs, rel: toPosix(rel) };
}

/**
 * The half of the jail that needs the disk: the target's real path has to stay
 * inside the cwd's real path, and the policy above has to hold for the real name
 * too. Throws nothing -- an ELOOP from a symlink cycle or an ENOENT comes back
 * as a refusal.
 */
async function resolveRealWithin(
  cwd: string,
  abs: string,
  home: string,
): Promise<{ ok: true; real: string } | { ok: false; error: string }> {
  let cwdReal: string;
  let real: string;
  try {
    cwdReal = await fsp.realpath(cwd);
  } catch {
    return { ok: false, error: "the working directory is not readable" };
  }
  try {
    real = await fsp.realpath(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") return { ok: false, error: "path leaves the working directory" };
    return { ok: false, error: "no such file" };
  }
  if (real !== cwdReal && !real.startsWith(cwdReal + path.sep)) {
    return { ok: false, error: "path leaves the working directory" };
  }
  const refusal = pathRefusal(path.relative(cwdReal, real), real, home);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, real };
}

/** Whether a directory's real path stays inside the cwd, so it is safe to descend. */
async function isWithinCwd(cwd: string, p: string): Promise<boolean> {
  try {
    const cwdReal = await fsp.realpath(cwd);
    const pReal = await fsp.realpath(p);
    return pReal === cwdReal || pReal.startsWith(cwdReal + path.sep);
  } catch {
    return false;
  }
}

interface WalkBudget {
  remaining: number;
}

async function walkDir(
  cwd: string,
  relDir: string,
  depth: number,
  home: string,
  budget: WalkBudget,
): Promise<FileNode[]> {
  if (depth > MAX_DEPTH || budget.remaining <= 0) return [];
  const absDir = path.resolve(cwd, relDir);

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.length > MAX_ENTRIES_PER_DIR) entries = entries.slice(0, MAX_ENTRIES_PER_DIR);

  const out: FileNode[] = [];
  for (const e of entries) {
    if (budget.remaining <= 0) break;
    const absPath = path.join(absDir, e.name);
    // Same table the read path uses, so the tree never shows something a click
    // would then be refused.
    if (segmentRefusal(e.name) || isSensitivePath(absPath, home)) continue;

    const childRel = toPosix(path.join(relDir, e.name));

    let isDir = e.isDirectory();
    let isFile = e.isFile();
    let recurse = isDir;
    if (e.isSymbolicLink()) {
      try {
        const target = await fsp.stat(absPath);
        isDir = target.isDirectory();
        isFile = target.isFile();
        recurse = isDir && (await isWithinCwd(cwd, absPath));
      } catch {
        isDir = false;
        isFile = true;
      }
    }

    if (isDir) {
      budget.remaining--;
      out.push({
        name: e.name,
        relPath: childRel,
        type: "directory",
        children: recurse ? await walkDir(cwd, childRel, depth + 1, home, budget) : [],
      });
    } else if (isFile) {
      budget.remaining--;
      let size: number | undefined;
      try {
        size = (await fsp.stat(absPath)).size;
      } catch {
        size = undefined;
      }
      out.push({ name: e.name, relPath: childRel, type: "file", size });
    }
    // Sockets / fifos / devices stay out, as on the desktop.
  }

  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * `files:list`. The desktop takes `includeHidden` from a sidebar toggle; this
 * surface ignores it and never serves hidden entries, because the read side
 * refuses them and a tree you cannot open is worse than a tree that is honest
 * about what it shows.
 */
export async function listFilesForWeb(
  cwd: string,
  options: FilesSurfaceOptions = {},
): Promise<WebFileListResult> {
  if (options.remote) return { ok: false, error: REMOTE_LIST_REFUSAL };
  const home = options.home ?? homedir();
  try {
    const children = await walkDir(cwd, "", 0, home, { remaining: MAX_TOTAL_ENTRIES });
    return {
      ok: true,
      root: { name: path.basename(cwd) || cwd, relPath: "", type: "directory", children },
      cwd,
    };
  } catch {
    return { ok: false, error: "the working directory could not be listed" };
  }
}

/**
 * `files:read`. Byte budgets and the tail/head preview behaviour are the
 * desktop's; the jail, and a fixed message for anything unexpected, are this
 * surface's. An `err.message` from fs names the absolute path it failed on, so
 * none of them cross.
 */
export async function readFileForWeb(
  cwd: string,
  relPath: unknown,
  opts?: { tail?: boolean } | null,
  options: FilesSurfaceOptions = {},
): Promise<WebFileReadResult> {
  if (options.remote) return { ok: false, error: REMOTE_READ_REFUSAL };
  const home = options.home ?? homedir();

  const jailed = resolveInJail(cwd, relPath, { home });
  if (!jailed.ok) return jailed;
  const real = await resolveRealWithin(cwd, jailed.abs, home);
  if (!real.ok) return { ok: false, error: real.error };

  try {
    const stat = await fsp.stat(real.real);
    if (!stat.isFile()) return { ok: false, error: "Not a regular file" };

    if (opts?.tail) {
      const readSize = Math.min(stat.size, PREVIEW_BYTE_BUDGET);
      const offset = stat.size - readSize;
      const fd = await fsp.open(real.real, "r");
      try {
        const tailBuf = Buffer.alloc(readSize);
        const { bytesRead } = await fd.read(tailBuf, 0, readSize, offset);
        const lines = tailBuf.subarray(0, bytesRead).toString("utf-8").split("\n");
        // A non-zero offset means the first element is half a line (or half a
        // multibyte character); drop it rather than ship a fragment.
        if (offset > 0 && lines.length > 1) lines.shift();
        return {
          ok: true,
          size: stat.size,
          bytesBase64: Buffer.from(lines.slice(-TAIL_LINE_COUNT).join("\n"), "utf-8").toString(
            "base64",
          ),
        };
      } finally {
        await fd.close();
      }
    }

    if (stat.size <= MAX_READ_BYTES) {
      const buf = await fsp.readFile(real.real);
      return { ok: true, size: stat.size, bytesBase64: buf.toString("base64") };
    }

    if (stat.size > MAX_PREVIEW_BYTES) {
      return {
        ok: false,
        error: `File too large (${stat.size} bytes, hard limit ${MAX_PREVIEW_BYTES})`,
        size: stat.size,
      };
    }

    if (!isTextLikeForPreview(path.basename(real.real))) {
      return {
        ok: false,
        error: `File too large (${stat.size} bytes, limit ${MAX_READ_BYTES})`,
        size: stat.size,
      };
    }

    const fd = await fsp.open(real.real, "r");
    try {
      const headBuf = Buffer.alloc(PREVIEW_BYTE_BUDGET);
      const { bytesRead } = await fd.read(headBuf, 0, PREVIEW_BYTE_BUDGET, 0);
      const head = headBuf.subarray(0, bytesRead).toString("utf-8");
      const lines = head.split("\n").slice(0, PREVIEW_LINE_COUNT);
      return {
        ok: true,
        size: stat.size,
        bytesBase64: Buffer.from(lines.join("\n"), "utf-8").toString("base64"),
        preview: {
          kind: "head",
          lineCount: lines.length,
          byteBudgetHit: bytesRead === PREVIEW_BYTE_BUDGET && lines.length < PREVIEW_LINE_COUNT,
        },
      };
    } finally {
      await fd.close();
    }
  } catch {
    return { ok: false, error: "the file could not be read" };
  }
}
