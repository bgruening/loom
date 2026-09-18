/**
 * Running jobs widget -- STUB.
 *
 * What Galaxy is running right now: each tracked invocation, its step and job counts, and what failed.
 *
 * Replacing this file is the whole job: keep the exported name
 * `jobsWidget` and the `type` string "jobs" and `widgets/index.ts`
 * needs no edit. The data you need is on `ctx.sources.invocations`; subscribe
 * through `ctx.subscribe` so the host unsubscribes for you and a throw in your
 * listener becomes this panel's error card instead of the dashboard's.
 */

import type { WidgetDefinition } from "../widget-api.js";

export const jobsWidget: WidgetDefinition = {
  type: "jobs",
  label: "Running jobs",
  description: "Galaxy invocations and their jobs, live.",
  defaultConfig: {},

  mount(el) {
    const card = document.createElement("div");
    card.className = "dash-card dash-card-stub";
    const title = document.createElement("p");
    title.className = "dash-card-title";
    title.textContent = "Running jobs -- not built yet";
    const detail = document.createElement("p");
    detail.className = "dash-card-detail";
    detail.textContent =
      "What Galaxy is running right now: each tracked invocation, its step and job counts, and what failed.";
    card.append(title, detail);
    el.append(card);
    return () => {
      el.textContent = "";
    };
  },
};
