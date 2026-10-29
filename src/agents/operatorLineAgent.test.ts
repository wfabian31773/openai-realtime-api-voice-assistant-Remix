import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.DATABASE_URL ||= "postgres://stub:stub@ci-stub.invalid:5432/stub"; });
import { resolveLane, RUNTIME_OUTBOUND_TOOLS } from "../runtime/laneRegistry";
import { OPERATOR_SLUG } from "../plugin/operatorLine";
import { OPERATOR_GREETING, OPERATOR_INBOUND_GREETING, operatorInstructions } from "./operatorLineAgent";
import { OperatorInboundWebhook } from "../runtime/operatorInboundWebhook";
import { CallSessionRegistry } from "../runtime/sessionRegistry";
import { MemoryPluginStore } from "../plugin/store";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { siAssistantNumber } from "../plugin/siAssistantConstants";
import { siAssistantPolicy } from "./siAssistantAgent";

describe("Wayne operator runtime agent", () => {
  it("binds inbound mode with only request, opt-out and hangup tools and no patient or callback flow", async () => {
    const { agentRegistry } = await import("../config/agents");
    const service = new OperatorInboundWebhook({ env: {}, registry: new CallSessionRegistry(), store: () => new MemoryPluginStore(), outbound: async () => new FakeOutboundStore() });
    const lane = await resolveLane(OPERATOR_SLUG, { callId: "CA-inbound", callSid: "CA-inbound", callerPhone: "+15555550123", dialedNumber: "+15555550100",
      operatorInbound: { tools: service.tools("CA-inbound") } }, { source: agentRegistry, env: {} });
    expect(lane!.agent.toolNames).toEqual(["end_call", "queue_request_for_grok_bot", "opt_out_of_calls"]);
    expect(lane!.agent.instructions).toContain("There is no turn limit or scripted intake");
    expect(lane!.agent.instructions).toContain("Never ask for a date of birth, DOB");
    expect(lane!.agent.instructions).not.toMatch(/Business Facts|Caller script\/persona|identify_callback_caller|set_spoken_language/);
    expect(OPERATOR_INBOUND_GREETING).toContain("Grok Bot");
    expect(OPERATOR_INBOUND_GREETING).toContain("AI assistant");
    expect(OPERATOR_INBOUND_GREETING).toContain("call is recorded");
    expect(await lane!.agent.dispatch("lookup_patient", {})).toMatchObject({ ok: false });
    expect(await lane!.agent.dispatch("end_call", {})).toMatchObject({ ok: true });
  });

  it("pursues the conversational goal without patient tools, business facts or verification", async () => {
    const { agentRegistry } = await import("../config/agents");
    const operatorCall = { callKind: "operator" as const, phone: "+19094795435", purpose: "Arrange two consecutive bookings. Preserve flashes, but no vision loss.", initiated_by: "owner_request" as const, language: "es", maxDurationSec: 60 };
    const lane = await resolveLane(OPERATOR_SLUG, {
      callId: "CA-test", callSid: "CA-test", callerPhone: operatorCall.phone, dialedNumber: "+15555550100", operatorCall,
      outbound: { contactId: "contact", attemptId: "attempt", campaignId: "campaign", campaignKey: OPERATOR_SLUG, phone: operatorCall.phone, firstName: null, lastName: null, data: {} },
    }, { source: agentRegistry, env: {} });
    expect(lane).not.toBeNull();
    expect(lane!.agent.toolNames).toEqual(["set_spoken_language", ...RUNTIME_OUTBOUND_TOOLS]);
    expect(lane!.agent.instructions).toContain(operatorCall.purpose);
    expect(lane!.agent.instructions).toContain("Grok Bot");
    expect(lane!.agent.instructions).toContain("you are an AI assistant");
    expect(lane!.agent.instructions).toContain("Never ask for a date of birth, DOB");
    expect(lane!.agent.instructions).toContain("or any patient identifiers");
    expect(lane!.agent.instructions).not.toMatch(/confirm_si_assistant_identity|take_si_assistant_message|lookup_patient|Business Facts/);
    expect(lane!.voice.language).toBe("es");
    expect(lane!.voice.languageExplicit).toBe(true);
    expect(OPERATOR_GREETING).toContain("Wayne Fabian");
    expect(operatorInstructions(operatorCall)).toContain("end_call immediately");
  });

  it.each([
    ["+15555550123", "+15555550123", true],
    ["+15555550124", "+15555550123", false],
    ["+15555550123", undefined, false],
    ["", "", false],
    ["anonymous", "anonymous", false],
  ])("selects the trusted owner persona only for an E.164 match (%s, %s)", async (phone, owner, recognized) => {
    const { agentRegistry } = await import("../config/agents");
    const lane = await resolveLane(OPERATOR_SLUG, { callId: "CA-persona", callSid: "CA-persona", callerPhone: phone!, dialedNumber: "+15555550100",
      operatorInbound: { tools: [] }, operatorOwner: true }, { source: agentRegistry, env: { OPERATOR_OWNER_NUMBER: owner } });
    expect(lane!.agent.instructions).toContain(recognized ? "full owner persona" : "polite, helpful general persona");
    expect(lane!.agent.instructions).not.toContain(recognized ? "not recognized as the owner" : "full owner persona");
    expect(lane!.agent.instructions).not.toContain("read back a concise request summary");
  });

  it("keeps the SI Assistant caller ID and patient callback policy intact", () => {
    expect(siAssistantNumber({})).toBe("+19092553213");
    expect(siAssistantPolicy.callerIdEnv).toBe("SI_ASSISTANT_NUMBER");
    expect(siAssistantPolicy.caps).toMatchObject({ perDay: 1, perWeek: 3 });
    expect(siAssistantPolicy.window).toMatchObject({ startHour: 9, endHour: 20 });
    expect(siAssistantPolicy.tools).toContain("confirm_si_assistant_identity");
  });
});
