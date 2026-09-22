import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildResumePrompt,
  isAutoResumeEnabled,
  isResumableOutcome,
} from "../extensions/loom/auto-resume.js";
import { loadConfig } from "../extensions/loom/config";

vi.mock("../extensions/loom/config", () => ({ loadConfig: vi.fn(() => ({})) }));

beforeEach(() => {
  vi.stubEnv("LOOM_AUTO_RESUME", undefined);
  vi.mocked(loadConfig).mockReturnValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("isAutoResumeEnabled", () => {
  it("follows up automatically without an experimental opt-in", () => {
    expect(isAutoResumeEnabled()).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: false } });
    expect(isAutoResumeEnabled()).toBe(false);
  });

  it("allows the env to enable follow-up over a config opt-out", () => {
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: false } });
    vi.stubEnv("LOOM_AUTO_RESUME", "1");
    expect(isAutoResumeEnabled()).toBe(true);
  });

  it("allows the env to disable follow-up over a config opt-in", () => {
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: true } });
    vi.stubEnv("LOOM_AUTO_RESUME", "0");
    expect(isAutoResumeEnabled()).toBe(false);
  });

  it("ignores invalid env values and keeps the configured preference", () => {
    vi.stubEnv("LOOM_AUTO_RESUME", "yes");
    expect(isAutoResumeEnabled()).toBe(true);
    vi.mocked(loadConfig).mockReturnValue({ experiments: { autoResume: false } });
    expect(isAutoResumeEnabled()).toBe(false);
  });
});

describe("buildResumePrompt", () => {
  it("identifies every run and directs verification and diagnosis without a user relay", () => {
    const p = buildResumePrompt([
      { kind: "job", id: "job-1", label: 'same "label"\ntext', outcome: "completed" },
      {
        kind: "invocation",
        id: "inv-1",
        label: 'same "label"\ntext',
        outcome: "failing",
        detail: "1 failed, 2 running",
      },
    ]);
    expect(p).toContain('"id": "job-1"');
    expect(p).toContain('"id": "inv-1"');
    expect(p).toContain(JSON.stringify('same "label"\ntext'));
    expect(p).toContain("1 failed, 2 running");
    expect(p).toContain("verify the output datasets now");
    expect(p).toContain("investigate now");
    expect(p).toContain("stderr");
    expect(p).toContain("invocation messages");
    expect(p).toContain("never ask them to ask you");
  });

  it("continues authorized work while preserving evidence, scope and stop boundaries", () => {
    const p = buildResumePrompt([{ kind: "job", id: "j", label: "x", outcome: "completed" }]);
    expect(p).toContain("Record the evidence in the notebook before marking");
    expect(p).toContain("Continue already-authorized work when its prerequisites are verified");
    expect(p).toContain("Respect any request to pause or stop");
    expect(p).toContain("do not blindly retry");
    expect(p).toContain("does not authorize a new analysis");
    expect(p).not.toContain("Report what you found and STOP");
  });
});

describe("isResumableOutcome", () => {
  it("wakes for success and failure, but not cancellation, skips or active jobs", () => {
    expect(isResumableOutcome("completed")).toBe(true);
    expect(isResumableOutcome("failed")).toBe(true);
    for (const status of ["cancelled", "skipped", "in_progress"]) {
      expect(isResumableOutcome(status)).toBe(false);
    }
  });
});
