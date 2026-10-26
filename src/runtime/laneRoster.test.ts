/**
 * "Ensure the runtime has everything we needed on there" — as a question the
 * deployment answers about itself, rather than one answered by dialling.
 *
 * The case that matters most right now is pcp: it is transfer-capable, it is
 * the next lane being prepared, and it can pass every check here while still
 * having nowhere to dial.
 */
import {describe, it, expect, vi } from "vitest";
// HOISTED above every import: since v78 `laneRegistry` imports the tool
// library STATICALLY and its telemetry module validates DATABASE_URL at
// import, so the environment has to exist before the import graph loads.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
  process.env.XAI_API_KEY ||= 'test-unused';
});
import { laneRoster, formatLaneRoster, REPORTED_LANES } from "./laneRoster";
import { defaultLaneSource, type LaneSource } from "./laneRegistry";

/** Enough of an agent config for laneSupportStatus to judge it. */
const inbound = (id: string, enabled = true) => ({ id, agentType: "inbound" as const, enabled });

const source = (ids: string[], disabled: string[] = []): LaneSource => ({
  getAgentConfig: (id: string) =>
    ids.includes(id) ? (inbound(id, !disabled.includes(id)) as never) : undefined,
});

const ALL = source([...REPORTED_LANES]);
const FULL_ENV = {
  HUMAN_AGENT_NUMBER: "+15550000001",
  PCP_HUMAN_AGENT_NUMBER: "+15550000002",
};

const bySlug = (rows: ReturnType<typeof laneRoster>) =>
  Object.fromEntries(rows.map((r) => [r.slug, r]));

describe("what this deployment can serve", () => {
  it("serves the four queue lanes with no transfer configured at all", () => {
    const r = bySlug(laneRoster(ALL, {}, { transferAvailable: false }));
    for (const slug of ["optical", "surgery", "tech", "records"]) {
      expect(r[slug].servable, slug).toBe(true);
      expect(r[slug].blockedBy, slug).toBeNull();
    }
  });

  it("refuses pcp and no-ivr when no transfer is armed, and says why", () => {
    const r = bySlug(laneRoster(ALL, {}, { transferAvailable: false }));
    for (const slug of ["pcp", "no-ivr"]) {
      expect(r[slug].servable, slug).toBe(false);
      expect(r[slug].blockedBy, slug).toContain("no handoff is configured");
    }
  });

  it("serves pcp and no-ivr once a transfer IS armed", () => {
    const r = bySlug(laneRoster(ALL, FULL_ENV, { transferAvailable: true }));
    expect(r.pcp.servable).toBe(true);
    expect(r["no-ivr"].servable).toBe(true);
  });

  /**
   * THE TRAP. pcp passes laneSupportStatus and answers calls, and every
   * transfer it attempts dies at resolveHandoffDestination because
   * PCP_HUMAN_AGENT_NUMBER is unset. Codex caught this shape for the
   * top-level flag in PR #236; per lane nothing reported it, and pcp is the
   * lane it would bite next.
   */
  it("warns when a served lane has its transport armed but nowhere to dial", () => {
    const r = bySlug(
      laneRoster(ALL, { HUMAN_AGENT_NUMBER: "+15550000001" }, { transferAvailable: true }),
    );
    expect(r.pcp.servable).toBe(true);
    expect(r.pcp.blockedBy).toBeNull();
    expect(r.pcp.transferWarning).toContain("PCP_HUMAN_AGENT_NUMBER");
    // The clinical number IS set, so the no-ivr family must not be warned.
    expect(r["no-ivr"].transferWarning).toBeNull();
  });

  it("warns about the no-ivr family on the OTHER number, independently", () => {
    const r = bySlug(
      laneRoster(ALL, { PCP_HUMAN_AGENT_NUMBER: "+15550000002" }, { transferAvailable: true }),
    );
    expect(r["no-ivr"].transferWarning).toContain("HUMAN_AGENT_NUMBER");
    expect(r.pcp.transferWarning).toBeNull();
  });

  it("never warns about a lane that does not transfer", () => {
    const r = bySlug(laneRoster(ALL, {}, { transferAvailable: true }));
    for (const slug of ["optical", "surgery", "tech", "records"]) {
      expect(r[slug].transferWarning, slug).toBeNull();
    }
  });

  it("keeps azul-scheduling refused for its own reason, not the transfer one", () => {
    const r = bySlug(laneRoster(ALL, FULL_ENV, { transferAvailable: true }));
    expect(r["azul-scheduling"].servable).toBe(false);
    expect(r["azul-scheduling"].blockedBy).toContain("side channel");
  });

  /**
   * `resolveLane` returns null for a disabled lane BEFORE it reaches
   * laneSupportStatus, and laneSupportStatus never checks the flag — so the
   * roster advertised a deliberately switched-off lane as servable, which
   * defeats the readiness report at exactly the moment it matters (Codex,
   * PR #268 round 4).
   */
  it("reports a DISABLED lane as unservable, the way resolveLane treats it", () => {
    const r = bySlug(
      laneRoster(source([...REPORTED_LANES], ["records"]), FULL_ENV, { transferAvailable: true }),
    );
    expect(r.records.registered).toBe(true);
    expect(r.records.servable).toBe(false);
    expect(r.records.blockedBy).toContain("disabled");
    // Its neighbours are unaffected.
    expect(r.optical.servable).toBe(true);
  });

  it("does not warn about a transfer for a lane that is disabled anyway", () => {
    const r = bySlug(
      laneRoster(source([...REPORTED_LANES], ["pcp"]), { HUMAN_AGENT_NUMBER: "+1555" }, {
        transferAvailable: true,
      }),
    );
    expect(r.pcp.servable).toBe(false);
    expect(r.pcp.transferWarning).toBeNull();
  });

  it("says so when a lane is not registered, rather than calling it refused", () => {
    const r = bySlug(laneRoster(source(["optical"]), {}, { transferAvailable: false }));
    expect(r.records.registered).toBe(false);
    expect(r.records.blockedBy).toContain("not registered");
  });
});

