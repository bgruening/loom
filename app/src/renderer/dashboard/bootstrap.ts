/**
 * Wiring: everything app.ts needs to know about the dashboard is the handful of
 * setters returned here. Keeping it in this file is the point -- app.ts is a
 * 4.7k-line monolith and the place branches collide.
 */

import {
  createDefaultDashboardDocument,
  parseDashboardDocument,
  serializeDashboardDocument,
} from "../../../../shared/dashboard-contract.js";
import type { DashboardDocument } from "../../../../shared/dashboard-contract.js";
import type { FileNode } from "../../preload/preload.js";
import { DashboardHost } from "./host.js";
import { DashboardSources } from "./data-sources.js";
import type { SessionSnapshot } from "./widget-api.js";
// Side-effect import: fills the registry before the host renders anything.
import "./widgets/index.js";

const SAVE_DEBOUNCE_MS = 300;

const CORRUPT_BANNER =
  "The saved dashboard for this analysis could not be read, so this is the default one. " +
  "Your file has been left alone -- changing anything here will replace it.";

export interface DashboardBootstrap {
  host: DashboardHost;
  /** Notebook markdown the brain pushed. Drives the jobs and plan sources too. */
  setNotebook(markdown: string, path?: string | null): void;
  setSession(patch: Partial<Omit<SessionSnapshot, "updatedAt">>): void;
  /** Something on disk changed: re-read the activity log and the file tree. */
  refreshFromFiles(): void;
  /** A new analysis directory: drop the old data and load that workspace's layout. */
  reloadForCwd(): void;
}

type DashboardShell = {
  loadDashboard?: () => Promise<{ ok: true; raw: string | null } | { ok: false; error: string }>;
  saveDashboard?: (raw: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  readFile?: (
    relPath: string,
    opts?: { tail?: boolean },
  ) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error?: string }>;
  listFiles?: (opts?: {
    includeHidden?: boolean;
  }) => Promise<{ ok: true; root: FileNode } | { ok: false; error?: string }>;
};

export function initDashboard(container: HTMLElement): DashboardBootstrap {
  // Read through a narrow shape rather than the full OrbitAPI: the web shim
  // casts, so a method it never implemented is `undefined` at runtime however
  // the type reads. Every call below is guarded.
  const shell = window.orbit as unknown as DashboardShell;

  const sources = new DashboardSources({
    readFile: shell.readFile?.bind(window.orbit),
    listFiles: shell.listFiles?.bind(window.orbit),
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: DashboardDocument | null = null;
  // Same guard the notebook loader in app.ts uses: a load for the directory we
  // just left must not apply its document over the one we are switching to.
  let loadSeq = 0;

  const cancelPendingSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pending = null;
  };

  const flush = (): void => {
    saveTimer = null;
    const doc = pending;
    pending = null;
    if (!doc || typeof shell.saveDashboard !== "function") return;
    void Promise.resolve(shell.saveDashboard(serializeDashboardDocument(doc)))
      .then((res) => {
        if (!res.ok) console.error("[dashboard] save failed:", res.error);
      })
      .catch((err) => console.error("[dashboard] save failed:", err));
  };

  const host = new DashboardHost(container, {
    sources: sources.sources,
    persist: (doc) => {
      // A change made while the startup load is still in flight wins: otherwise
      // the load lands after it, puts the disk version back on screen, and the
      // queued save writes the user's version to disk. Screen and file disagree.
      loadSeq++;
      pending = doc;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
  });

  /**
   * Load this workspace's layout. A file that will not parse is left exactly as
   * it is on disk and reported in the banner -- losing someone's layout to a
   * parse bug is worse than showing them the default for one session.
   */
  const load = async (): Promise<void> => {
    const seq = ++loadSeq;
    host.setBanner("");
    if (typeof shell.loadDashboard !== "function") return;
    let res: { ok: true; raw: string | null } | { ok: false; error: string };
    try {
      res = await shell.loadDashboard();
    } catch (err) {
      console.error("[dashboard] load failed:", err);
      return;
    }
    if (seq !== loadSeq) return;
    if (!res.ok) {
      host.setBanner(`Could not read the saved dashboard: ${res.error}`);
      return;
    }
    // No file yet is the normal first run, not a problem worth a banner.
    if (res.raw === null || res.raw.trim() === "") return;

    const parsed = parseDashboardDocument(res.raw);
    if (!parsed.ok) {
      console.error("[dashboard] saved layout rejected:", parsed.problems);
      host.setBanner(CORRUPT_BANNER);
      return;
    }
    if (parsed.problems.length > 0) {
      console.warn("[dashboard] saved layout needed repairs:", parsed.problems);
    }
    host.setDocument(parsed.document, { persist: false });
  };

  void load();
  void sources.refreshActivity();
  void sources.refreshFiles();

  return {
    host,
    setNotebook: (markdown, path = null) => sources.setNotebook(markdown, path),
    setSession: (patch) => sources.setSession(patch),
    refreshFromFiles: () => {
      void sources.refreshActivity();
      void sources.refreshFiles();
    },
    reloadForCwd: () => {
      // A save queued against the previous analysis must not land in the new
      // one: the shell resolves the filename against whatever cwd is current
      // by the time the write happens.
      cancelPendingSave();
      sources.reset();
      // Back to the default first: the new workspace may have no layout of its
      // own, and `load` returning early must not leave the old one on screen.
      host.setDocument(createDefaultDashboardDocument(), { persist: false });
      void load();
      void sources.refreshActivity();
      void sources.refreshFiles();
    },
  };
}
