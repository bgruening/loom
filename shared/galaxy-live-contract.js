// Shell-neutral wire shape for the live Galaxy history panel.
//
// The brain is the only process that holds GALAXY_URL/GALAXY_API_KEY in every
// shell -- Orbit injects them after decrypting safeStorage, the CLI resolves
// them from a profile, the web server forwards them from its env -- so it is
// the only place a Galaxy read can happen once and reach both renderers. What
// crosses to a renderer is this projection and nothing else: no key, no full
// server URL, no dataset bytes, and no Galaxy-authored HTML (notably `peek`,
// which is HTML, is deliberately absent).

export const GALAXY_LIVE_SCHEMA_VERSION = 1;

/** Cap on rows crossing the channel. A 5k-dataset history must not become a
 *  5k-element setWidget push on a 15s timer. */
export const GALAXY_LIVE_MAX_ITEMS = 200;

/** Cap on a single dataset name. Galaxy names are user-supplied and unbounded. */
export const GALAXY_LIVE_MAX_NAME = 200;

/**
 * Galaxy dataset states we model. Anything else collapses to "other" so a new
 * server-side state never crashes a widget written against an older build.
 * Source: galaxy.model.Dataset.states.
 * @typedef {"new"|"upload"|"queued"|"running"|"ok"|"empty"|"error"|"paused"|"setting_metadata"|"failed_metadata"|"deferred"|"discarded"|"other"} GalaxyLiveState
 */

export const GALAXY_LIVE_STATES = /** @type {const} */ ([
  "new",
  "upload",
  "queued",
  "running",
  "ok",
  "empty",
  "error",
  "paused",
  "setting_metadata",
  "failed_metadata",
  "deferred",
  "discarded",
  "other",
]);

/** States that mean Galaxy is still working. Drives the "is anything running"
 *  headline and the poll cadence. */
export const GALAXY_LIVE_ACTIVE_STATES = /** @type {const} */ ([
  "new",
  "upload",
  "queued",
  "running",
  "setting_metadata",
]);

/** Why there is nothing to show. The renderer maps these to a sentence; the
 *  brain never sends prose, so the two shells cannot drift. */
export const GALAXY_LIVE_UNAVAILABLE = /** @type {const} */ ([
  "not-configured",
  "no-history",
  "unreachable",
  // 401: the key itself is rejected. 403: the key is fine, this history is not
  // yours. Telling someone to re-enter a working key is its own kind of wrong.
  "unauthorized",
  "forbidden",
]);

/** @param {unknown} s @returns {GalaxyLiveState} */
export function normalizeState(s) {
  return typeof s === "string" && /** @type {readonly string[]} */ (GALAXY_LIVE_STATES).includes(s)
    ? /** @type {GalaxyLiveState} */ (s)
    : "other";
}

/** @param {GalaxyLiveState} s */
export function isActiveState(s) {
  return /** @type {readonly string[]} */ (GALAXY_LIVE_ACTIVE_STATES).includes(s);
}

/**
 * Clamp a Galaxy-authored string to a fixed length. Not a security control --
 * the renderer must still use textContent -- but it keeps one pathological
 * name from dominating the payload.
 * @param {unknown} v @param {number} max @returns {string}
 */
export function clampText(v, max = GALAXY_LIVE_MAX_NAME) {
  if (typeof v !== "string") return "";
  return v.length <= max ? v : v.slice(0, max - 1) + "…";
}
