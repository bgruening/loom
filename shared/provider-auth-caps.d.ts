export interface ProviderAuthCaps {
  /** Sign-in button label, e.g. "OpenAI (ChatGPT Plus/Pro)". "" when pi gives none. */
  signInLabel: string;
  /** pi defines an API-key auth path for this provider (dual-auth when it also signs in). */
  acceptsApiKey: boolean;
}

/** Shape of the bits of a pi registry provider entry this module reads. */
export interface PiProviderAuthEntry {
  id?: string;
  auth?: {
    apiKey?: unknown;
    oauth?: { login?: unknown; name?: string; loginLabel?: string };
  };
}

export function classifyProviderAuth(provider: PiProviderAuthEntry): ProviderAuthCaps | null;
export function isOAuthOnly(caps: ProviderAuthCaps | undefined): boolean;
export const SEED_PROVIDER_AUTH_CAPS: Record<string, ProviderAuthCaps>;
export const SEED_OAUTH_ONLY_PROVIDERS: string[];
