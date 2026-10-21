/**
 * The outbound lanes as the runtime resolves them, through the REAL lane
 * registry and the REAL agent registry — a helper proven alone proves the
 * helper, not that a lane is wired (failure mode 10).
 */
import { describe, expect, it, vi } from "vitest";
// HOISTED above every import: laneRegistry imports the tool library
// statically, and its telemetry module validates DATABASE_URL at import, so a
// plain assignment here would run after the import graph had already thrown.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgres://stub:stub@ci-stub.invalid:5432/stub";
});

import {
  laneSupportStatus,
  resolveLane,
  RUNTIME_CALLBACK_TOOLS,
  RUNTIME_OUTBOUND_TOOLS,
  type LaneConfig,
} from "../laneRegistry";
import { OUTBOUND_RECORDING_CLAUSE, type OutboundContact } from "./campaign";
import { callbackGreeting, callbackSteps, withCallbackSteps, type CallbackContext } from "./callback";
import { callEnds } from "../callRecord";

const CONTACT: OutboundContact = {
  contactId: "c1",
  campaignId: "campaign-1",
  attemptId: "a1",
  phone: "+15555550111",
  firstName: "Testa",
  lastName: "Synthetic",
  data: {},
};

const META = {
  callSid: "CA00000000000000000000000000000001",
  callId: "CA00000000000000000000000000000001",
  callerPhone: "+15555550111",
  dialedNumber: "+15555550100",
};

async function registry() {
  const { agentRegistry } = await import("../../config/agents");
  return agentRegistry as unknown as {
    getAgentConfig(id: string): LaneConfig | undefined;
    getOutboundAgents(): Array<LaneConfig & { id: string }>;
  };
}

describe("every registered outbound lane", () => {
  it("has at least the proving lane", async () => {
    const r = await registry();
    expect(r.getOutboundAgents().map((a) => a.id)).toContain("outbound-proof");
  });

  it("opens with who is calling, that it is automated, and that the call is recorded", async () => {
    const r = await registry();
    for (const lane of r.getOutboundAgents().filter((a) => a.outbound)) {
      const g = lane.outbound!.greeting(CONTACT);
      expect(g, lane.id).toMatch(/Azul Vision/);
      expect(g, lane.id).toMatch(/automated/i);
      expect(g, lane.id).toContain(OUTBOUND_RECORDING_CLAUSE);
      // Disclosed BEFORE anything is asked: the clause precedes the first "?".
      expect(g.indexOf(OUTBOUND_RECORDING_CLAUSE), lane.id).toBeLessThan(g.indexOf("?"));
    }
  });

  it("leaves a voicemail that names the practice and nothing about the person", async () => {
    const r = await registry();
    for (const lane of r.getOutboundAgents().filter((a) => a.outbound)) {
      const vm = lane.outbound!.voicemail();
      expect(vm, lane.id).toMatch(/Azul Vision/);
      expect(vm, lane.id).not.toContain(CONTACT.firstName!);
      expect(vm, lane.id).not.toMatch(/appointment|exam|doctor|surgery|records/i);
    }
  });

  it("says why it called, for the person who rings back — and nothing private in it before they are identified", async () => {
    const r = await registry();
    for (const lane of r.getOutboundAgents().filter((a) => a.outbound)) {
      const why = lane.outbound!.callbackPurpose;
      expect(why, lane.id).toBeTruthy();
      expect(why!.trim().endsWith("."), lane.id).toBe(true);
      expect(why, lane.id).not.toContain(CONTACT.firstName!);
    }
  });

  it("is off unless its own switch says so", async () => {
    const r = await registry();
    for (const lane of r.getOutboundAgents().filter((a) => a.outbound)) {
      expect(lane.outbound!.enableEnv, lane.id).toMatch(/^OUTBOUND_CAMPAIGN_[A-Z0-9_]+$/);
    }
  });
});

