import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.DATABASE_URL ||= "postgres://stub:stub@ci-stub.invalid:5432/stub"; });
import { resolveLane, RUNTIME_OUTBOUND_TOOLS } from "../runtime/laneRegistry";
import { OPERATOR_SLUG } from "../plugin/operatorLine";
import { OPERATOR_GREETING, operatorInstructions } from "./operatorLineAgent";
import { siAssistantNumber } from "../plugin/siAssistantConstants";
import { siAssistantPolicy } from "./siAssistantAgent";

describe("Wayne operator runtime agent", () => {
  it("binds the caller script without patient tools, business facts or verification", async () => {
    const { agentRegistry } = await import("../config/agents");
    const operatorCall = { callKind: "operator" as const, phone: "+19094795435", purpose: "Synthetic test", callerScript: "I need two consecutive bookings. Flashes, but no vision loss.", language: "es", maxDurationSec: 60 };
    const lane = await resolveLane(OPERATOR_SLUG, {
      callId: "CA-test", callSid: "CA-test", callerPhone: operatorCall.phone, dialedNumber: "+15555550100", operatorCall,
      outbound: { contactId: "contact", attemptId: "attempt", campaignId: "campaign", campaignKey: OPERATOR_SLUG, phone: operatorCall.phone, firstName: null, lastName: null, data: {} },
    }, { source: agentRegistry, env: {} });
    expect(lane).not.toBeNull();
    expect(lane!.agent.toolNames).toEqual(["set_spoken_language", ...RUNTIME_OUTBOUND_TOOLS]);
    expect(lane!.agent.instructions).toContain(operatorCall.callerScript);
    expect(lane!.agent.instructions).toContain("on behalf of Wayne Fabian");
    expect(lane!.agent.instructions).toContain("disclose that you are an AI assistant");
    expect(lane!.agent.instructions).toContain("Never ask for a date of birth, DOB");
    expect(lane!.agent.instructions).toContain("or any patient identifiers");
    expect(lane!.agent.instructions).not.toMatch(/confirm_si_assistant_identity|take_si_assistant_message|lookup_patient|Business Facts/);
    expect(lane!.voice.language).toBe("es");
    expect(lane!.voice.languageExplicit).toBe(true);
    expect(OPERATOR_GREETING).toContain("Wayne Fabian");
    expect(operatorInstructions(operatorCall)).toContain("end_call immediately");
  });

  it("keeps the SI Assistant caller ID and patient callback policy intact", () => {
    expect(siAssistantNumber({})).toBe("+19092553213");
    expect(siAssistantPolicy.callerIdEnv).toBe("SI_ASSISTANT_NUMBER");
    expect(siAssistantPolicy.caps).toMatchObject({ perDay: 1, perWeek: 3 });
    expect(siAssistantPolicy.window).toMatchObject({ startHour: 9, endHour: 20 });
    expect(siAssistantPolicy.tools).toContain("confirm_si_assistant_identity");
  });
});
