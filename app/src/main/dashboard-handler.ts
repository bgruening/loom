/**
 * Dashboard layout persistence -- main-process IPC.
 *
 * One file per analysis, beside notebook.md. Neither handler takes a path: the
 * filename is fixed, so there is no traversal surface to guard, and the cwd
 * clamp is still applied through `resolveWithin` for the same reason the files
 * sidebar applies it.
 *
 * Text in, text out. Validation is the renderer's job through
 * shared/dashboard-contract, so there is exactly one implementation of it.
 *
 * Both handlers lstat first. The agent can write inside the analysis directory,
 * so it can put a symlink at this filename; `resolveWithin` is string math and
 * `writeFile` follows symlinks, which would turn an automatic background layout
 * save into an unconsented overwrite of whatever the link points at.
 *
 * Three things will write this file -- the pane's editor, a widget's own config
 * change, and the brain -- so a save carries the revision it was based on and is
 * refused if the file moved underneath it, and the write itself is a temp file
 * plus a rename so a reader never sees half a document.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { createIdempotentIpc } from "./ipc-registry.js";
import { resolveWithin } from "./files-handler.js";
import {
  DASHBOARD_FILENAME,
  DASHBOARD_MAX_BYTES,
  dashboardRevision,
} from "../../../shared/dashboard-contract.js";

export function registerDashboardIpc(getCwd: () => string): void {
  // Idempotent for the same reason files-handler is: a macOS reopen-after-close
  // re-runs registration for the new window (#311).
  const ipc = createIdempotentIpc(ipcMain);

  ipc.handle("dashboard:load", async () => {
    try {
      const abs = resolveWithin(getCwd(), DASHBOARD_FILENAME);
      const stat = await fsp.lstat(abs);
      if (stat.isSymbolicLink()) {
        return {
          ok: false as const,
          error: `${DASHBOARD_FILENAME} is a symlink; refusing to read`,
        };
      }
      if (!stat.isFile()) {
        return { ok: false as const, error: `${DASHBOARD_FILENAME} is not a regular file` };
      }
      if (stat.size > DASHBOARD_MAX_BYTES) {
        return {
          ok: false as const,
          error: `dashboard layout is larger than ${DASHBOARD_MAX_BYTES} bytes`,
        };
      }
      const raw = await fsp.readFile(abs, "utf8");
      return { ok: true as const, raw, revision: dashboardRevision(raw) };
    } catch (err) {
      // No layout saved yet is the common case, not an error.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { ok: true as const, raw: null, revision: null };
      }
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle("dashboard:save", async (_e, raw: string, baseRevision?: string | null) => {
    if (typeof raw !== "string") {
      return { ok: false as const, error: "expected dashboard JSON text" };
    }
    if (Buffer.byteLength(raw, "utf8") > DASHBOARD_MAX_BYTES) {
      return {
        ok: false as const,
        error: `dashboard layout is larger than ${DASHBOARD_MAX_BYTES} bytes`,
      };
    }
    try {
      const abs = resolveWithin(getCwd(), DASHBOARD_FILENAME);

      let currentRaw: string | null = null;
      try {
        if ((await fsp.lstat(abs)).isSymbolicLink()) {
          return {
            ok: false as const,
            error: `${DASHBOARD_FILENAME} is a symlink; refusing to write through it`,
          };
        }
        currentRaw = await fsp.readFile(abs, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      }

      const currentRevision = dashboardRevision(currentRaw);
      if (baseRevision !== undefined && baseRevision !== currentRevision) {
        return {
          ok: false as const,
          conflict: true as const,
          error: "the dashboard changed on disk since it was loaded",
          raw: currentRaw,
          revision: currentRevision,
        };
      }

      // Temp file in the same directory, then rename: rename is atomic within a
      // filesystem, so a concurrent reader sees the old file or the new one and
      // never a truncated one.
      const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, raw, "utf8");
      try {
        await fsp.rename(tmp, abs);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      return { ok: true as const, revision: dashboardRevision(raw) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