describe("the runtime and outbound lanes", () => {
  it("serves an outbound lane that carries a policy, and still refuses one that does not", async () => {
    const r = await registry();
    expect(laneSupportStatus(r.getAgentConfig("outbound-proof")!)).toBeNull();
    expect(
      laneSupportStatus({ id: "x", enabled: true, agentType: "outbound", factory: () => undefined }),
    ).toMatch(/answers inbound calls/);
  });

  it("binds opt-out, outcome and hangup to a dialled call", async () => {
    const lane = await resolveLane(
      "outbound-proof",
      { ...META, outbound: { ...CONTACT, campaignKey: "outbound-proof" } },
      { source: await registry(), env: {} },
    );
    expect(lane?.outbound?.campaignKey).toBe("outbound-proof");
    const names = (lane!.agent.tools as Array<{ name?: string }>).map((t) => t.name);
    for (const tool of RUNTIME_OUTBOUND_TOOLS) expect(names).toContain(tool);
  });

  it("never binds them to an inbound lane", async () => {
    const lane = await resolveLane(
      "optical",
      { ...META, outbound: { ...CONTACT, campaignKey: "x" } },
      { source: await registry(), env: {} },
    );
    const names = (lane!.agent.tools as Array<{ name?: string }>).map((t) => t.name);
    for (const tool of RUNTIME_OUTBOUND_TOOLS) expect(names).not.toContain(tool);
    expect(lane!.outbound).toBeNull();
  });

  it("injects who the call is about rather than asking the model for it", async () => {
    const lane = await resolveLane(
      "outbound-proof",
      { ...META, outbound: { ...CONTACT, campaignKey: "outbound-proof" } },
      { source: await registry(), env: {} },
    );
    const optOut = (lane!.agent.tools as Array<{ name?: string; parameters?: { properties?: object } }>).find(
      (t) => t.name === "opt_out_of_calls",
    );
    expect(Object.keys(optOut?.parameters?.properties ?? {})).toEqual([]);
  });
});

describe("a returned call on an outbound lane (v106)", () => {
  const CALLBACK: CallbackContext = {
    campaignKey: "outbound-proof",
    campaignId: "campaign-1",
    callerPhone: "+15555550111",
    match: {
      kind: "one",
      contact: {
        contactId: "c1",
        campaignId: "campaign-1",
        phone: "+15555550111",
        firstName: "Testa",
        lastName: "Synthetic",
        status: "voicemail",
        data: {},
        lastAttemptAt: null,
        lastAttemptStatus: null,
      },
    },
    purpose: "it was a test.",
  };

  it("binds identify, opt-out, outcome and hangup, with only the call's own id injected", async () => {
    const lane = await resolveLane("outbound-proof", { ...META, callback: CALLBACK }, { source: await registry(), env: {} });
    const tools = lane!.agent.tools as Array<{ name?: string; parameters?: { properties?: object } }>;
    const names = tools.map((t) => t.name);
    for (const tool of RUNTIME_CALLBACK_TOOLS) expect(names).toContain(tool);
    // The model is asked for a name, never for who the call is about.
    const identify = tools.find((t) => t.name === "identify_callback_caller");
    expect(Object.keys(identify?.parameters?.properties ?? {}).sort()).toEqual(["date_of_birth", "first_name", "last_name"]);
  });

  it("gives the proving lane a prompt that does not assume who it dialled", async () => {
    const lane = await resolveLane("outbound-proof", { ...META, callback: CALLBACK }, { source: await registry(), env: {} });
    const prompt = withCallbackSteps(lane!.agent.instructions, callbackSteps(CALLBACK));
    expect(prompt).not.toContain("whether you are speaking with");
    expect(prompt).toContain("### Returned call");
    // The steps sit inside the Conversation Flow, before the lane's own steps.
    expect(prompt.indexOf("### Returned call")).toBeGreaterThan(prompt.indexOf("## Conversation Flow"));
    expect(prompt.indexOf("### Returned call")).toBeLessThan(prompt.indexOf("### Greeting"));
    expect(prompt.indexOf("## Guardrails & Escalation")).toBeGreaterThan(prompt.indexOf("### Close"));
  });

  it("opens by saying it is automated and recorded, before asking anything", () => {
    for (const match of [CALLBACK.match, { kind: "none" } as const]) {
      const g = callbackGreeting(match);
      expect(g).toMatch(/Azul Vision/);
      expect(g).toContain(OUTBOUND_RECORDING_CLAUSE);
      // A single match is greeted by name and asked nothing; anyone else is
      // asked who is calling, after the clause.
      const asks = g.indexOf("?");
      if (asks >= 0) expect(g.indexOf(OUTBOUND_RECORDING_CLAUSE)).toBeLessThan(asks);
    }
  });
});

describe("the call record of a dialled call", () => {
  it("is from our number to theirs, as Twilio writes it", () => {
    expect(callEnds({ callerPhone: "+15555550111", dialedNumber: "+15555550100", direction: "outbound" })).toEqual({
      direction: "outbound",
      from: "+15555550100",
      to: "+15555550111",
      dialedNumber: "+15555550111",
    });
    expect(callEnds({ callerPhone: "+15555550111", dialedNumber: "+15555550100" })).toEqual({
      direction: "inbound",
      from: "+15555550111",
      to: "+15555550100",
      dialedNumber: "+15555550100",
    });
  });
});
