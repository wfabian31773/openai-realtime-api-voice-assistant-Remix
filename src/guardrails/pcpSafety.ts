import type { RealtimeOutputGuardrail } from '@openai/agents/realtime';

function patternGuardrail(name: string, policyHint: string, patterns: RegExp[]): RealtimeOutputGuardrail {
  return {
    name,
    policyHint,
    async execute({ agentOutput }) {
      const matched = patterns.find((pattern) => pattern.test(agentOutput));
      return matched
        ? { tripwireTriggered: true, outputInfo: { rule: name } }
        : { tripwireTriggered: false, outputInfo: {} };
    },
  };
}

export const pcpSafetyGuardrails: RealtimeOutputGuardrail[] = [
  patternGuardrail('No diagnosis', 'Do not diagnose or clinically interpret symptoms.', [
    /\b(this is|you have|it sounds like|this is probably|this is likely)\b.{0,80}\b(diabetes|hypertension|infection|stroke|cancer|disease|condition|disorder)\b/i,
    /\bmy (diagnosis|medical opinion|clinical assessment)\b/i,
  ]),
  patternGuardrail('No medication advice', 'Do not prescribe, recommend, or provide dosing instructions.', [
    /\b(you should|you need to|please)\s+(take|start|stop|increase|decrease|use)\b.{0,80}\b(mg|mcg|tablet|pill|dose|daily|metformin|insulin|antibiotic)\b/i,
    /\bi (recommend|prescribe|advise)\b.{0,50}\b(take|use|start|stop)\b/i,
  ]),
  patternGuardrail('No unverified record disclosure', 'Never disclose patient information before professional verification.', [
    /\bwithout (verifying|verification)\b.{0,80}\b(patient|appointment|record|visit)\b/i,
    /\bi can confirm\b.{0,100}\b(patient|appointment|visit|record)\b.{0,30}\bwithout verification\b/i,
  ]),
];
