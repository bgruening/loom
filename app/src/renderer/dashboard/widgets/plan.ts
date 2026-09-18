/**
 * Plan widget -- STUB.
 *
 * Where the plan stands: each step, whether it is pending, done or failed, and how it is routed.
 *
 * Replacing this file is the whole job: keep the exported name
 * `planWidget` and the `type` string "plan" and `widgets/index.ts`
 * needs no edit. The data you need is on `ctx.sources.plan`; subscribe
 * through `ctx.subscribe` so the host unsubscribes for you and a throw in your
 * listener becomes this panel's error card instead of the dashboard's.
 */

import type { WidgetDefinition } from "../widget-api.js";

export const planWidget: WidgetDefinition = {
  type: "plan",
  label: "Plan",
  description: "Where the analysis plan stands.",
  defaultConfig: {},

  mount(el) {
    const card = document.createElement("div");
    card.className = "dash-card dash-card-stub";
    const title = document.createElement("p");
    title.className = "dash-card-title";
    title.textContent = "Plan -- not built yet";
    const detail = document.createElement("p");
    detail.className = "dash-card-detail";
    detail.textContent =
      "Where the plan stands: each step, whether it is pending, done or failed, and how it is routed.";
    card.append(title, detail);
    el.append(card);
    return () => {
      el.textContent = "";
    };
  },
};
