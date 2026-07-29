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
    expect(block).toContain("galaxy_invoke_workflow");
  });

  it("says to replace the template placeholders rather than send them", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/swap each placeholder/i);
    // The literal placeholders build_workflow_input_template emits -- a model
    // that submits these verbatim gets a confusing downstream failure.
    expect(block).toContain("<value>");
    expect(block).toContain("<dataset_id>");
  });

  it("routes data and non-data slots alike into inputs", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/non-data slots both belong in `inputs`/);
    expect(block).toContain('{"src":"hdca","id":');
    expect(block).toMatch(/bare scalar/);
  });

  it("allows optional and defaulted slots to be omitted", () => {
    const block = buildGalaxyContextBlock();
    // Galaxy only rejects a missing input that is neither optional nor
    // defaulted (run_request.py _normalize_inputs), so the prompt must not
    // demand a value for every slot.
    expect(block).toMatch(/optional, or that carry a default, may be left out/);
  });

  it("gives the pipe-separated inputs_by value verbatim", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toContain('inputs_by="step_index|step_uuid"');
  });

  it("explains why a scalar in params 400s, naming the exact error", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/Don't route workflow inputs through `params`/);
    expect(block).toContain("dict[str, dict]");
    // The error the model loops on, so it can match what it just saw.
    expect(block).toContain(
      "Input should be a valid dictionary in\n  ('body','parameters',<key>)",
    );
  });

  it("blames the value type, not the key, without overclaiming", () => {
    const block = buildGalaxyContextBlock();
    expect(block).toMatch(/the key was never the problem/);
    // params CAN legally carry a parameter_input as {"input": v} via Galaxy's
    // legacy normalization, so the prompt must steer without asserting that
    // params can never work -- a claim the source contradicts.
    expect(block).not.toMatch(/never work/i);
    expect(block).not.toMatch(/inputs never go in `params`/i);
  });

  it("omits the guidance entirely when Galaxy is not connected", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    const block = buildGalaxyContextBlock();
    expect(block).not.toContain("galaxy_get_workflow_input_template");
  });
});
