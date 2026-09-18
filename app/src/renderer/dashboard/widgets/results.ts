/**
 * Results widget -- a gallery of what the analysis has produced.
 *
 * The panel answers "what did it make, and can I recognise it": plots as
 * thumbnails, small delimited files as their first few rows, everything else
 * as a named row with its size. A panel can also be pinned to one file, so
 * "keep the volcano plot visible" is a single panel rather than a habit of
 * re-opening the files tree.
 *
 * Two rules shape the implementation:
 *
 *  - **No new way to read the disk.** Everything about *which* files exist
 *    comes from `ctx.sources.files`; everything about their *contents* goes
 *    through the cwd-jailed `orbit-artifact://` scheme the notebook figures and
 *    the File pane's markdown preview already use, via that pane's own
 *    `rewritePreviewImageHref`. The widget never touches `window.orbit`.
 *  - **File contents are hostile.** An SVG is a script carrier, so every image
 *    goes through `<img>` and nothing is ever built from file bytes as HTML.
 *    Table cells reach the DOM through `textContent`.
 */

import { extOf } from "../../files/image-preview.js";
import { rewritePreviewImageHref } from "../../files/markdown-preview.js";
import type { FileNode } from "../../../preload/preload.js";
import type { FilesSnapshot, WidgetDefinition, WidgetDispose } from "../widget-api.js";

type ResultsConfig = {
  /** `gallery` shows everything that matches; `pinned` shows one file. */
  mode: "gallery" | "pinned";
  /** Pinned mode: the cwd-relative file this panel keeps in view. */
  path?: string;
  /** Gallery mode: a glob narrowing what is considered a result. */
  glob?: string;
  /** How many entries a gallery draws. */
  limit: number;
};

export type ResultKind = "image" | "table" | "document" | "other";

