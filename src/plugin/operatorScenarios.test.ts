import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { lookupOperatorScenario, operatorScenarioGoal, parseOperatorScenarios } from "./operatorScenarios";
import { parseOperatorPayload } from "./operatorLine";

const pack = readFileSync(new URL("../../test-bench/packs/pack-01.md", import.meta.url), "utf8");

describe("optional operator test pack", () => {
  it("loads A1-A10 with every field, wrapped text, bullets and both A3 expectations", () => {
    const scenarios = parseOperatorScenarios(pack);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(Array.from({ length: 10 }, (_, i) => `A${i + 1}`));
    for (const scenario of scenarios) {
      for (const field of ["title", "dial", "caller", "script", "expect"] as const) expect(scenario[field].length).toBeGreaterThan(3);
    }
    expect(scenarios[0]).toMatchObject({ dial: "optical.", caller: expect.stringContaining("usual office Covina"),
      script: expect.stringContaining("B-E-N-C-H-M-A-R-K"), expect: expect.stringContaining("date of birth is asked once") });
    expect(scenarios[2].expect).toContain("build with v141");
    expect(scenarios[2].expect).toContain("baseline v136");
    expect(scenarios[6].caller).toContain("Covina");
    expect(scenarios[9].script).toContain("Hola");
    expect(parseOperatorScenarios(pack.replace(/\n/g, "\r\n"))).toEqual(scenarios);
  });

  it("rejects incomplete and duplicate scenarios", () => {
    expect(() => parseOperatorScenarios(pack.replace("- **Caller:** Lena", "- Caller: Lena"))).toThrow("Missing caller in scenario A1");
    expect(() => parseOperatorScenarios(pack + "\n" + pack)).toThrow("Duplicate scenario A1");
    expect(parseOperatorScenarios("# Empty pack")).toEqual([]);
  });

  it("looks up exact scenario ids and preserves A4's hangup instruction", () => {
    expect(lookupOperatorScenario("A10")?.title).toContain("Spanish");
    expect(lookupOperatorScenario("A11")).toBeUndefined();
    expect(lookupOperatorScenario("a1")).toBeUndefined();
    expect(operatorScenarioGoal(lookupOperatorScenario("A4")!)).toContain("Do not tag this call");
    expect(operatorScenarioGoal(lookupOperatorScenario("A1")!)).toContain("Please note this was test call scenario A1.");
  });

  it.each(Array.from({ length: 10 }, (_, i) => `A${i + 1}`))("uses %s as an optional goal without a fingerprint gate", (id) => {
    const parsed = parseOperatorPayload({ phone: "+15555550123", scenario_id: id });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.purpose).toBe(operatorScenarioGoal(lookupOperatorScenario(id)!));
    // A locked approval is parsed again at send; scenario expansion is stable.
    expect(parseOperatorPayload(parsed.payload)).toEqual(parsed);
  });

  it("preserves ordinary goals and rejects unknown/ambiguous scenario requests", () => {
    expect(parseOperatorPayload({ phone: "+15555550123", purpose: "Find office hours" })).toMatchObject({ ok: true, payload: { purpose: "Find office hours" } });
    for (const scenario_id of ["A11", 1, null, ""]) expect(parseOperatorPayload({ phone: "+15555550123", scenario_id }).ok).toBe(false);
    expect(parseOperatorPayload({ phone: "+15555550123", scenario_id: "A1", purpose: "Something else" }).ok).toBe(false);
  });
});