describe("the boot lines", () => {
  it("lead with the count, so a deployment serving nothing is obvious", () => {
    const lines = formatLaneRoster(laneRoster(ALL, {}, { transferAvailable: false }));
    // 5 of the 8 inbound lanes, plus the NPX outreach lane (v113): this fake
    // registers every slug as an inbound lane, so it counts as served.
    expect(lines[0]).toContain("lanes this deployment can serve (6/9)");
    expect(lines[0]).toContain("optical");
  });

  it("print one reason per refused lane", () => {
    const lines = formatLaneRoster(laneRoster(ALL, {}, { transferAvailable: false }));
    expect(lines.some((l) => l.includes("✗ pcp"))).toBe(true);
    expect(lines.some((l) => l.includes("✗ azul-scheduling"))).toBe(true);
  });

  it("print the destination warning for a lane that is served but cannot dial", () => {
    const lines = formatLaneRoster(
      laneRoster(ALL, { HUMAN_AGENT_NUMBER: "+1555" }, { transferAvailable: true }),
    );
    expect(lines.some((l) => l.includes("! ") && l.includes("PCP_HUMAN_AGENT_NUMBER"))).toBe(true);
  });

  it("say NONE rather than an empty list when nothing can be served", () => {
    const lines = formatLaneRoster(laneRoster(source([]), {}, { transferAvailable: false }));
    expect(lines[0]).toContain("NONE");
  });
});

/**
 * Which xAI model each lane would open a session with. Reported so a model
 * change — an env canary, or xAI renaming the pinned model under us, which is
 * how `grok-voice-think-fast-2.0` became the deprecated `grok-voice-2.0` on the
 * 2026-10-14 invoice — can be confirmed from `/voice/health` instead of
 * inferred from the next day's bill.
 */