export interface ResultFile {
  name: string;
  relPath: string;
  size: number;
  kind: ResultKind;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
// `.tabular` is Galaxy's name for a tab-delimited text file, and loom#269 is
// the reminder that a last-extension allowlist is the only thing keeping it
// out of the binary bucket.
const TABLE_EXTS = new Set([".csv", ".tsv", ".tab", ".tabular"]);
const DOCUMENT_EXTS = new Set([".pdf", ".html", ".htm", ".md", ".txt", ".log"]);

/** Files the workspace keeps for its own bookkeeping, not results. */
const HOUSEKEEPING = new Set(["notebook.md", "activity.jsonl", "session.jsonl"]);

const KIND_ORDER: Record<ResultKind, number> = { image: 0, table: 1, document: 2, other: 3 };

/** Past this a thumbnail costs more than it is worth; the file becomes a row. */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** How much of a delimited file is pulled across to draw a handful of rows. */
const TABLE_HEAD_BYTES = 32 * 1024;
/** A single cell wider than this is a wall of text, not a value. */
const MAX_CELL_CHARS = 60;

/** A glob is a few characters someone typed, never a payload. */
const MAX_GLOB_CHARS = 200;
/** However hostile the layout file is, a panel draws a panel's worth. */
const MAX_LIMIT = 60;

const GALLERY_TABLE_ROWS = 4;
const GALLERY_TABLE_COLS = 4;
const PINNED_TABLE_ROWS = 10;
const PINNED_TABLE_COLS = 8;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/**
 * What a file is, by its last extension. `sample.raw.counts.tsv` is a table and
 * `plot.v2.final.png` is an image; a compressed `counts.tsv.gz` is neither,
 * because nothing here can decompress it.
 */
export function classifyResult(relPath: string): ResultKind {
  const ext = extOf(relPath);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TABLE_EXTS.has(ext)) return "table";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  return "other";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A small glob dialect: `*` within a path segment, `**` across segments, `?`
 * for one character, and `{a,b}` alternation. A pattern with no `/` is matched
 * against the file name alone, so `*.png` finds `figures/volcano.png` -- which
 * is what someone typing it into a panel means.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` should also match zero directories, so `**/x` finds a root `x`.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(",");
        out += `(?:${alts.map(escapeRegExp).join("|")})`;
        i = close;
        continue;
      }
    }
    out += escapeRegExp(ch);
  }
  return new RegExp(`^${out}$`, "i");
}

export function matchesGlob(pattern: string, relPath: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return true;
  // A pattern is a handful of characters someone typed. Anything longer is
  // either a mistake or an attempt to make the matcher backtrack.
  if (trimmed.length > MAX_GLOB_CHARS) return false;
  const subject = trimmed.includes("/") ? relPath : (relPath.split("/").pop() ?? relPath);
  try {
    return globToRegExp(trimmed).test(subject);
  } catch {
    // A pattern that will not compile should narrow nothing rather than hide
    // every result behind a typo.
    return true;
  }
}

/** Flatten the file tree into result candidates, skipping the workspace's own bookkeeping. */
export function collectResultFiles(root: FileNode | null): ResultFile[] {
  const out: ResultFile[] = [];
  const walk = (entry: FileNode): void => {
    if (entry.type === "directory") {
      for (const child of entry.children ?? []) walk(child);
      return;
    }
    // Only at the root: `reports/notebook.md` is somebody's result, the one
    // beside the analysis is the log that already owns its own tab.
    if (entry.relPath === entry.name && HOUSEKEEPING.has(entry.name)) return;
    out.push({
      name: entry.name,
      relPath: entry.relPath,
      size: typeof entry.size === "number" ? entry.size : 0,
      kind: classifyResult(entry.relPath),
    });
  };
  if (root) walk(root);
  return out;
}

/**
 * Rank and cut the candidates. Plots first, then tables, then documents: the
 * order someone reviewing a result looks in. `files:list` carries no
 * modification time, so "newest first" is not available -- see the report.
 */
export function selectResults(
  files: ResultFile[],
  opts: { glob?: string; limit: number },
): { shown: ResultFile[]; total: number } {
  const matched = files.filter((f) => matchesGlob(opts.glob ?? "", f.relPath));
  matched.sort((a, b) => {
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    const depthA = a.relPath.split("/").length;
    const depthB = b.relPath.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.relPath.localeCompare(b.relPath);
  });
  const limit = normalizeLimit(opts.limit);
  return { shown: matched.slice(0, limit), total: matched.length };
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

/**
 * The panel's config arrives from a file a person or a model can write, so
 * every field is `unknown` however it is typed. Coerce once, here, rather than
 * guarding at each use.
 */
export function readResultsConfig(raw: Partial<ResultsConfig>): Required<ResultsConfig> {
  const value = raw as Record<string, unknown>;
  return {
    mode: value.mode === "pinned" ? "pinned" : "gallery",
    path: typeof value.path === "string" ? value.path : "",
    glob: typeof value.glob === "string" ? value.glob : "",
    limit: normalizeLimit(value.limit),
  };
}

export function delimiterFor(relPath: string): string {
  return extOf(relPath) === ".csv" ? "," : "\t";
}

/**
 * Split one line, honouring double-quoted fields with doubled quotes inside.
 * A quoted field containing a newline is not handled: this reads a head, and
 * the head is split into lines before it gets here.
 */
function splitRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  out.push(cell);
  return out;
}

export interface TablePreview {
  headers: string[];
  rows: string[][];
  /** Columns beyond `maxCols` that were dropped from every row. */
  extraColumns: number;
  /** True when rows were cut, either by `maxRows` or by the byte budget. */
  moreRows: boolean;
}

/**
 * First rows of a delimited file, capped in every direction. `partial` says the
 * text was cut at a byte budget, so the last line is dropped -- half a row of
 * numbers looks like a real row and is not one.
 */
export function parseDelimitedPreview(
  text: string,
  opts: { delimiter: string; maxRows: number; maxCols: number; partial?: boolean },
): TablePreview | null {
  const lines = text.split(/\r?\n/);
  if (opts.partial) lines.pop();
  const usable = lines.filter((line) => line.trim() !== "");
  if (usable.length === 0) return null;

  const cut = (cell: string): string =>
    cell.length > MAX_CELL_CHARS ? `${cell.slice(0, MAX_CELL_CHARS)}...` : cell;

  const parsed = usable
    .slice(0, opts.maxRows + 1)
    .map((line) => splitRow(line, opts.delimiter).map(cut));
  const widest = parsed.reduce((max, row) => Math.max(max, row.length), 0);
  const headers = (parsed[0] ?? []).slice(0, opts.maxCols);
  const rows = parsed.slice(1).map((row) => row.slice(0, opts.maxCols));

  return {
    headers,
    rows,
    extraColumns: Math.max(0, widest - opts.maxCols),
    moreRows: usable.length > parsed.length || Boolean(opts.partial),
  };
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * The cwd-jailed URL for a workspace file. `./` in front of the path stops a
 * legal-but-awkward file name like `run:1.png` from reading as a URL scheme
 * and passing through unrewritten -- the rewriter documents that prefix as the
 * way to force a relative reading. Returns "" for anything it cannot jail.
 */
export function artifactUrl(relPath: string, cacheKey?: number): string {
  const base = rewritePreviewImageHref("", `./${relPath}`);
  if (!base) return "";
  // The protocol handler reads only the path, so a query is a free cache-buster
  // for a plot that was overwritten in place.
  return cacheKey ? `${base}?v=${cacheKey}` : base;
}

// ── Reading a head over the artifact scheme ──────────────────────────────────

/**
 * Pull at most `budget` bytes and stop. The stream is cancelled rather than
 * drained, so a 2 GB counts table costs the same as a 2 KB one. Exported so
 * that "does not read more than it shows" is a test rather than a claim.
 */
export async function readHead(
  url: string,
  budget: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean } | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    if (!res.body) {
      const all = await res.text();
      return { text: all.slice(0, budget), truncated: all.length > budget };
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let seen = 0;
    let truncated = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value) continue;
      if (seen + value.byteLength >= budget) {
        text += decoder.decode(value.subarray(0, budget - seen));
        truncated = true;
        break;
      }
      seen += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return { text, truncated };
  } catch {
    // No artifact scheme in this shell, a CSP that will not allow the read, a
    // file that vanished: the entry falls back to a named row either way.
    return null;
  } finally {
    // Not awaited: the caller has what it needs, and a cancel on an
    // already-closed stream rejects rather than throwing.
    if (reader) void reader.cancel().catch(() => {});
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

const STYLES = `
.dash-results { padding: 0; }
.dash-results-list { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.dash-results-entry {
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-deep);
}
.dash-results-figure {
  display: block;
  width: 100%;
  max-height: 150px;
  object-fit: contain;
  background: var(--bg-deep);
}
.dash-results-figure.tall { max-height: 320px; }
.dash-results-caption {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 6px;
  background: var(--bg-surface);
  font-size: 11px;
}
.dash-results-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font, monospace);
  color: var(--text);
}
.dash-results-meta { color: var(--dash-text-meta); white-space: nowrap; font-size: 10px; }
.dash-results-table-wrap { overflow-x: auto; }
.dash-results-table { border-collapse: collapse; font-size: 10px; width: 100%; }
.dash-results-table th,
.dash-results-table td {
  padding: 2px 6px;
  text-align: left;
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid var(--border);
}
.dash-results-table th { color: var(--dash-text-meta); font-weight: 600; }
.dash-results-table td { font-family: var(--font, monospace); }
.dash-results-note { padding: 2px 6px; font-size: 10px; color: var(--dash-text-meta); }
.dash-results-empty { padding: 10px; font-size: 12px; line-height: 1.5; color: var(--dash-text-meta); }
/* Visible without a hover: a control that only appears under a mouse is a
   control a keyboard or a touchscreen never finds. */
