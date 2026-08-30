import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { resolveLane, laneSupportStatus, type LaneConfig, type LaneSource } from "./laneRegistry";
import { buildKnowledgePack } from "./knowledgePack";

/** A stand-in for one of the real agents: an object with `instructions`
 * and `tools`, which is all the runtime borrows. */
function fakeAgent(instructions = "You are the optical queue agent.") {
  return {
    instructions,
    tools: [
      {
        name: "create_ticket",
        description: "File a callback request.",
        parameters: z.object({ reason: z.string(), notes: z.string().optional() }),
        invoke: vi.fn(async () => ({ ok: true })),
      },
    ],
  };
}

function source(config: Partial<LaneConfig> & { id: string }): LaneSource {
  const full: LaneConfig = {
    enabled: true,
    factory: vi.fn(async () => fakeAgent()) as unknown as LaneConfig["factory"],
    ...config,
  };
  return { getAgentConfig: (id) => (id === full.id ? full : undefined) };
}

const META = {
  callSid: "CA1",
  callId: "CA1",
  callerPhone: "+15551234567",
  dialedNumber: "+15559876543",
};

describe("resolving a lane through the registry that already exists", () => {
  it("borrows the agent's own instructions, with the knowledge pack in front", async () => {
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical" }),
      env: {},
    });
    expect(lane).not.toBeNull();
    expect(lane!.agent.instructions.startsWith(buildKnowledgePack())).toBe(true);
    expect(lane!.agent.instructions).toContain("You are the optical queue agent.");
  });

  it("passes the call's own context to the agent's factory, exactly as the SIP transport does", async () => {
    const factory = vi.fn(async () => fakeAgent());
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical", factory: factory as unknown as LaneConfig["factory"] }),
      env: {},
    });
    expect(lane).not.toBeNull();
    const [, metadata] = factory.mock.calls[0] as unknown as [unknown, typeof META];
    expect(metadata.callSid).toBe("CA1");
    expect(metadata.callerPhone).toBe("+15551234567");
    expect(metadata.dialedNumber).toBe("+15559876543");
  });

  it("hands the factory a handoff that REFUSES rather than a no-op that lies", async () => {
    const factory = vi.fn(async () => fakeAgent());
    await resolveLane("optical", META, {
      source: source({ id: "optical", factory: factory as unknown as LaneConfig["factory"] }),
      env: {},
    });
    const [handoff] = factory.mock.calls[0] as unknown as [() => Promise<void>];
    // Operator ruling 2026-08-12: no answering-service lane transfers. A
    // silent no-op would let a lane tell a caller they were being
    // transferred and then drop them.
    await expect(handoff()).rejects.toThrow(/no call transfer/i);
  });

  it("carries the agent's tools through with their own schema, never strict", async () => {
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical" }),
      env: {},
    });
    expect(lane!.agent.toolNames).toEqual(["create_ticket"]);
    const schema = JSON.stringify(lane!.agent.tools[0]);
    expect(schema).not.toContain('"strict"');
    // A real Zod .optional() must stay out of `required` — the exact shape
    // that blocked every surgery filing on 2026-08-12 when it was forced.
    expect(lane!.agent.tools[0].parameters.required).toEqual(["reason"]);
  });

  it("returns null for an unknown slug instead of substituting a default agent", async () => {
    const lane = await resolveLane("not-a-lane", META, {
      source: source({ id: "optical" }),
      env: {},
    });
    expect(lane).toBeNull();
  });

  it("returns null for a lane the operator turned OFF", async () => {
    const lane = await resolveLane("pcp", META, {
      source: source({ id: "pcp", enabled: false }),
      env: {},
    });
    expect(lane).toBeNull();
  });
});