describe("the voice model each lane would use", () => {
  it("reports grok-voice-3.0 on every registered lane when nothing overrides it (operator, 2026-10-19)", () => {
    const rows = laneRoster(ALL, {}, { transferAvailable: false });
    for (const row of rows) expect(row.voiceModel, row.slug).toBe("grok-voice-3.0");
  });

  it("a per-lane setting puts that lane back, and only that lane — the no-deploy revert", () => {
    const r = bySlug(
      laneRoster(ALL, { XAI_VOICE_MODEL_PCP: "grok-voice-think-fast-2.0" }, { transferAvailable: false }),
    );
    expect(r.pcp.voiceModel).toBe("grok-voice-think-fast-2.0");
    expect(r.tech.voiceModel).toBe("grok-voice-3.0");
    expect(r["no-ivr"].voiceModel).toBe("grok-voice-3.0");
  });

  it("lets the fleet-wide setting move every lane, with a per-lane setting still winning", () => {
    const r = bySlug(
      laneRoster(
        ALL,
        { XAI_VOICE_MODEL: "grok-voice-think-fast-2.0", XAI_VOICE_MODEL_TECH: "grok-voice-3.0" },
        { transferAvailable: false },
      ),
    );
    expect(r.optical.voiceModel).toBe("grok-voice-think-fast-2.0");
    expect(r.tech.voiceModel).toBe("grok-voice-3.0");
  });

  it("reports no model for a lane this build does not register", () => {
    const r = bySlug(laneRoster(source(["optical"]), {}, { transferAvailable: false }));
    expect(r.optical.voiceModel).toBe("grok-voice-3.0");
    expect(r.pcp.voiceModel).toBeNull();
  });
});

/**
 * Which xAI voice each lane would speak in (v113). Operator, 2026-10-22: "I
 * have never heard this agent, make sure it has a good voice, the main one
 * from xai that they use." The runtime's default is `eve`, the voice in every
 * one of xAI's own Voice Agent examples; `/voice/health` now says so per lane.
 */
describe("the voice each lane would speak in", () => {
  it("reports eve on every registered lane, the NPX outreach lane included, when nothing overrides it", () => {
    const r = bySlug(laneRoster(ALL, {}, { transferAvailable: false }));
    for (const row of Object.values(r)) expect(row.voiceName, row.slug).toBe("eve");
    expect(r["npx-outreach"]).toBeDefined();
  });

  it("follows XAI_VOICE_NAME, with a per-lane setting winning, exactly as a call does", () => {
    const r = bySlug(
      laneRoster(ALL, { XAI_VOICE_NAME: "ara", XAI_VOICE_NAME_NPX_OUTREACH: "eve" }, { transferAvailable: false }),
    );
    expect(r.tech.voiceName).toBe("ara");
    expect(r["npx-outreach"].voiceName).toBe("eve");
  });

  it("reports no voice for a lane this build does not register", () => {
    const r = bySlug(laneRoster(source(["optical"]), {}, { transferAvailable: false }));
    expect(r["npx-outreach"].voiceName).toBeNull();
  });
});

/**
 * Demo or live (v113): the one fact that decides whether NPX outreach rings a
 * patient, confirmed from `/voice/health` and the boot lines after a
 * republish, through the REAL registry so the policy's own switch is what is
 * read.
 */
describe("the mode an outbound campaign is dialling in", () => {
  it("reports demo for NPX outreach until NPX_OUTREACH_MODE is live, and null for every other lane", async () => {
    const real = await defaultLaneSource();
    const demo = bySlug(laneRoster(real, {}, { transferAvailable: true }));
    expect(demo["npx-outreach"].outboundMode).toBe("demo");
    for (const slug of ["optical", "pcp", "no-ivr"]) expect(demo[slug].outboundMode, slug).toBeNull();
    const live = bySlug(laneRoster(real, { NPX_OUTREACH_MODE: "live" }, { transferAvailable: true }));
    expect(live["npx-outreach"].outboundMode).toBe("live");
  });

  it("says it in the boot lines, so the deploy log answers it too", async () => {
    const real = await defaultLaneSource();
    expect(formatLaneRoster(laneRoster(real, {}, { transferAvailable: true }))).toContain(
      "[voice-runtime]   npx-outreach: demo — calls the test numbers only",
    );
    expect(formatLaneRoster(laneRoster(real, { NPX_OUTREACH_MODE: "live" }, { transferAvailable: true }))).toContain(
      "[voice-runtime]   npx-outreach: LIVE — calls real patients",
    );
  });

  it("reports no mode for a lane this build does not register", () => {
    expect(bySlug(laneRoster(source(["optical"]), {}, { transferAvailable: false }))["npx-outreach"].outboundMode).toBeNull();
  });
});
