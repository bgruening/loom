/**
 * Layout editing UX. Stub.
 *
 * The host imports `dashboardEditor` and, when it is not null, calls `attach`
 * once with a toolbar it owns outright and `decoratePanel` for each panel with
 * that panel's header slot. Everything the editing UX needs -- read the
 * document, write a new one, list the available widgets, switch dashboards --
 * is on `ctx.host`, so this can be built out without `host.ts` changing.
 *
 * Replace the `null` below with an implementation; keep the export name.
 */

import type { DashboardEditor } from "./widget-api.js";

export const dashboardEditor: DashboardEditor | null = null;
