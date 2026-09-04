/**
 * "Ensure the runtime has everything we needed on there" — as a question the
 * deployment answers about itself, rather than one answered by dialling.
 *
 * The case that matters most right now is pcp: it is transfer-capable, it is
 * the next lane being prepared, and it can pass every check here while still
 * having nowhere to dial.
 */
import { describe, it, expect } from "vitest";
import { laneRoster, formatLaneRoster, REPORTED_LANES } from "./laneRoster";
import type { LaneSource } from "./laneRegistry";

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
    expect(lines[0]).toContain("lanes this deployment can serve (5/8)");
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
