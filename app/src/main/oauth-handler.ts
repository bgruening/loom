import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { shell } from "electron";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * OAuth provider integration for the brain's auth.json. The brain (pi-coding-agent)
 * reads `~/.pi/agent/auth.json` directly when spawned with `--provider <oauth-provider>`,
 * so all Orbit needs to do is run the OAuth flow and persist the resulting credentials
 * to that file. The brain handles refresh on its own via AuthStorage's locking.
 */

const OAUTH_PROVIDERS = new Set<string>(["openai-codex"]);

export function isOAuthProvider(provider: string | undefined): boolean {
  return Boolean(provider && OAUTH_PROVIDERS.has(provider));
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
 * Drive the OpenAI Codex OAuth flow. Opens the auth URL in the user's default
 * browser; the flow spins up a local callback server on 127.0.0.1:1455 and
 * returns once the browser hands back the code.
 *
 * pi 0.81 folded the per-service `loginOpenAICodex()` helper into the provider
 * itself: auth now hangs off `provider.auth.oauth` as a login/refresh/toAuth
 * triple, and driving login is the app's job. So we ask a ModelRuntime for the
 * provider rather than importing a service-specific function.
 *
 * Throws if the flow fails (port conflict, user cancellation, network error).
 */
export async function signInOpenAICodex(): Promise<OAuthStatus> {
  const runtime = await ModelRuntime.create({ authPath: getAuthPath() });
  const oauth = runtime.getProvider("openai-codex")?.auth?.oauth;
  if (!oauth) {
    throw new Error("This build of pi does not expose an OpenAI Codex OAuth provider.");
  }

  const creds = await oauth.login({
    notify: (event) => {
      if (event.type === "auth_url") {
        void shell.openExternal(event.url);
        return;
      }
      if (event.type === "progress" || event.type === "info") {
        console.log("[oauth]", event.message);
      }
    },
    // Fallback paste path -- only triggered if the local callback server fails
    // to start (port already in use). Orbit doesn't surface a paste UI today,
    // so we reject with a guidance message instead of hanging.
    prompt: async () => {
      throw new Error(
        "OAuth callback server could not bind to 127.0.0.1:1455. " +
          "Free the port (e.g. quit Codex CLI) and try again.",
      );
    },
  });

  const data = readAuthFile();
  data["openai-codex"] = {
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: creds.accountId,
  };
  writeAuthFile(data);

  return getOAuthStatus("openai-codex");
}
