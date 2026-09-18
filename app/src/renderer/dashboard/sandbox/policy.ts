/**
 * Everything the sandbox is allowed to do, in one file.
 *
 * The widget, the document builder and the tests all read these constants
 * rather than spelling the policy out again, so a review only has to be
 * convinced of this file once and a loosening shows up as a diff here.
 *
 * The content in the frame is written by the agent. The agent can be
 * prompt-injected by anything it reads -- a Galaxy dataset, a tool's output, a
 * paper. So the content is treated as hostile, always, and nothing below is
 * relaxed because "our own agent wrote it".
 */

/**
 * The frame's own policy, injected as the first `<meta>` in the document.
 *
 * `default-src 'none'` covers connect (fetch/XHR/WebSocket/sendBeacon/
 * EventSource), fonts, media, objects, workers, manifests and nested frames.
 * The four overrides are the minimum the content needs to draw itself.
 *
 * `form-action` and `base-uri` are here because they are the two directives
 * that do **not** fall back to `default-src`: without them a form could POST
 * out and a `<base href>` could retarget relative URLs. They cost nothing.
 *
 * Not covered by any directive, and therefore not blocked here: a script
 * assigning `location` to navigate the frame itself. See `SANDBOX_TOKENS` and
 * the navigation watchdog in the widget.
 */
export const SANDBOX_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The iframe's `sandbox` attribute. One token.
 *
 * `allow-same-origin` is the one that must never appear: with it the frame
 * shares our origin, can reach `parent.document`, our `localStorage` and
 * `window.orbit`, and can rewrite its own sandbox attribute. Everything else
 * left out is left out on purpose -- no forms, popups, modals, downloads,
 * pointer lock, presentation, top-level navigation.
 */
export const SANDBOX_TOKENS = "allow-scripts";

/** Tokens that must never be granted, asserted by a test rather than by care. */
export const SANDBOX_FORBIDDEN_TOKENS = [
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-modals",
  "allow-downloads",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-popups-to-escape-sandbox",
  "allow-pointer-lock",
  "allow-presentation",
  "allow-orientation-lock",
  "allow-storage-access-by-user-activation",
];

/**
 * How much HTML a panel may carry. The whole layout document is capped at
 * 256 KB by `DASHBOARD_MAX_BYTES`, and a panel that ate most of that would
 * make the file unopenable for everything else in it.
 */
export const SANDBOX_MAX_HTML_BYTES = 64 * 1024;

/** Cap on one host -> frame data message, measured as serialized JSON. */
export const SANDBOX_MAX_DATA_BYTES = 64 * 1024;

/** Clamp on a height the frame asks for. Below the floor there is nothing to see. */
export const SANDBOX_MIN_HEIGHT = 32;
export const SANDBOX_MAX_HEIGHT = 4000;

/**
 * Frame -> host messages are content-controlled, so they are also a way to
 * burn the renderer's main thread. Anything past this in a one-second window
 * is dropped.
 */
export const SANDBOX_MAX_MESSAGES_PER_SECOND = 40;

/**
 * How long to wait for the frame's bridge to announce itself before deciding
 * scripts are not running. Generous: a cold frame on a busy machine is slow,
 * and the only cost of waiting is a later notice.
 */
export const SANDBOX_READY_TIMEOUT_MS = 2000;

/** Marker on every message in both directions, so unrelated traffic is ignored. */
export const SANDBOX_MESSAGE_TAG = "loom.sandbox";
