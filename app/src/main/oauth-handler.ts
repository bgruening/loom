import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { shell } from "electron";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

/**
 * pi hides its OAuth flow modules from bundlers on purpose: `auth/oauth/load.ts`
 * imports them through a variable specifier so Rollup cannot follow the import
 * into Node-only flow code. Vite therefore leaves `./openai-codex.js` in the
 * main bundle verbatim, and at runtime that resolves against `.vite/build/`
 * rather than pi's dist -- sign-in dies with "Cannot find module".
 *
 * pi's escape hatch for bundled hosts is registerBundledOAuthFlowLoaders, which
 * ships prewired as registerBunOAuthFlows. The "Bun" in the name is about the
 * standalone binary it was written for, not a Bun runtime requirement: its
 * imports are static, so Vite bundles the flows and the variable-specifier path
 * is never taken. Register at module load, before any flow can be reached.
 */
registerBunOAuthFlows();

/**
 * OAuth provider integration for the brain's auth.json. The brain (pi-coding-agent)
 * reads `~/.pi/agent/auth.json` directly when spawned with `--provider <oauth-provider>`,
 * so all Orbit needs to do is run the OAuth flow and persist the resulting credentials
 * to that file. The brain handles refresh on its own via AuthStorage's locking.
 */

/**
 * Which providers authenticate by sign-in is pi's business, not ours: since pi
 * 0.81 each provider carries its own `auth.oauth`, so we read the list off the
 * registry instead of hardcoding it and going stale the next time pi adds one.
 *
 * That read is async and several callers are sync, so prime the cache once at
 * startup (primeOAuthProviders) and let the sync accessors serve from it. The
 * seed keeps pre-prime calls honest for the provider we know ships enabled --
 * without it a status check racing startup would report "not an OAuth provider"
 * and the UI would offer an API-key field for an account that has none.
 */
const SEED_OAUTH_PROVIDERS = ["openai-codex"];
let oauthProviders: Map<string, string> = new Map(SEED_OAUTH_PROVIDERS.map((id) => [id, ""]));

/** Read the OAuth-capable providers off pi's registry. Call once at startup. */
export async function primeOAuthProviders(): Promise<ReadonlyMap<string, string>> {
  try {
    const runtime = await ModelRuntime.create({ authPath: getAuthPath() });
    const found = new Map<string, string>();
    for (const provider of await runtime.getProviders()) {
      const oauth = provider.auth?.oauth;
      if (oauth?.login) found.set(provider.id, oauth.loginLabel || oauth.name || "");
    }
    // Never shrink below the seed -- an empty read means something is wrong with
    // the registry, not that sign-in stopped existing.
    if (found.size > 0) oauthProviders = found;
  } catch (err) {
    console.error("[oauth] could not read providers from the registry:", err);
  }
  return oauthProviders;
}

export function isOAuthProvider(provider: string | undefined): boolean {
  return Boolean(provider && oauthProviders.has(provider));
}

/** id -> button label, e.g. "openai-codex" -> "OpenAI (ChatGPT Plus/Pro)". */
export function listOAuthProviders(): Record<string, string> {
  return Object.fromEntries(oauthProviders);
}

function getAuthPath(): string {
  // Honor PI_CODING_AGENT_DIR so test/dev overrides land in the same place
  // the brain subprocess reads from. Mirrors bin/loom.js's agentDir resolution.
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = envDir
    ? envDir.replace(/^~(?=$|\/|\\)/, os.homedir())
    : path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "auth.json");
}

function readAuthFile(): Record<string, unknown> {
  const p = getAuthPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAuthFile(data: Record<string, unknown>): void {
  const p = getAuthPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best-effort */
  }
}

export interface OAuthStatus {
  signedIn: boolean;
  /** Seconds until the access token expires. Negative if already expired -- the brain auto-refreshes. */
  expiresInSeconds?: number;
  accountId?: string;
}

