/**
 * The script that runs inside the frame, as source text.
 *
 * It is **not** a security boundary. It shares a realm with the agent-authored
 * content, which can overwrite `window.loom`, post its own messages, or lie
 * about its height. Everything it sends is re-validated on the host side. Its
 * only job is to be a convenient API for content that is behaving.
 *
 * Written as a string rather than a module because it has to be inlined into
 * the frame's document -- there is no origin it could be fetched from, and
 * fetching anything is exactly what the frame is not allowed to do.
 */

import { SANDBOX_MESSAGE_TAG, SANDBOX_MIN_HEIGHT, SANDBOX_MAX_HEIGHT } from "./policy.js";

/**
 * Kept deliberately small and dependency-free. `window.loom` gives content
 * three things: the data snapshot, a subscription that replays the last value
 * so registration order does not matter, and a way to ask for a height.
 */
export const SANDBOX_BRIDGE_SOURCE = `
(function () {
  "use strict";
  var TAG = ${JSON.stringify(SANDBOX_MESSAGE_TAG)};
  var MIN = ${SANDBOX_MIN_HEIGHT};
  var MAX = ${SANDBOX_MAX_HEIGHT};
  var listeners = [];
  var state = { data: null, dropped: [], updatedAt: 0 };

  function post(message) {
    try {
      // The frame has an opaque origin, so there is no origin string the
      // parent would match; "*" is the only workable target here and the
      // parent identifies us by window identity instead.
      parent.postMessage(message, "*");
    } catch (err) {
      /* the parent may already be gone */
    }
  }

  function measure() {
    var doc = document.documentElement;
    var body = document.body;
    var h = Math.max(
      doc ? doc.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    if (!isFinite(h)) return MIN;
    return Math.min(MAX, Math.max(MIN, Math.ceil(h)));
  }

  var lastSent = -1;
  var pending = false;
  function reportHeight() {
    if (pending) return;
    pending = true;
    var run = function () {
      pending = false;
      var h = measure();
      if (h === lastSent) return;
      lastSent = h;
      post({ tag: TAG, type: "height", height: h });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function deliver() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](state.data, state);
      } catch (err) {
        /* one bad handler must not stop the others */
      }
    }
    reportHeight();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.tag !== TAG) return;
    if (msg.type !== "data") return;
    state = {
      data: msg.sources || {},
      dropped: msg.dropped || [],
      updatedAt: msg.updatedAt || Date.now(),
    };
    deliver();
    try {
      window.dispatchEvent(new CustomEvent("loom:data", { detail: state }));
    } catch (err) {
      /* CustomEvent is present everywhere we run, but never take the frame down for it */
    }
  });

  window.loom = {
    get data() {
      return state.data;
    },
    get dropped() {
      return state.dropped;
    },
    onData: function (fn) {
      if (typeof fn !== "function") return;
      listeners.push(fn);
      // Replay, so content does not have to care whether it registered before
      // or after the first snapshot arrived.
      if (state.data) {
        try {
          fn(state.data, state);
        } catch (err) {
          /* as above */
        }
      }
    },
    resize: reportHeight,
  };

  if (typeof ResizeObserver === "function") {
    try {
      new ResizeObserver(reportHeight).observe(document.documentElement);
    } catch (err) {
      /* fall back to the explicit calls below */
    }
  }
  window.addEventListener("load", reportHeight);
  document.addEventListener("DOMContentLoaded", reportHeight);

  post({ tag: TAG, type: "ready" });
})();
`;
