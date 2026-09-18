/**
 * Custom view -- an agent-authored HTML view in a locked-down iframe.
 *
 * This is the one widget with a real security surface, and it is off by
 * default. The content is written by the agent, the agent can be
 * prompt-injected by anything it reads, and the content is persisted in
 * `.loom-dashboard.json` so it runs again every time the analysis is opened.
 * It is therefore treated as hostile, permanently.
 *
 * What holds it:
 *  - `sandbox="allow-scripts"` and nothing else. No `allow-same-origin`, so
 *    the frame has an opaque origin and cannot reach our DOM, our
 *    `localStorage` or `window.orbit`, and cannot rewrite its own sandbox.
 *  - a `default-src 'none'` CSP as the first element of the document, so no
 *    network of any kind: no fetch, no XHR, no WebSocket, no image beacon.
 *  - data in only by `postMessage`, and only the sources the panel's `data`
 *    config named. A source that was not named is never even subscribed to.
 *  - data out only as a height request, which is validated, clamped and rate
 *    limited.
 *
 * What does not hold it, and is written down rather than hidden: the content
 * can draw anything it likes inside its own box, including something that
 * looks like Orbit asking for a password. The badge and the inset edge are
 * what a user has to tell the difference with. See the threat-model note.
 */

import type { WidgetDefinition, WidgetDispose } from "../widget-api.js";
import {
  SANDBOX_MAX_HTML_BYTES,
  SANDBOX_READY_TIMEOUT_MS,
  SANDBOX_TOKENS,
} from "../sandbox/policy.js";
import { buildSandboxDocument } from "../sandbox/srcdoc.js";
import { buildDataMessage, MessageBudget, readFrameMessage } from "../sandbox/protocol.js";
import {
  allowedDataSources,
  collectSandboxData,
  resolveAllowedSources,
} from "../sandbox/data-snapshot.js";
import { isHtmlSandboxEnabled, HTML_SANDBOX_FLAG_KEY } from "../sandbox/flag.js";
import { ensureSandboxStyles } from "../sandbox/styles.js";

type HtmlSandboxConfig = {
  /** The markup to render. Treated as hostile. */
  html: string;
  /** The frame's document title. The panel's own title still comes from the layout. */
  title?: string;
  /** Which data sources the content may receive. Empty means none. */
  data?: string[];
};

/** Coalesce a burst of source updates into one message. */
const DATA_DEBOUNCE_MS = 150;

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function currentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function card(title: string, detail: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "dash-card";
  const heading = document.createElement("p");
  heading.className = "dash-card-title";
  heading.textContent = title;
  const body = document.createElement("p");
  body.className = "dash-card-detail";
  body.textContent = detail;
  box.append(heading, body);
  return box;
}

