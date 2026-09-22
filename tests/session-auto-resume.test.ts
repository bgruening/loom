import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("../extensions/loom/state.js", () => ({
  resetState: vi.fn(),
  initSessionArtifacts: vi.fn(),
  getNotebookPath: vi.fn(() => null),
  stopWatchingNotebook: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-poller.js", () => ({
  startGalaxyPoller: vi.fn(),
  stopGalaxyPoller: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-page-sync.js", () => ({
  initGalaxyPageSync: vi.fn(),
  flushNotebookToGalaxy: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-cred-drift.js", () => ({ maybeNudgeGalaxyReconnect: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: vi.fn(() => ({})) }));

import { startGalaxyPoller } from "../extensions/loom/galaxy-poller.js";
import { registerSessionLifecycle } from "../extensions/loom/session-lifecycle";

type SessionHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

async function start(hasUI = true) {
  const handlers = new Map<string, SessionHandler>();
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const pi = {
    on: (name: string, handler: SessionHandler) => handlers.set(name, handler),
    sendUserMessage,
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI,
    ui: { setToolsExpanded: vi.fn(), notify },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "test-session" },
  } as unknown as ExtensionContext;
  registerSessionLifecycle(pi);
  await handlers.get("session_start")!({}, ctx);
  return { sendUserMessage, notify };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LOOM_AUTO_RESUME", undefined);
  vi.stubEnv("LOOM_FRESH_SESSION", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("session Galaxy follow-up wiring", () => {
  it.each([true, false])(
    "queues a turn by default, including headless sessions (hasUI=%s)",
    async (hasUI) => {
      const { sendUserMessage, notify } = await start(hasUI);
      const [toast, resume] = vi.mocked(startGalaxyPoller).mock.calls[0];
      expect(resume).toBeTypeOf("function");
      resume!("Verify finished imports");
      // Pi starts immediately if idle and queues behind active work if busy.
      expect(sendUserMessage).toHaveBeenCalledWith("Verify finished imports", {
        deliverAs: "followUp",
      });
      toast!("Verification queued", "info");
      expect(notify).toHaveBeenCalledTimes(hasUI ? 1 : 0);
    },
  );

  it("keeps explicit opt-out sessions notification-only", async () => {
    vi.stubEnv("LOOM_AUTO_RESUME", "0");
    await start();
    expect(vi.mocked(startGalaxyPoller).mock.calls[0][1]).toBeUndefined();
  });
});
