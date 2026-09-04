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

/**
 * PROMPT BUDGET, measured 2026-09-04 through this harness.
 *
 * The operator's standing note is that *"Grok requires minimal prompting, we
 * should not be near our ceilings"*, and the four queue lanes were trimmed
 * for it. pcp never was — it has spent its whole life refused by this
 * runtime, so nobody ever put a number on it:
 *
 *   lane      total chars   lane's own share (total minus the knowledge pack)
 *   records        16,035   ~1,680 tokens  (trimmed 2026-09-03)
 *   pcp            18,360   ~2,260 tokens  (never trimmed for Grok)
 *
 * Not asserted as a ceiling here — that belongs with the lane's own pins, and
 * inventing a limit for pcp is the operator's call, not this file's. Recorded
 * so the next person does not have to re-derive it.
 */

/**
 * Lanes that must stay refused until the missing piece exists.
 *
 * pcp is NOT here any more. It is refused only when no transfer is injected,
 * and the operator asked for it to be prepared next — so it is covered below
 * under the condition it will actually run in, which is the condition nobody
 * had ever checked it in. azul-scheduling stays refused for its own reason
 * (the office-transfer side channel), which is a different thing.
 */
const REFUSED = ["azul-scheduling", "after-hours", "fantasy-football"];

/**
 * Lanes served only when a transfer is armed. Refused without one, and
 * expected to bind cleanly with one — both halves are asserted, because
 * "refused" and "broken" look identical from outside and pcp has spent its
 * whole life on the refused side of that.
 */
const TRANSFER_ONLY = ["pcp", "no-ivr"];

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

  it.each(TRANSFER_ONLY)("%s is refused without a transfer and binds with one", async (slug) => {
    const source = await defaultLaneSource();
    const metadata = {
      callSid: "CA-smoke",
      callId: "CA-smoke",
      callerPhone: "+15551234567",
      dialedNumber: "+15559876543",
    };

    // Without a transfer: refused, and it must SAY why rather than fail oddly.
    expect(laneSupportStatus(source.getAgentConfig(slug)!)).toBeTruthy();

    // With one: a real agent Grok would accept.
    const lane = await resolveLane(slug, metadata, {
      source,
      handoff: () => async () => ({ ok: true }),
    });
    expect(lane, `${slug} should resolve once a transfer is injected`).not.toBeNull();
    expect(lane!.voice.voiceName).not.toBe("sage");
    expect(lane!.agent.instructions.startsWith(buildKnowledgePack())).toBe(true);
    expect(lane!.agent.instructions).not.toContain("=>");
    expect(lane!.agent.skipped).toEqual([]);
    expect(JSON.stringify(lane!.agent.tools)).not.toContain('"strict"');

    /**
     * The safety layer has to travel. agentBinding borrows `outputGuardrails`
     * off the agent and the bridge enforces them; if that ever silently
     * stopped, pcp would answer real calls on the runtime with no medical
     * safety at all and nothing would look wrong. Measured 2026-09-04: 3.
     */
    expect(
      (lane!.agent as { guardrails?: unknown[] }).guardrails?.length ?? 0,
      `${slug} must carry its output guardrails onto the runtime`,
    ).toBeGreaterThan(0);
  });

  it.each(REFUSED)("%s stays refused, with a reason", async (slug) => {
    const source = await defaultLaneSource();
    const config = source.getAgentConfig(slug);
    if (!config) return; // not registered in this build
    expect(laneSupportStatus(config), `${slug} must name why it is refused`).toBeTruthy();
  });
});
