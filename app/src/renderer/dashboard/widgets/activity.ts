/**
 * Analysis log widget -- STUB.
 *
 * A filterable tail of the analysis log, so the last thing that happened is visible without reading a terminal.
 *
 * Replacing this file is the whole job: keep the exported name
 * `activityWidget` and the `type` string "activity" and `widgets/index.ts`
 * needs no edit. The data you need is on `ctx.sources.activity`; subscribe
 * through `ctx.subscribe` so the host unsubscribes for you and a throw in your
 * listener becomes this panel's error card instead of the dashboard's.
 */

import type { WidgetDefinition } from "../widget-api.js";

export const activityWidget: WidgetDefinition = {
  type: "activity",
  label: "Analysis log",
  description: "A filterable tail of the analysis log.",
  defaultConfig: {},

  mount(el) {
    const card = document.createElement("div");
    card.className = "dash-card dash-card-stub";
    const title = document.createElement("p");
    title.className = "dash-card-title";
    title.textContent = "Analysis log -- not built yet";
    const detail = document.createElement("p");
    detail.className = "dash-card-detail";
    detail.textContent =
      "A filterable tail of the analysis log, so the last thing that happened is visible without reading a terminal.";
    card.append(title, detail);
    el.append(card);
    return () => {
      el.textContent = "";
    };
  },
};
