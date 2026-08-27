/**
 * Per-provider field state for the Preferences LLM pane.
 *
 * Preferences shows one set of inputs for whichever provider the dropdown has
 * selected, so switching providers has to stash the outgoing provider's fields
 * and restore the incoming one's. Most of that state is just what is in the
 * form, but two pieces are not, and that distinction is the whole reason this
 * lives in its own DOM-free module: see `snapshotProviderState`.
 */

/** The visible inputs, read off the form at snapshot time. */
export interface ProviderFieldValues {
  typedKey: string;
  model: string;
  baseUrl: string;
}

/** A provider's in-memory state while Preferences is open. */
export interface ProviderState {
  /** Config has a key for this provider (masked -- the key never reaches us). */
  hadKey: boolean;
  /** What the user typed into the API key input, verbatim. */
  typedKey: string;
  model: string;
  /** Base URL as it sits in the editable field. */
  baseUrl: string;
  /**
   * Base URL as it sits in config -- what main would actually contact for a
   * discovery probe. Not editable, so a form snapshot must not overwrite it.
   */
  savedBaseUrl: string;
  /** Ids last reported by a custom endpoint's /models, if it was asked. */
  discoveredModels?: string[];
}

export function emptyProviderState(): ProviderState {
  return { hadKey: false, typedKey: "", model: "", baseUrl: "", savedBaseUrl: "" };
}

/**
 * Stash the visible fields into `provider`'s slot when switching away.
 *
 * `hadKey`, `savedBaseUrl` and `discoveredModels` describe config and the
 * endpoint's answer, not the form, so they are carried forward from `prev`
 * rather than read off the inputs. Rebuilding this object from the form fields
 * alone silently reintroduces #432: `planModelDiscovery` reads a blank
 * `savedBaseUrl`, skips every probe, and the model picker stays empty with all
 * tests still green. `tests/provider-state.test.ts` pins that.
 */
export function snapshotProviderState(
  prev: ProviderState | undefined,
  fields: ProviderFieldValues,
): ProviderState {
  return {
    hadKey: prev?.hadKey ?? false,
    typedKey: fields.typedKey,
    model: fields.model,
    baseUrl: fields.baseUrl.trim(),
    savedBaseUrl: prev?.savedBaseUrl ?? "",
    discoveredModels: prev?.discoveredModels,
  };
}
