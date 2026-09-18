/**
 * Notebook widget -- the running log of the analysis, rendered as markdown.
 *
 * The one real widget in the foundation: it proves the path from the brain's
 * `setWidget` push, through the notebook data source, to a panel that updates
 * itself. Figures go through the same `orbit-artifact://` rewrite the Notebook
 * tab uses, so relative image paths resolve.
 */

import { renderMarkdown } from "../../chat/markdown.js";
import { notebookMarked } from "../../artifacts/artifact-panel.js";
import type { WidgetDefinition, WidgetDispose } from "../widget-api.js";

type NotebookConfig = {
  /** Stick to the bottom as the notebook grows. */
  follow: boolean;
};

const EMPTY =
  "The notebook will appear here once the agent writes to notebook.md, or you can ask it to summarize the analysis so far.";

export const notebookWidget: WidgetDefinition<NotebookConfig> = {
  type: "notebook",
  label: "Notebook",
  description: "The running log of the analysis, as markdown.",
  defaultConfig: { follow: true },

  mount(el, ctx): WidgetDispose {
    el.classList.add("dash-notebook");
    const scroller = document.createElement("div");
    scroller.className = "dash-notebook-scroll";
    const content = document.createElement("div");
    content.className = "result-markdown";
    scroller.append(content);
    el.append(scroller);

    const followBtn = document.createElement("button");
    followBtn.className = "dash-panel-btn";
    followBtn.type = "button";
    const paintFollow = (): void => {
      followBtn.textContent = ctx.config.follow ? "following" : "follow";
      followBtn.title = ctx.config.follow
        ? "Scrolling to the newest entry on every update"
        : "Scroll to the newest entry on every update";
      followBtn.classList.toggle("active", ctx.config.follow);
    };
    paintFollow();
    followBtn.addEventListener("click", () => ctx.setConfig({ follow: !ctx.config.follow }));
    ctx.header.append(followBtn);

    const scrollToNewest = (): void => {
      if (ctx.config.follow) scroller.scrollTop = scroller.scrollHeight;
    };

    ctx.subscribe(ctx.sources.notebook, (snapshot) => {
      const markdown = snapshot.markdown.trim();
      if (!markdown) {
        content.innerHTML = "";
        const empty = document.createElement("p");
        empty.textContent = EMPTY;
        content.append(empty);
        return;
      }
      content.innerHTML = renderMarkdown(snapshot.markdown, notebookMarked);
      scrollToNewest();
    });

    // A panel in a hidden tab has no height, so the scroll above lands on a
    // scrollHeight of 0 and the newest entry is not what the user sees when
    // they switch to the Dashboard tab. Catch the moment the panel gains size.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      let lastHeight = 0;
      observer = new ResizeObserver(() => {
        const height = scroller.clientHeight;
        if (height > 0 && lastHeight === 0) scrollToNewest();
        lastHeight = height;
      });
      observer.observe(scroller);
    }

    return () => {
      observer?.disconnect();
      el.classList.remove("dash-notebook");
      el.textContent = "";
    };
  },
};
