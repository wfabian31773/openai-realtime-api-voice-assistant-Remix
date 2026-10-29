import { readCommittedScenarios } from "../src/plugin/operatorScenarios";

const manifest = readCommittedScenarios();
if (!manifest) {
  console.error("Operator scenario manifest does not match the committed .md files.");
  process.exitCode = 1;
} else {
  console.log(`Operator scenario manifest verified: ${Object.keys(manifest).length} scenarios.`);
}
