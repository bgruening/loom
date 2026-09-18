/**
 * Whether the agent-authored HTML widget is switched on.
 *
 * Off by default, everywhere, and it stays off until someone decides to ship
 * it. Nothing in the dashboard document can turn it on: the flag deliberately
 * lives outside the one file the agent can write.
 *
 * The repo's existing experiment flags (`isTeamDispatchEnabled`,
 * `isSessionIndexEnabled`) read an env var first and `~/.loom/config.json`'s
 * `experiments.*` second. The renderer can read neither -- it has no `process`
 * and its config IPC is masked -- so the same two-step shape is kept with the
 * nearest renderer-side equivalents:
 *
 *   1. `window.__ORBIT_EXPERIMENTS__.htmlSandbox` -- a boolean the shell sets.
 *      Nothing sets it today; wiring it from `LOOM_HTML_SANDBOX` /
 *      `config.experiments.htmlSandbox` through the preload is a main-process
 *      change, which is written up rather than made.
 *   2. `localStorage["orbit.experiments.htmlSandbox"]` -- "1" on, "0" off.
 *      Key shape matches `orbit.artifactCollapsed` and friends in `app.ts`.
 *   3. Default: off.
 *
 * An explicit `false` or `"0"` at either level wins, so a shell that turns it
 * off cannot be overridden from the page.
 */

export const HTML_SANDBOX_FLAG_KEY = "orbit.experiments.htmlSandbox";
export const HTML_SANDBOX_GLOBAL = "__ORBIT_EXPERIMENTS__";
/** The env var / config key a shell should map onto the global. */
export const HTML_SANDBOX_ENV = "LOOM_HTML_SANDBOX";

interface OrbitExperiments {
  htmlSandbox?: boolean;
}

export function isHtmlSandboxEnabled(): boolean {
  const injected = (globalThis as Record<string, unknown>)[HTML_SANDBOX_GLOBAL] as
    OrbitExperiments | undefined;
  if (injected && typeof injected.htmlSandbox === "boolean") return injected.htmlSandbox;

  try {
    const saved = globalThis.localStorage?.getItem(HTML_SANDBOX_FLAG_KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    // Storage can throw outright in a partitioned or restricted context, and
    // a flag that cannot be read is a flag that is off.
  }

  return false;
}
