/**
 * Results widget -- STUB.
 *
 * A gallery of what the analysis produced: images, tables and the files worth opening.
 *
 * Replacing this file is the whole job: keep the exported name
 * `resultsWidget` and the `type` string "results" and `widgets/index.ts`
 * needs no edit. The data you need is on `ctx.sources.files`; subscribe
 * through `ctx.subscribe` so the host unsubscribes for you and a throw in your
 * listener becomes this panel's error card instead of the dashboard's.
 */

import type { WidgetDefinition } from "../widget-api.js";

export const resultsWidget: WidgetDefinition = {
  type: "results",
  label: "Results",
  description: "Images, tables and files the analysis produced.",
  defaultConfig: {},

  mount(el) {
    const card = document.createElement("div");
    card.className = "dash-card dash-card-stub";
    const title = document.createElement("p");
    title.className = "dash-card-title";
    title.textContent = "Results -- not built yet";
    const detail = document.createElement("p");
    detail.className = "dash-card-detail";
    detail.textContent =
      "A gallery of what the analysis produced: images, tables and the files worth opening.";
    card.append(title, detail);
    el.append(card);
    return () => {
      el.textContent = "";
    };
  },
};