describe("factory contracts differ per agent (Codex review, PR #227)", () => {
  it("refuses a lane whose factory takes a different argument layout", async () => {
    // createAfterHoursAgent(handoff, recordPatientInfoCallback, metadata).
    // Called with the uniform shape, the metadata lands in the callback
    // slot: the agent loses caller context and later tries to invoke that
    // object, reporting system_error and risking a duplicate ticket.
    const factory = vi.fn(async () => fakeAgent());
    const lane = await resolveLane("after-hours", META, {
      source: source({ id: "after-hours", factory: factory as unknown as LaneConfig["factory"] }),
      env: {},
    });
    expect(lane).toBeNull();
    // Refused BEFORE construction — never called with mangled arguments.
    expect(factory).not.toHaveBeenCalled();
  });

  it("refuses an OUTBOUND agent — this runtime answers inbound calls", async () => {
    const factory = vi.fn(async () => fakeAgent());
    const lane = await resolveLane("fantasy-football", META, {
      source: source({
        id: "fantasy-football",
        agentType: "outbound",
        factory: factory as unknown as LaneConfig["factory"],
      }),
      env: {},
    });
    expect(lane).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("names why a lane is unsupported rather than failing silently", () => {
    expect(laneSupportStatus({ id: "after-hours", enabled: true, factory: () => undefined }))
      .toMatch(/argument layout|contract/i);
    expect(
      laneSupportStatus({
        id: "drs-scheduler",
        enabled: true,
        agentType: "outbound",
        factory: () => undefined,
      }),
    ).toMatch(/outbound/i);
    expect(
      laneSupportStatus({
        id: "optical",
        enabled: true,
        agentType: "inbound",
        factory: () => undefined,
      }),
    ).toBeNull();
  });

  it("refuses a lane whose agent actually performs a transfer", async () => {
    // Measured, not assumed: noIvrAgent invokes the handoff callback in
    // three places, azulSchedulingAgent and pcpAgent once each; optical,
    // surgery, tech, records and answering-service never call it — which is
    // exactly the operator's 2026-08-12 ruling. A callback that throws is
    // right for the lanes that never call it and wrong for the ones that
    // do: a sanctioned emergency transfer would always report failure.
    for (const id of ["no-ivr", "no-ivr-v2", "dev-no-ivr", "azul-scheduling", "pcp"]) {
      const factory = vi.fn(async () => fakeAgent());
      const lane = await resolveLane(id, META, {
        source: source({ id, agentType: "inbound", factory: factory as unknown as LaneConfig["factory"] }),
        env: {},
      });
      expect(lane, `${id} should be refused until a transfer exists`).toBeNull();
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it("says a transfer is why, not something vague", () => {
    expect(
      laneSupportStatus({ id: "pcp", enabled: true, agentType: "inbound", factory: () => undefined }),
    ).toMatch(/transfer/i);
  });

  it("still serves every lane that does use the uniform shape", async () => {
    for (const id of ["optical", "surgery", "tech", "records", "answering-service"]) {
      const lane = await resolveLane(id, META, {
        source: source({ id, agentType: "inbound" }),
        env: {},
      });
      expect(lane, `${id} should resolve`).not.toBeNull();
    }
  });
});

describe("per-lane voice and language", () => {
  it("NEVER sends the registry's OpenAI voice to Grok", async () => {
    // Every supported inbound agent registers `voice: 'sage'` — an OpenAI
    // voice name. Grok has no such voice, so passing it through fails
    // session setup on every lane (Codex review, PR #227). The registry's
    // voice field belongs to the other provider.
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical", voice: "sage", language: "es" }),
      env: {},
    });
    expect(lane!.voice.voiceName).not.toBe("sage");
    expect(lane!.voice.voiceName).toBe("eve");
    // Language IS provider-neutral, so the registry's value still counts.
    expect(lane!.voice.language).toBe("es");
  });

  it("lets a per-lane env override win, so a voice can change without a deploy", async () => {
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical", voice: "sage" }),
      env: { XAI_VOICE_NAME_OPTICAL: "eve" },
    });
    expect(lane!.voice.voiceName).toBe("eve");
  });

  it("a per-lane env override is how a lane gets its own GROK voice", async () => {
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical", voice: "coral" }),
      env: { XAI_VOICE_NAME_OPTICAL: "nova" },
    });
    expect(lane!.voice.voiceName).toBe("nova");
  });

  it("falls back to the runtime default when neither says anything", async () => {
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical" }),
      env: {},
    });
    expect(lane!.voice.voiceName).toBe("eve");
    expect(lane!.voice.language).toBe("en");
  });

  it("keeps the lane's version for the record", async () => {
    const lane = await resolveLane("optical", META, {
      source: source({ id: "optical", version: "v1.4.0" }),
      env: {},
    });
    expect(lane!.version).toBe("v1.4.0");
  });
});