export const htmlSandboxWidget: WidgetDefinition<HtmlSandboxConfig> = {
  type: "html-sandbox",
  label: "Custom view",
  description: "An agent-authored view in a locked-down iframe. Behind a flag.",
  defaultConfig: { html: "", data: [] },

  mount(el, ctx): WidgetDispose {
    ensureSandboxStyles();

    // The badge goes up whatever happens next, including the disabled and
    // refused paths: "this panel's content did not come from us" is true in
    // all of them.
    const badge = document.createElement("span");
    badge.className = "dash-sandbox-badge";
    badge.textContent = "custom content";
    badge.title =
      "This view was written by the agent and runs in a locked-down frame with no network access.";
    ctx.header.append(badge);

    const wrap = document.createElement("div");
    wrap.className = "dash-sandbox";
    el.append(wrap);

    const note = (text: string, alarm = false): void => {
      let line = wrap.querySelector<HTMLElement>(".dash-sandbox-note");
      if (!line) {
        line = document.createElement("p");
        line.className = "dash-sandbox-note";
        wrap.prepend(line);
      }
      line.classList.toggle("dash-sandbox-alarm", alarm);
      line.textContent = text;
    };

    if (!isHtmlSandboxEnabled()) {
      wrap.append(
        card(
          "Custom views are switched off",
          "The agent can write a small HTML view for this panel, and it runs with no network access " +
            "and no way to reach the rest of Orbit. It is switched off until that has been reviewed. " +
            `To turn it on for this browser, set ${HTML_SANDBOX_FLAG_KEY} to "1" in local storage.`,
        ),
      );
      return () => {
        el.textContent = "";
      };
    }

    const html = typeof ctx.config.html === "string" ? ctx.config.html : "";
    if (!html.trim()) {
      wrap.append(
        card(
          "Nothing to show yet",
          "This panel is waiting for a view. Ask the agent for the picture you want -- a plot of a " +
            "result, a summary of where the run is -- and it will write one here.",
        ),
      );
      return () => {
        el.textContent = "";
      };
    }

    const size = byteLength(html);
    if (size > SANDBOX_MAX_HTML_BYTES) {
      wrap.append(
        card(
          "This view is too large to open",
          `It is ${Math.round(size / 1024)} KB and the limit is ${Math.round(
            SANDBOX_MAX_HTML_BYTES / 1024,
          )} KB. Nothing was run. Ask the agent for a smaller view.`,
        ),
      );
      return () => {
        el.textContent = "";
      };
    }

    const allowed = resolveAllowedSources(ctx.config.data);

    const stage = document.createElement("div");
    stage.className = "dash-sandbox-stage";
    wrap.append(stage);

    const frame = document.createElement("iframe");
    frame.className = "dash-sandbox-frame";
    frame.setAttribute("sandbox", SANDBOX_TOKENS);
    // Deny every permissions-policy feature outright. An opaque-origin frame
    // is not delegated any of them by default; saying so costs nothing and
    // survives a future default changing.
    frame.setAttribute("allow", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "Agent-authored custom view");
    frame.style.height = "100%";

    let disposed = false;
    let ready = false;
    let loads = 0;
    let navigated = false;
    let floodNoted = false;
    const budget = new MessageBudget();

    const send = (): void => {
      if (disposed || !ready || navigated) return;
      const win = frame.contentWindow;
      if (!win) return;
      const payload = collectSandboxData(ctx.sources, allowed);
      // The frame's origin is opaque, so there is no origin string to target
      // and "*" is the only value that delivers. What makes that safe is that
      // `win` is a handle on our own frame -- and the watchdog below tears the
      // frame down the moment it stops being the document we put there.
      win.postMessage(buildDataMessage(payload), "*");
      if (payload.dropped.length > 0) {
        note(
          `Some data was too large to hand to this view, so it was left out: ${payload.dropped.join(", ")}.`,
        );
      }
    };

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const sendSoon = (): void => {
      if (debounce !== null) return;
      debounce = setTimeout(() => {
        debounce = null;
        send();
      }, DATA_DEBOUNCE_MS);
    };
    ctx.onDispose(() => {
      if (debounce !== null) clearTimeout(debounce);
    });

    /**
     * The frame is allowed to navigate itself -- no CSP directive covers a
     * script assigning `location`, and a plain link inside it is a navigation
     * too. Whether the app's own `frame-src` stops that is the app's business
     * and can change; this notices either way, stops talking to whatever is
     * there now, and tells the user.
     */
    const onLoad = (): void => {
      loads += 1;
      if (loads <= 1 || disposed) return;
      navigated = true;
      frame.remove();
      note(
        "This view tried to open a web page and was stopped. Nothing was sent. " +
          "That is not something a normal view does -- it is worth telling whoever set this up.",
        true,
      );
    };
    frame.addEventListener("load", onLoad);
    ctx.onDispose(() => frame.removeEventListener("load", onLoad));

    const onMessage = (event: MessageEvent): void => {
      if (disposed || navigated) return;
      // Identity, not origin: an opaque-origin frame posts with origin "null",
      // which every other opaque frame on the page would also match.
      if (!frame.contentWindow || event.source !== frame.contentWindow) return;
      if (!budget.allow()) {
        if (!floodNoted) {
          floodNoted = true;
          note(
            "This view is asking for more than its share of attention, so some of what it " +
              "sends is being ignored. What you can see is still correct.",
          );
        }
        return;
      }
      const msg = readFrameMessage(event.data);
      if (!msg) return;
      if (msg.type === "ready") {
        ready = true;
        send();
        return;
      }
      frame.style.height = `${msg.height}px`;
    };
    window.addEventListener("message", onMessage);
    ctx.onDispose(() => window.removeEventListener("message", onMessage));

    // Only subscribe to what the panel asked for: a source that is not in
    // `data` is never read, so it cannot reach the frame by any path.
    for (const source of allowedDataSources(ctx.sources, allowed)) {
      ctx.subscribe(source, () => sendSoon(), { immediate: false });
    }

    // srcdoc before append, so the frame loads our document once rather than
    // loading about:blank first and tripping the watchdog.
    frame.srcdoc = buildSandboxDocument({
      html,
      title: ctx.config.title,
      theme: currentTheme(),
    });
    stage.append(frame);

    /**
     * Orbit's CSP is inherited by a `srcdoc` frame, and `script-src 'self'`
     * blocks every inline script in it. When that is what happened the content
     * still renders, just inert, and saying so beats leaving someone to work
     * out why their chart is not moving. Only worth saying if the view
     * actually has a script in it.
     */
    const readyTimer = setTimeout(() => {
      if (disposed || ready || navigated) return;
      if (!/<script[\s>]/i.test(html)) return;
      note(
        "The moving parts of this view are switched off by Orbit's content policy, so it is " +
          "showing as a still picture. Everything it can draw is drawn.",
      );
    }, SANDBOX_READY_TIMEOUT_MS);
    ctx.onDispose(() => clearTimeout(readyTimer));

    // A theme flip has to reach the frame, and the frame cannot see our CSS
    // variables. Rebuilding is the one path that works whether or not its
    // scripts are running.
    let theme = currentTheme();
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(() => {
        const next = currentTheme();
        if (next === theme || disposed || navigated) return;
        theme = next;
        loads = 0;
        ready = false;
        frame.srcdoc = buildSandboxDocument({ html, title: ctx.config.title, theme });
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      ctx.onDispose(() => observer.disconnect());
    }

    return () => {
      disposed = true;
      frame.remove();
      el.textContent = "";
    };
  },
};
