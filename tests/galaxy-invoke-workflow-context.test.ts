import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../extensions/loom/config", () => ({
  loadConfig: () => ({ executionMode: "hybrid" }),
}));

import { buildGalaxyContextBlock } from "../extensions/loom/context";

let prev: Record<string, string | undefined>;

beforeEach(() => {
  prev = { url: process.env.GALAXY_URL, key: process.env.GALAXY_API_KEY };
  process.env.GALAXY_URL = "https://galaxy.test";
  process.env.GALAXY_API_KEY = "k";
});

afterEach(() => {
  process.env.GALAXY_URL = prev.url;
  process.env.GALAXY_API_KEY = prev.key;
});

describe("buildGalaxyContextBlock workflow-invocation guidance", () => {
  it("points at the input-template tool before invoking", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("galaxy_get_workflow_input_template");
    expect(block).toContain("inputs_template");
  });

  it("states that every input slot goes in inputs, data and non-data alike", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/\*\*Every\*\* input slot goes in `inputs`/);
    expect(block).toContain("non-data alike");
  });

  it("gives the pipe-separated inputs_by value verbatim", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain('inputs_by="step_index|step_uuid"');
  });

  it("rules out params for workflow inputs and names the pydantic error", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/Workflow inputs never go in `params`/);
    // The exact 400 the model loops on -- so it can match what it just saw.
    expect(block).toContain(
      "Input should be a valid dictionary in ('body','parameters',<key>)",
    );
  });

  it("says params values are dicts, and re-keying under params never works", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain("must be *dicts*");
    expect(block).toMatch(/re-keying it under `params`[\s\S]*never work/);
  });

  it("omits the guidance entirely when Galaxy is not connected", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    const block = buildGalaxyContextBlock();
    expect(block).not.toContain("galaxy_get_workflow_input_template");
  });
});