.dash-results-pin { opacity: 0.55; }
.dash-results-entry:hover .dash-results-pin,
.dash-results-pin:focus-visible { opacity: 1; }
`;

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

export const resultsWidget: WidgetDefinition<ResultsConfig> = {
  type: "results",
  label: "Results",
  description: "Images, tables and files the analysis produced.",
  defaultConfig: { mode: "gallery", path: "", glob: "", limit: 8 },

  mount(el, ctx): WidgetDispose {
    el.classList.add("dash-results");
    // The stylesheet lives with the widget rather than in dashboard.css, which
    // this branch does not own. Scoped by prefix and thrown away with the panel.
    const style = document.createElement("style");
    style.textContent = STYLES;
    const list = node("div", "dash-results-list");
    el.append(style, list);

    const count = node("span", "dash-results-meta");
    ctx.header.append(count);

    const showAll = node("button", "dash-panel-btn", "show all");
    showAll.type = "button";
    showAll.hidden = true;
    showAll.title = "Go back to every result in this folder";
    showAll.addEventListener("click", () => ctx.setConfig({ mode: "gallery", path: "" }));
    ctx.header.append(showAll);

    let controller = new AbortController();
    let signature = "";
    ctx.onDispose(() => controller.abort());

    const config = readResultsConfig(ctx.config);
    const pinned = config.mode === "pinned";
    const tableRows = pinned ? PINNED_TABLE_ROWS : GALLERY_TABLE_ROWS;
    const tableCols = pinned ? PINNED_TABLE_COLS : GALLERY_TABLE_COLS;

    const addCaption = (entry: HTMLElement, file: ResultFile): void => {
      const caption = node("div", "dash-results-caption");
      const name = node("span", "dash-results-name", file.name);
      name.title = file.relPath;
      caption.append(name);
      const size = formatSize(file.size);
      if (size) caption.append(node("span", "dash-results-meta", size));
      if (!pinned) {
        const pin = node("button", "dash-panel-btn dash-results-pin", "pin");
        pin.type = "button";
        pin.title = `Keep ${file.name} in this panel`;
        pin.addEventListener("click", () => ctx.setConfig({ mode: "pinned", path: file.relPath }));
        caption.append(pin);
      }
      entry.append(caption);
    };

    const renderTable = (entry: HTMLElement, file: ResultFile, token: AbortSignal): void => {
      const url = artifactUrl(file.relPath, file.size);
      if (!url) return;
      void readHead(url, TABLE_HEAD_BYTES, token).then((head) => {
        if (token.aborted || !head) return;
        const preview = parseDelimitedPreview(head.text, {
          delimiter: delimiterFor(file.relPath),
          maxRows: tableRows,
          maxCols: tableCols,
          partial: head.truncated,
        });
        if (!preview) return;
        const wrap = node("div", "dash-results-table-wrap");
        const table = node("table", "dash-results-table");
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const header of preview.headers) headRow.append(node("th", undefined, header));
        thead.append(headRow);
        const tbody = document.createElement("tbody");
        for (const row of preview.rows) {
          const tr = document.createElement("tr");
          for (const cell of row) tr.append(node("td", undefined, cell));
          tbody.append(tr);
        }
        table.append(thead, tbody);
        wrap.append(table);
        entry.prepend(wrap);
        const notes: string[] = [];
        if (preview.moreRows) notes.push(`first ${preview.rows.length} rows`);
        if (preview.extraColumns > 0) {
          notes.push(`${preview.extraColumns} more column${preview.extraColumns === 1 ? "" : "s"}`);
        }
        if (notes.length) wrap.after(node("div", "dash-results-note", notes.join(", ")));
      });
    };

    const renderEntry = (file: ResultFile, token: AbortSignal): HTMLElement => {
      const entry = node("div", "dash-results-entry");
      if (file.kind === "image" && file.size <= IMAGE_MAX_BYTES) {
        const url = artifactUrl(file.relPath, file.size);
        if (url) {
          // Always an <img>. An SVG is active content and inlining one would
          // run whatever a tool wrote into it.
          const img = node("img", pinned ? "dash-results-figure tall" : "dash-results-figure");
          img.src = url;
          img.alt = file.name;
          img.loading = "lazy";
          img.addEventListener("error", () => img.remove());
          entry.append(img);
        }
      } else if (file.kind === "table") {
        renderTable(entry, file, token);
      }
      addCaption(entry, file);
      return entry;
    };

    const draw = (snapshot: FilesSnapshot): void => {
      const files = collectResultFiles(snapshot.root);
      const pinnedFile = pinned ? (files.find((f) => f.relPath === config.path) ?? null) : null;
      const selection = pinned
        ? { shown: pinnedFile ? [pinnedFile] : [], total: pinnedFile ? 1 : 0 }
        : selectResults(files, { glob: config.glob, limit: config.limit });

      const next = [
        snapshot.available ? "on" : "off",
        config.mode,
        config.path,
        config.glob,
        String(config.limit),
        ...selection.shown.map((f) => `${f.relPath}:${f.size}`),
      ].join("|");
      if (next === signature) return;
      signature = next;

      controller.abort();
      controller = new AbortController();
      const token = controller.signal;
      list.textContent = "";

      showAll.hidden = !pinned;
      count.textContent =
        !snapshot.available || pinned || selection.total === 0
          ? ""
          : selection.total > selection.shown.length
            ? `${selection.shown.length} of ${selection.total}`
            : `${selection.total} ${selection.total === 1 ? "file" : "files"}`;

      if (!snapshot.available) {
        list.append(
          node(
            "div",
            "dash-results-empty",
            "This shell cannot list the analysis folder yet, so results cannot be shown here.",
          ),
        );
        return;
      }

      if (selection.shown.length === 0) {
        const message = pinned
          ? `Nothing at ${config.path || "that path"} yet. It will appear here as soon as a step writes it.`
          : config.glob
            ? `No files match ${config.glob} yet.`
            : "Nothing to show yet. Plots, tables and the files the analysis writes land here.";
        list.append(node("div", "dash-results-empty", message));
        return;
      }

      for (const file of selection.shown) list.append(renderEntry(file, token));
    };

    ctx.subscribe(ctx.sources.files, draw);

    return () => {
      controller.abort();
      el.classList.remove("dash-results");
      el.textContent = "";
    };
  },
};
