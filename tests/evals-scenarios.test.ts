import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Scenario } from "../evals/lib/types";

const __filename2 = fileURLToPath(import.meta.url);
const scenariosDir = path.resolve(path.dirname(__filename2), "..", "evals", "scenarios");

function loadScenario(name: string): Scenario {
  return JSON.parse(
    fs.readFileSync(path.join(scenariosDir, name, "scenario.json"), "utf-8"),
  ) as Scenario;
}

describe("evals scenarios: every scenario.json parses with required fields", () => {
  const dirs = fs
    .readdirSync(scenariosDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const dir of dirs) {
    it(`${dir} has name, tier, inputs, assertions`, () => {
      const s = loadScenario(dir);
      expect(typeof s.name).toBe("string");
      expect([1, 2]).toContain(s.tier);
      expect(Array.isArray(s.inputs)).toBe(true);
      expect(s.assertions).toBeTruthy();
    });

    it(`${dir} has compilable chatText patterns`, () => {
      // evaluate() degrades a bad pattern into a failure row rather than
      // throwing, so without this it would show up as every model failing.
      const s = loadScenario(dir);
      const patterns = [
        ...(s.assertions.chatText?.mustMatch ?? []),
        ...(s.assertions.chatText?.mustNotMatch ?? []),
      ];
      for (const p of patterns) expect(() => new RegExp(p), p).not.toThrow();
    });
  }

  it("rnaseq routes galaxy/hybrid and names a known RNA-seq tool", () => {
    const s = loadScenario("plan-creation-rnaseq");
    expect(s.assertions.plan?.routingIn).toEqual(["galaxy", "hybrid"]);
    expect(s.assertions.plan?.mentionsOneOf).toContain("HISAT2");
  });

  it("pharmacogenomics routes local/hybrid (consumer data stays off public Galaxy)", () => {
    const s = loadScenario("plan-creation-pharmacogenomics");
    expect(s.assertions.plan?.routingIn).toEqual(["local", "hybrid"]);
  });

  it("routing-clear-local must not route to galaxy", () => {
    const s = loadScenario("routing-clear-local");
    expect(s.assertions.plan?.routingIn).toEqual(["local", "hybrid"]);
  });

  it("behavior-underspecified-ask asserts asksClarifyingQuestion", () => {
    const s = loadScenario("behavior-underspecified-ask");
    expect(s.assertions.behavior?.asksClarifyingQuestion).toBe(true);
  });
});
