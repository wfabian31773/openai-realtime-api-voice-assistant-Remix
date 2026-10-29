import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface OperatorScenario {
  id: string;
  title: string;
  dial: string;
  caller: string;
  script: string;
  expect: string;
}

/** Parse the vendored Markdown, including wrapped fields and baseline/build expectations. */
export function parseOperatorScenarios(markdown: string): OperatorScenario[] {
  const scenarios: OperatorScenario[] = [];
  const sections = [...markdown.matchAll(/^## (A(?:10|[1-9])) — (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  for (const [, id, title, section] of sections) {
    if (scenarios.some((scenario) => scenario.id === id)) throw new Error(`Duplicate scenario ${id}`);
    const fields: Record<string, string[]> = {};
    let current = "";
    for (const line of section.split(/\r?\n/)) {
      const field = line.match(/^- \*\*(Dial|Caller|Script|Expect)([^*]*):\*\*\s*(.*)$/);
      if (field) {
        current = field[1].toLowerCase();
        (fields[current] ??= []).push(`${field[2] ? `${field[2].trim()}: ` : ""}${field[3]}`);
      } else if (current && line.trim()) fields[current].push(line.trim());
    }
    for (const key of ["dial", "caller", "script", "expect"]) {
      if (!fields[key]?.join(" ").trim()) throw new Error(`Missing ${key} in scenario ${id}`);
    }
    scenarios.push({ id, title, dial: fields.dial.join(" "), caller: fields.caller.join(" "),
      script: fields.script.join(" "), expect: fields.expect.join(" ") });
  }
  return scenarios;
}

// Resolve from the module, so loading does not depend on the server's working directory.
const packPaths = ["../../test-bench/packs/pack-01.md", "../../../test-bench/packs/pack-01.md"]
  .map((path) => fileURLToPath(new URL(path, import.meta.url)));
export function lookupOperatorScenario(id: string): OperatorScenario | undefined {
  const packPath = packPaths.find((path) => existsSync(path));
  if (!packPath) throw new Error("Operator scenario pack is unavailable");
  return parseOperatorScenarios(readFileSync(packPath, "utf8")).find((scenario) => scenario.id === id);
}

export function operatorScenarioGoal(scenario: OperatorScenario): string {
  return `Run synthetic test scenario ${scenario.id}: ${scenario.title}. Act as the synthetic caller to the ${scenario.dial} line.\nCaller: ${scenario.caller}\nScript: ${scenario.script}\nExpect: ${scenario.expect}\n${scenario.id === "A4" ? "Do not tag this call; hang up as scripted." : `At the end say: Please note this was test call scenario ${scenario.id}.`}`;
}
