import { expect, it } from "vitest";

const scripts = [
  ["test-offline.mjs", () => import("./test-offline.mjs")],
  ["test-operator-offline.mjs", () => import("./test-operator-offline.mjs")],
  ["test-operator-prepare-offline.mjs", () => import("./test-operator-prepare-offline.mjs")],
] as const;

for (const [script, load] of scripts) {
  it(`runs ${script} with mocked fetch`, async () => {
    const previousFetch = globalThis.fetch;
    try {
      // These scripts use node:assert; importing executes every offline assertion.
      await expect(load()).resolves.toBeDefined();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}
