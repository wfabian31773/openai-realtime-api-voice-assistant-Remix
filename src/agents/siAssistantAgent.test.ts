/**
 * SI Assistant lane as the runtime resolves it. Synthetic ids only.
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgres://stub:stub@ci-stub.invalid:5432/stub";
});

import { resolveLane, RUNTIME_CALLBACK_TOOLS, RUNTIME_OUTBOUND_TOOLS, type LaneConfig } from "../runtime/laneRegistry";
import type { OutboundContact } from "../runtime/outbound/campaign";
import type { CallbackContext } from "../runtime/outbound/callback";
import { siAssistantGreeting, siAssistantPolicy, SI_ASSISTANT_TOOLS, SI_ASSISTANT_VOICEMAIL } from "./siAssistantAgent";
import { TAKE_MESSAGE_TOOL_NAME } from "../tools/siAssistantTools";

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
  callSid: "CA00000000000000000000000000000210",
  callId: "CA00000000000000000000000000000210",
  callerPhone: "+15555550111",
  dialedNumber: "+19092553213",
};

async function registry() {
  const { agentRegistry } = await import("../config/agents");
  return agentRegistry as unknown as { getAgentConfig(id: string): LaneConfig | undefined };
}

describe("the SI Assistant lane", () => {
  it("identifies as an AI assistant and never as a person", () => {
    const g = siAssistantGreeting(CONTACT);
    expect(g).toMatch(/SI Assistant/);
    expect(g).toMatch(/automated AI assistant/i);
    expect(g).not.toMatch(/I am a (person|human|staff)/i);
    expect(SI_ASSISTANT_VOICEMAIL).toMatch(/automated AI assistant/i);
    expect(siAssistantPolicy.callerIdEnv).toBe("SI_ASSISTANT_NUMBER");
    expect(siAssistantPolicy.enableEnv).toBe("OUTBOUND_CAMPAIGN_SI_ASSISTANT");
    expect(siAssistantPolicy.caps.perDay).toBe(1);
    expect(siAssistantPolicy.caps.perWeek).toBe(3);
    expect(siAssistantPolicy.tools).toEqual(SI_ASSISTANT_TOOLS);
    expect(SI_ASSISTANT_TOOLS).toContain(TAKE_MESSAGE_TOOL_NAME);
  });

  it("is registered as a runtime outbound lane", async () => {
    const lane = await resolveLane(
      "si-assistant",
      { ...META, outbound: { ...CONTACT, campaignKey: "si-assistant" } },
      { source: await registry(), env: {} },
    );
    expect(lane?.outbound?.campaignKey).toBe("si-assistant");
    const names = (lane!.agent.tools as Array<{ name?: string }>).map((t) => t.name);
    for (const tool of RUNTIME_OUTBOUND_TOOLS) expect(names).toContain(tool);
    expect(names).toContain(TAKE_MESSAGE_TOOL_NAME);
    expect(lane!.agent.instructions).toMatch(/take_si_assistant_message/);
    expect(lane!.agent.instructions).toMatch(/never pretend to be a person/i);
    expect(lane!.agent.instructions).toMatch(/## Role & Persona/);
    expect(lane!.agent.instructions).toMatch(/## Objective/);
    expect(lane!.agent.instructions).toMatch(/## Conversation Flow/);
    expect(lane!.agent.instructions).toMatch(/## Guardrails & Escalation/);
    expect(lane!.agent.instructions).toMatch(/## Voice & Communication Style/);
  });

  it("answers a returned call on the same number", async () => {
    const callback: CallbackContext = {
      campaignKey: "si-assistant",
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
      purpose: "we called about a request our support team is working on for them.",
    };
    const lane = await resolveLane("si-assistant", { ...META, callback }, { source: await registry(), env: {} });
    const names = (lane!.agent.tools as Array<{ name?: string }>).map((t) => t.name);
    for (const tool of RUNTIME_CALLBACK_TOOLS) expect(names).toContain(tool);
    expect(lane!.agent.instructions).toMatch(/Somebody has rung back/);
  });
});
