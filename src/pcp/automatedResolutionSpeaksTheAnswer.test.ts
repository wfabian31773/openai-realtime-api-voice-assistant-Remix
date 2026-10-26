/**
 * record_automated_resolution TELLS THE MODEL TO SPEAK THE ANSWER — task #147.
 *
 * Read from the source: the tool is a closure over the call's metadata and
 * the whole agent, and the fact under test is the shape of its success
 * return. The structural half — the bridge refusing a hangup while a tool
 * answer is unvoiced — is proven behaviourally in mediaStreamBridge.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../agents/pcpAgent.ts", import.meta.url), "utf8");
const start = src.indexOf("name: 'record_automated_resolution'");
const end = src.indexOf("const handoff = recordedTool({", start);
const tool = src.slice(start, end);

describe("record_automated_resolution", () => {
  it("exists, and its success return carries the instruction to say what the lookup found", () => {
    expect(start).toBeGreaterThan(0);
    expect(tool).toMatch(/guidance:\s*\n?\s*'Recorded\. Now tell the caller, in full, what the lookup found/);
    expect(tool).toMatch(/or that nothing is scheduled/);
    expect(tool).toMatch(/ask if there is anything else before ending the call/);
  });

  it("a failed submission is returned as-is — the instruction is for a recorded resolution only", () => {
    const failure = tool.indexOf("if (!response.success) return response;");
    const success = tool.indexOf("guidance:");
    expect(failure).toBeGreaterThan(0);
    expect(success).toBeGreaterThan(failure);
    // No bare `return response;` survives on the success path.
    expect(tool.slice(failure + "if (!response.success) return response;".length)).not.toMatch(/^\s*return response;/m);
  });
});
