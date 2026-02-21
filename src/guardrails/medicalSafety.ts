import type { RealtimeOutputGuardrail } from '@openai/agents/realtime';

// ANSI color codes
const BRIGHT_RED = '\x1b[91m';
const BRIGHT_YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

export const medicalSafetyGuardrails: RealtimeOutputGuardrail[] = [
  {
    name: 'No Medical Diagnoses',
    policyHint: 'Never diagnose medical conditions. Only gather information and triage urgency.',
    async execute({ agentOutput }) {
      const diagnosisPatterns = [
        // Match "you have [condition]" but NOT administrative phrases like:
        // "you have a pending request...cataract surgery" or "you have an open ticket...glaucoma"
        // Uses negative lookahead to exclude specific admin phrases (NOT single words like "open" which appears in "open-angle glaucoma")
        /\byou have\b(?!.{0,20}\b(pending request|open ticket|previous request|earlier request|existing ticket|previous ticket)\b).*\b(retinal|glaucoma|cataract|macular|infection|disease|condition)/i,
        /\bthis is (definitely|likely|probably)\b.*\b(retinal|glaucoma|infection|disease)/i,
        /\b(diagnosed|diagnosis) (with|of)\b/i,
        /\byour (condition|disease|problem) is\b/i,
        /\bit sounds like you have\b/i,
      ];
      
      for (const pattern of diagnosisPatterns) {
        if (pattern.test(agentOutput)) {
          console.log(`${BRIGHT_RED}⚠️  GUARDRAIL TRIGGERED: No Medical Diagnoses${RESET}`);
          console.log(`${BRIGHT_YELLOW}   └─ Pattern: ${pattern.source}${RESET}\n`);
          return {
            tripwireTriggered: true,
            outputInfo: { pattern: pattern.source, matched: agentOutput },
          };
        }
      }
      return { tripwireTriggered: false, outputInfo: {} };
    },
  },
  {
    name: 'No Prescribing Medications',
    policyHint: 'Never prescribe or recommend specific medications. Only note symptoms.',
    async execute({ agentOutput }) {
      // These patterns catch the AGENT prescribing or recommending medications
      // They should NOT trigger on:
      // - Patient requesting refills: "I need a refill of my medication"
      // - Agent acknowledging refills: "I can help with your medication refill"
      // - Agent asking about medications: "What medication do you need refilled?"
      const prescriptionPatterns = [
        // Agent telling patient to take specific medication
        /\b(you should|you need to|please) (take|use|apply|try)\s+\d+\s*(mg|drops|pills)/i,
        // Agent recommending specific medication by name
        /\bi (recommend|suggest|advise|prescribe) (that you|you)?\s*(take|use|try)\b/i,
        // Agent giving specific dosage instructions  
        /\btake\s+\d+\s*(mg|milligrams|drops|tablets|pills)\s+(of|daily|twice|every)/i,
        // Specific medication names being prescribed (not just mentioned)
        /\b(you should|start|begin) (taking|using)\s*(prednisolone|tobramycin|azithromycin|latanoprost|timolol)\b/i,
      ];
      
      for (const pattern of prescriptionPatterns) {
        if (pattern.test(agentOutput)) {
          console.log(`${BRIGHT_RED}⚠️  GUARDRAIL TRIGGERED: No Prescribing Medications${RESET}`);
          console.log(`${BRIGHT_YELLOW}   └─ Pattern: ${pattern.source}${RESET}\n`);
          return {
            tripwireTriggered: true,
            outputInfo: { pattern: pattern.source, matched: agentOutput },
          };
        }
      }
      return { tripwireTriggered: false, outputInfo: {} };
    },
  },
  {
    name: 'No Doctor Claims',
    policyHint: 'Never claim to be a doctor or medical professional. You are a triage assistant.',
    async execute({ agentOutput }) {
      const doctorPatterns = [
        /\bi am (a |an |the )?(doctor|physician|ophthalmologist|optometrist|medical professional|md)\b/i,
        /\bas (a |an |the |your )?(doctor|physician|ophthalmologist)\b/i,
        /\bmy medical (opinion|assessment|diagnosis)\b/i,
      ];
      
      for (const pattern of doctorPatterns) {
        if (pattern.test(agentOutput)) {
          console.log(`${BRIGHT_RED}⚠️  GUARDRAIL TRIGGERED: No Doctor Claims${RESET}`);
          console.log(`${BRIGHT_YELLOW}   └─ Pattern: ${pattern.source}${RESET}\n`);
          return {
            tripwireTriggered: true,
            outputInfo: { pattern: pattern.source, matched: agentOutput },
          };
        }
      }
      return { tripwireTriggered: false, outputInfo: {} };
    },
  },
  {
    name: 'No Treatment Instructions',
    policyHint: 'Never provide specific treatment instructions. Only collect information and triage.',
    async execute({ agentOutput }) {
      const treatmentPatterns = [
        /\byou should (apply|use|do)\b.*\b(compress|heat|ice|rinse)/i,
        /\btreat (this|it|the) (by|with)\b/i,
        /\bthe treatment (is|would be|should be)\b/i,
        /\bhere's (how|what) to treat\b/i,
      ];
      
      for (const pattern of treatmentPatterns) {
        if (pattern.test(agentOutput)) {
          console.log(`${BRIGHT_RED}⚠️  GUARDRAIL TRIGGERED: No Treatment Instructions${RESET}`);
          console.log(`${BRIGHT_YELLOW}   └─ Pattern: ${pattern.source}${RESET}\n`);
          return {
            tripwireTriggered: true,
            outputInfo: { pattern: pattern.source, matched: agentOutput },
          };
        }
      }
      return { tripwireTriggered: false, outputInfo: {} };
    },
  },
  {
    name: 'Professional Tone Only',
    policyHint: 'Maintain a professional, medical office tone. Avoid casual or unprofessional language.',
    async execute({ agentOutput }) {
      const unprofessionalPatterns = [
        /\b(dude|bro|hey man|sup|yeah buddy|awesome sauce)\b/i,
        /\blol\b|\blmao\b|\b(ha){3,}\b/i,
      ];
      
      for (const pattern of unprofessionalPatterns) {
        if (pattern.test(agentOutput)) {
          console.log(`${BRIGHT_RED}⚠️  GUARDRAIL TRIGGERED: Professional Tone Only${RESET}`);
          console.log(`${BRIGHT_YELLOW}   └─ Pattern: ${pattern.source}${RESET}\n`);
          return {
            tripwireTriggered: true,
            outputInfo: { pattern: pattern.source, matched: agentOutput },
          };
        }
      }
      return { tripwireTriggered: false, outputInfo: {} };
    },
  },
  {
    name: 'No Personal AI Information',
    policyHint: 'Never share personal details or claim to have personal experiences. You are an AI assistant.',
    async execute({ agentOutput }) {
      const personalInfoPatterns = [
        /\bmy (family|children|kids|spouse|wife|husband|parents)\b/i,
        /\bi (live|lived|grew up) in\b/i,
        /\bwhen i was (young|a child|growing up)\b/i,
        /\bmy (hobbies|interests) (are|include)\b/i,
      ];
      
      for (const pattern of personalInfoPatterns) {
        if (pattern.test(agentOutput)) {
          console.log(`${BRIGHT_RED}⚠️  GUARDRAIL TRIGGERED: No Personal AI Information${RESET}`);
          console.log(`${BRIGHT_YELLOW}   └─ Pattern: ${pattern.source}${RESET}\n`);
          return {
            tripwireTriggered: true,
            outputInfo: { pattern: pattern.source, matched: agentOutput },
          };
        }
      }
      return { tripwireTriggered: false, outputInfo: {} };
    },
  },
];
