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
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { createIdempotentIpc } from "./ipc-registry.js";
import { resolveWithin } from "./files-handler.js";
import { DASHBOARD_FILENAME, DASHBOARD_MAX_BYTES } from "../../../shared/dashboard-contract.js";

export function registerDashboardIpc(getCwd: () => string): void {
  // Idempotent for the same reason files-handler is: a macOS reopen-after-close
  // re-runs registration for the new window (#311).
  const ipc = createIdempotentIpc(ipcMain);

  ipc.handle("dashboard:load", async () => {
    try {
      const abs = resolveWithin(getCwd(), DASHBOARD_FILENAME);
      const raw = await fsp.readFile(abs, "utf8");
      return { ok: true as const, raw };
    } catch (err) {
      // No layout saved yet is the common case, not an error.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { ok: true as const, raw: null };
      }
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle("dashboard:save", async (_e, raw: string) => {
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
      await fsp.writeFile(abs, raw, "utf8");
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
