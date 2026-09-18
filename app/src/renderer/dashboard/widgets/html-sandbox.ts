/**
 * Custom view widget -- STUB.
 *
 * An agent-authored HTML view in a locked-down iframe -- no network, no parent access, data in by postMessage. Behind a flag until it is reviewed.
 *
 * Replacing this file is the whole job: keep the exported name
 * `htmlSandboxWidget` and the `type` string "html-sandbox" and `widgets/index.ts`
 * needs no edit. The data you need is on `ctx.sources.notebook`; subscribe
 * through `ctx.subscribe` so the host unsubscribes for you and a throw in your
 * listener becomes this panel's error card instead of the dashboard's.
 */

import type { WidgetDefinition } from "../widget-api.js";

export const htmlSandboxWidget: WidgetDefinition = {
  type: "html-sandbox",
  label: "Custom view",
  description: "An agent-authored view in a locked-down iframe. Behind a flag.",
  defaultConfig: {},

  mount(el) {
    const card = document.createElement("div");
    card.className = "dash-card dash-card-stub";
    const title = document.createElement("p");
    title.className = "dash-card-title";
    title.textContent = "Custom view -- not built yet";
    const detail = document.createElement("p");
    detail.className = "dash-card-detail";
    detail.textContent =
      "An agent-authored HTML view in a locked-down iframe -- no network, no parent access, data in by postMessage. Behind a flag until it is reviewed.";
    card.append(title, detail);
    el.append(card);
    return () => {
      el.textContent = "";
    };
  },
};