export function getOAuthStatus(provider: string): OAuthStatus {
  const data = readAuthFile();
  const cred = data[provider] as
    { type?: string; expires?: number; accountId?: string } | undefined;
  if (!cred || cred.type !== "oauth") return { signedIn: false };
  const expiresInSeconds =
    typeof cred.expires === "number" ? Math.floor((cred.expires - Date.now()) / 1000) : undefined;
  return { signedIn: true, expiresInSeconds, accountId: cred.accountId };
}

export function signOutOAuth(provider: string): void {
  const data = readAuthFile();
  if (!(provider in data)) return;
  delete data[provider];
  writeAuthFile(data);
}

/**
 * Drive a provider's OAuth flow and persist the result to auth.json. Opens the
 * auth URL in the user's default browser; the provider's flow runs a local
 * callback server (127.0.0.1:1455 for OpenAI Codex) and returns once the
 * browser hands the code back.
 *
 * pi 0.81 folded the per-service `loginOpenAICodex()` helper into the provider
 * itself: auth now hangs off `provider.auth.oauth` as a login/refresh/toAuth
 * triple, and driving login is the app's job. Asking the runtime for the
 * provider is what makes this work for any of them rather than one by name.
 *
 * Throws if the flow fails (port conflict, user cancellation, network error).
 */
export async function signInOAuth(provider: string): Promise<OAuthStatus> {
  const runtime = await ModelRuntime.create({ authPath: getAuthPath() });
  const oauth = runtime.getProvider(provider)?.auth?.oauth;
  if (!oauth?.login) {
    throw new Error(`${provider} does not offer OAuth sign-in in this build of pi.`);
  }

  // pi 0.84 makes `signal` required on the provider login interaction. Orbit
  // has no cancel affordance for sign-in yet, so hand it one that never fires
  // rather than imply the flow is abortable.
  const abort = new AbortController();

  const creds = await oauth.login({
    signal: abort.signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        void shell.openExternal(event.url);
        return;
      }
      if (event.type === "device_code") {
        // Device-code providers want the user to type a code on another page.
        // Orbit has no UI for that yet, so open the page and log the code
        // rather than silently appearing to hang.
        void shell.openExternal(event.verificationUri);
        console.log("[oauth] enter code:", event.userCode, "at", event.verificationUri);
        return;
      }
      if (event.type === "progress" || event.type === "info") {
        console.log("[oauth]", event.message);
      }
    },
    // pi 0.84 drives real decisions through `prompt`, not just the paste
    // fallback this used to assume, so rejecting outright fails every sign-in.
    prompt: async (request) => {
      // Codex now opens with a browser-vs-device-code chooser, so a blanket
      // reject dies before the browser ever opens. Orbit can open a URL but has
      // no chooser UI, so answer with the browser option -- the one flow it can
      // actually complete.
      if (request.type === "select") {
        const browser = request.options.find((o) => o.id === "browser") ?? request.options[0];
        if (!browser) throw new Error(`${provider} offered no login method to choose from.`);
        return browser.id;
      }

      // `manual_code` is raced against the local callback server, and the flow
      // treats a rejection here as fatal: its .catch sets manualError and calls
      // server.cancelWait(), and manualError is rethrown even when the callback
      // already won. Throwing would therefore cancel the very browser login we
      // want. Wait instead and let the redirect win; pi aborts this prompt's
      // signal once it does. A bind failure still surfaces as the real port
      // error rather than a paste message we can't act on.
      if (request.type === "manual_code") {
        return new Promise<string>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new Error("manual code entry cancelled")),
            { once: true },
          );
        });
      }

      // text/secret: a field Orbit genuinely cannot render yet.
      throw new Error(
        `${provider} needs input ("${request.message}") that Orbit cannot prompt ` +
          `for yet. Sign in with the pi CLI and Orbit will pick up the credentials.`,
      );
    },
  });

  const data = readAuthFile();
  data[provider] = {
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: creds.accountId,
  };
  writeAuthFile(data);

  return getOAuthStatus(provider);
}
