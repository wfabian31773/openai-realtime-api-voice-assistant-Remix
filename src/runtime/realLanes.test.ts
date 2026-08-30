/**
 * The only test that touches the REAL agent tree.
 *
 * Every other test in src/runtime substitutes a fake lane source, which is
 * what keeps the suite fast and offline — and is also exactly why a whole
 * class of defect got through review. The `sage` bug is the clearest case:
 * every inbound agent registers an OpenAI voice name, the runtime passed it
 * to Grok, and no test using a fixture agent could ever have noticed. This
 * one fails on all five lanes the moment that regresses; verified by
 * reintroducing it.
 *
 * What it does NOT catch, so the limit is on the record rather than
 * assumed: the stringified-prompt-closure bug. None of the five served
 * lanes builds its instructions with a closure — `azul-scheduling` and
 * `after-hours` do, and both are currently refused for other reasons. If
 * either is ever served, this test starts covering that path too; until
 * then only agentBinding's own unit tests do. Reintroducing that bug leaves
 * this file green, which was worth finding out before claiming otherwise.
 *
 * It is opt-in because it imports src/config/agents, which pulls in every
 * agent and their database and API clients: it needs DATABASE_URL and
 * OPENAI_API_KEY present (any value — nothing here makes a real call, and
 * the lookups it triggers fail closed and are ignored).
 *
 *     RUNTIME_LANE_SMOKE=1 DATABASE_URL=... OPENAI_API_KEY=... \
 *       npx vitest run src/runtime/realLanes.test.ts
 *
 * Run it before pointing a number at a lane. It answers the one question
 * the offline suite cannot: does this agent, as it actually exists today,
 * come out of the binding in a shape Grok will accept?
 */
import { describe, it, expect } from "vitest";
import { resolveLane, defaultLaneSource, laneSupportStatus } from "./laneRegistry";
import { buildKnowledgePack } from "./knowledgePack";

const ENABLED = process.env.RUNTIME_LANE_SMOKE === "1";

/** The lanes this runtime is meant to be able to serve. */
const SERVED = ["optical", "surgery", "tech", "records", "answering-service"];

/** Lanes that must stay refused until the missing piece exists. */
const REFUSED = ["no-ivr", "pcp", "azul-scheduling", "after-hours", "fantasy-football"];

describe.skipIf(!ENABLED)("every served lane resolves against the real agent registry", () => {
  it.each(SERVED)("%s builds an agent Grok would accept", async (slug) => {
    const source = await defaultLaneSource();
    const lane = await resolveLane(
      slug,
      {
        callSid: "CA-smoke",
        callId: "CA-smoke",
        callerPhone: "+15551234567",
        dialedNumber: "+15559876543",
      },
      { source },
    );
    expect(lane, `${slug} should resolve`).not.toBeNull();

    // A GROK voice, never the registry's OpenAI one. Every inbound agent
    // registers 'sage'; sending it fails session setup on every lane.
    expect(lane!.voice.voiceName).not.toBe("sage");

    // A real prompt, not a stringified closure and not an empty string.
    expect(lane!.agent.instructions.length).toBeGreaterThan(2_000);
    expect(lane!.agent.instructions).not.toContain("=>");
    expect(lane!.agent.instructions.startsWith(buildKnowledgePack())).toBe(true);

    // Real tools, all convertible, none silently dropped.
    expect(lane!.agent.tools.length).toBeGreaterThan(0);
    expect(lane!.agent.skipped).toEqual([]);
    // The rule that cost most of 2026-08-12: never strict mode.
    expect(JSON.stringify(lane!.agent.tools)).not.toContain('"strict"');
    for (const tool of lane!.agent.tools) {
      expect(tool.name, `${slug} tool needs a name`).toBeTruthy();
      expect(tool.parameters, `${slug}/${tool.name} needs a schema`).toBeTruthy();
    }
  });

  it.each(REFUSED)("%s stays refused, with a reason", async (slug) => {
    const source = await defaultLaneSource();
    const config = source.getAgentConfig(slug);
    if (!config) return; // not registered in this build
    expect(laneSupportStatus(config), `${slug} must name why it is refused`).toBeTruthy();
  });
});