describe("the cache prefix the whole fleet shares", () => {
  it("is byte-identical across lanes up to each agent's own instructions", async () => {
    const optical = await resolveLane("optical", META, {
      source: source({ id: "optical" }),
      env: {},
    });
    const surgery = await resolveLane("surgery", META, {
      source: {
        getAgentConfig: (id) =>
          id === "surgery"
            ? {
                id: "surgery",
                enabled: true,
                factory: (async () =>
                  fakeAgent("You are the surgery queue agent.")) as unknown as LaneConfig["factory"],
              }
            : undefined,
      },
      env: {},
    });
    const pack = buildKnowledgePack();
    expect(optical!.agent.instructions.slice(0, pack.length)).toBe(
      surgery!.agent.instructions.slice(0, pack.length),
    );
  });
});

describe("a lane that transfers is served only when a handoff is injected", () => {
  /**
   * The refusal was never about these lanes being unsuitable — it was that the
   * transport could not transfer, so serving them would turn a sanctioned
   * transfer into a guaranteed failure. Now that `warmTransfer.ts` exists, the
   * refusal has to key on whether THIS deployment wired one, not on the lane.
   */
  it("still refuses a transfer-capable lane when no handoff is configured", () => {
    const reason = laneSupportStatus({ id: "pcp", enabled: true, agentType: "inbound" } as LaneConfig);
    expect(reason).toMatch(/no handoff is configured/);
  });

  it("serves the same lane once a handoff is available", () => {
    const reason = laneSupportStatus(
      { id: "pcp", enabled: true, agentType: "inbound" } as LaneConfig,
      { transferAvailable: true },
    );
    expect(reason).toBeNull();
  });

  it("an injected handoff does not excuse a non-uniform factory layout", () => {
    // after-hours is (handoff, recordPatientInfoCallback, metadata) — a
    // transfer being available says nothing about argument slots.
    const reason = laneSupportStatus(
      { id: "after-hours", enabled: true, agentType: "inbound" } as LaneConfig,
      { transferAvailable: true },
    );
    expect(reason).toMatch(/factory argument layout/);
  });

  it("an injected handoff does not make an outbound agent inbound", () => {
    const reason = laneSupportStatus(
      { id: "fantasy-football", enabled: true, agentType: "outbound" } as LaneConfig,
      { transferAvailable: true },
    );
    expect(reason).toMatch(/answers inbound calls/);
  });

  it("hands the REAL callback to a transfer-capable lane", async () => {
    const factory = vi.fn(async (_handoff: () => Promise<void>, _meta: unknown) => fakeAgent());
    const realHandoff = vi.fn(async () => undefined);
    await resolveLane("pcp", META, {
      source: { getAgentConfig: () => ({ id: "pcp", enabled: true, agentType: "inbound", factory }) as LaneConfig },
      handoff: () => realHandoff,
    });
    const passed = factory.mock.calls[0][0];
    await passed();
    expect(realHandoff).toHaveBeenCalledOnce();
  });

  it("keeps the REFUSING callback for a lane that must never transfer", async () => {
    // Standing instruction 9: optical, surgery, tech, records and
    // answering-service get no transfer tool at all. The throwing callback is
    // a tripwire that should never trip — injecting a real transfer for the
    // whole deployment must not arm it for them.
    const factory = vi.fn(async (_handoff: () => Promise<void>, _meta: unknown) => fakeAgent());
    const realHandoff = vi.fn(async () => undefined);
    await resolveLane("optical", META, {
      source: { getAgentConfig: () => ({ id: "optical", enabled: true, agentType: "inbound", factory }) as LaneConfig },
      handoff: () => realHandoff,
    });
    const passed = factory.mock.calls[0][0];
    await expect(passed()).rejects.toThrow(/performs no call transfer/);
    expect(realHandoff).not.toHaveBeenCalled();
  });

  it("builds the handoff with this call's metadata, not a shared one", async () => {
    const seen: unknown[] = [];
    const factory = vi.fn(async () => fakeAgent());
    await resolveLane("pcp", META, {
      source: { getAgentConfig: () => ({ id: "pcp", enabled: true, agentType: "inbound", factory }) as LaneConfig },
      handoff: (metadata) => {
        seen.push(metadata);
        return async () => undefined;
      },
    });
    expect(seen).toEqual([META]);
  });
});
