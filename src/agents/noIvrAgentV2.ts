import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { medicalSafetyGuardrails } from "../guardrails/medicalSafety";
import {
  scheduleLookupService,
  PatientScheduleContext,
} from "../services/scheduleLookupService";
import {
  callerMemoryService,
  type CallerMemory,
} from "../services/callerMemoryService";
import { type TriageOutcome } from "../config/afterHoursTicketing";
import { storage } from "../../server/storage";
import { escalationDetailsMap } from "../services/escalationStore";
import {
  workflowEngine,
  type WorkflowContext,
  type IntentType,
  type SlotType,
  type ConversationSlots,
} from "../workflows";
import { buildWorkflowDrivenPrompt, getWorkflowDirectiveForContext } from "../workflows/workflowPromptBuilder";

export interface NoIvrAgentV2Metadata {
  callId: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string;
}

function parseDateOfBirth(dobString: string): {
  month?: string;
  day?: string;
  year?: string;
  raw: string;
} {
  const result: { month?: string; day?: string; year?: string; raw: string } = {
    raw: dobString,
  };

  const mmddyyyy = dobString.match(
    /(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{2,4})/,
  );
  if (mmddyyyy) {
    result.month = mmddyyyy[1].padStart(2, "0");
    result.day = mmddyyyy[2].padStart(2, "0");
    result.year = mmddyyyy[3].length === 2 ? `19${mmddyyyy[3]}` : mmddyyyy[3];
    return result;
  }

  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04",
    jun: "06", jul: "07", aug: "08", sep: "09",
    oct: "10", nov: "11", dec: "12",
  };

  const writtenDate = dobString
    .toLowerCase()
    .match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/);
  if (writtenDate) {
    result.month = months[writtenDate[1]] || writtenDate[1];
    result.day = writtenDate[2].padStart(2, "0");
    result.year = writtenDate[3];
    return result;
  }

  return result;
}

export async function createNoIvrAgentV2(
  handoffToHuman: () => Promise<void>,
  metadata: NoIvrAgentV2Metadata,
): Promise<RealtimeAgent> {
  const { callId, callerPhone } = metadata;

  let scheduleContext: PatientScheduleContext | undefined;
  if (callerPhone) {
    try {
      console.log(
        `[No-IVR V2] Auto-fetching schedule context for caller: ${callerPhone.slice(-4)}`,
      );
      scheduleContext = await scheduleLookupService.lookupByPhone(callerPhone);

      if (scheduleContext.patientFound) {
        console.log(`[No-IVR V2] Schedule context loaded:`, {
          upcomingCount: scheduleContext.upcomingAppointments.length,
          pastCount: scheduleContext.pastAppointments.length,
          lastLocationSeen: scheduleContext.lastLocationSeen,
          lastProviderSeen: scheduleContext.lastProviderSeen,
        });

        if (metadata.callLogId) {
          try {
            await storage.updateCallLog(metadata.callLogId, {
              patientFound: true,
              patientName: scheduleContext.patientName || undefined,
              lastProviderSeen: scheduleContext.lastProviderSeen || undefined,
              lastLocationSeen: scheduleContext.lastLocationSeen || undefined,
            });
            console.log(`[No-IVR V2] Updated call log ${metadata.callLogId} with patient context`);
          } catch (updateError) {
            console.error(`[No-IVR V2] Failed to update call log with patient context:`, updateError);
          }
        }
      } else {
        console.log("[No-IVR V2] No patient record found for caller phone");
      }
    } catch (error) {
      console.error("[No-IVR V2] Error fetching schedule context:", error);
    }
  }

  let callerMemory: CallerMemory | null = null;
  if (callerPhone) {
    try {
      callerMemory = await callerMemoryService.getCallerMemory(callerPhone);
      if (callerMemory) {
        console.log(`[No-IVR V2] ✓ Caller memory loaded:`, {
          totalCalls: callerMemory.totalCalls,
          lastCallDate: callerMemory.lastCallDate,
          patientName: callerMemory.patientName,
          openTickets: callerMemory.openTickets.length,
        });
      }
    } catch (error) {
      console.error("[No-IVR V2] Error fetching caller memory:", error);
    }
  }

  const workflowContext = workflowEngine.createContext(callId);
  if (scheduleContext) {
    workflowContext.scheduleContext = {
      patientFound: scheduleContext.patientFound,
      upcomingAppointments: scheduleContext.upcomingAppointments,
      pastAppointments: scheduleContext.pastAppointments,
      lastProviderSeen: scheduleContext.lastProviderSeen || undefined,
      lastLocationSeen: scheduleContext.lastLocationSeen || undefined,
    };
  }

  const directive = getWorkflowDirectiveForContext(workflowContext);

  const systemPrompt = buildWorkflowDrivenPrompt({
    callId,
    callerPhone,
    scheduleContext,
    callerMemory,
    workflowContext,
    directive,
  });

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`[No-IVR V2] WORKFLOW-DRIVEN AGENT JOINING CALL`);
  console.log(`[No-IVR V2] Version: 2.0.0-workflow`);
  console.log(`[No-IVR V2] CallId: ${callId}`);
  console.log(`[No-IVR V2] Initial State: ${workflowContext.currentState}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const classifyIntentTool = tool({
    name: "classify_intent",
    description: `Classify the caller's intent based on what they said.
Call this FIRST after hearing the caller's initial statement.
This determines which workflow to follow.

Returns the detected intent, required slots, and whether escalation is required.`,
    parameters: z.object({
      caller_statement: z.string().describe("What the caller said/requested"),
    }),
    execute: async (params) => {
      console.log("[No-IVR V2] classify_intent called:", params.caller_statement);
      
      const result = workflowEngine.classifyIntent(params.caller_statement);
      
      const updatedContext = workflowEngine.setIntent(workflowContext, result.intent);
      Object.assign(workflowContext, updatedContext);
      
      const newDirective = getWorkflowDirectiveForContext(workflowContext);
      
      console.log(`[No-IVR V2] ✓ Intent classified and workflow set:`, {
        intent: result.intent,
        confidence: result.confidence,
        requiresEscalation: result.requiresEscalation,
        matchedKeywords: result.matchedKeywords,
        newState: workflowContext.currentState,
        nextAction: newDirective.action,
        missingSlots: newDirective.missingSlots,
      });

      return {
        intent: result.intent,
        confidence: result.confidence,
        requires_escalation: result.requiresEscalation,
        escalation_reason: result.escalationReason,
        matched_keywords: result.matchedKeywords,
        workflow_state: workflowContext.currentState,
        next_action: newDirective.action,
        required_slots: newDirective.missingSlots || [],
        slot_prompt: newDirective.prompt,
      };
    },
  });

  const updateSlotTool = tool({
    name: "update_slot",
    description: `Store collected patient information.
Call this each time you collect a piece of information from the caller.
Valid slots: patient_first_name, patient_last_name, date_of_birth, callback_number, 
contact_preference, medication_name, pharmacy_name, doctor_name, location_preference, request_summary`,
    parameters: z.object({
      slot_name: z.enum([
        'patient_first_name',
        'patient_last_name', 
        'date_of_birth',
        'callback_number',
        'contact_preference',
        'medication_name',
        'pharmacy_name',
        'doctor_name',
        'location_preference',
        'request_summary',
        'caller_name',
        'provider_facility',
        'urgency_symptoms',
      ]).describe("Which piece of information is being stored"),
      value: z.string().describe("The value provided by the caller"),
    }),
    execute: async (params) => {
      console.log(`[No-IVR V2] update_slot: ${params.slot_name} = "${params.value}"`);
      
      const updated = workflowEngine.updateSlot(
        workflowContext, 
        params.slot_name as SlotType, 
        params.value
      );
      Object.assign(workflowContext, updated);

      const newDirective = getWorkflowDirectiveForContext(workflowContext);
      
      return {
        stored: true,
        slot: params.slot_name,
        value: params.value,
        next_action: newDirective.action,
        missing_slots: newDirective.missingSlots || [],
        ready_for_action: newDirective.action === 'execute' || newDirective.action === 'confirm_summary',
      };
    },
  });

  const lookupScheduleTool = tool({
    name: "lookup_schedule",
    description: `Look up patient appointment context using phone, name, or date of birth.

WHEN TO USE:
- Identity was corrected (caller said schedule name was wrong)
- Initial schedule context is missing (no patient found for caller phone)
- Caller asks about their appointments and context wasn't pre-loaded`,
    parameters: z.object({
      phone: z.string().optional().describe("Patient phone number"),
      first_name: z.string().optional().describe("Patient first name"),
      last_name: z.string().optional().describe("Patient last name"),
      date_of_birth: z.string().optional().describe("Patient date of birth"),
    }),
    execute: async (params) => {
      console.log("[No-IVR V2] lookup_schedule called:", params);

      try {
        let result: PatientScheduleContext;

        if (params.phone) {
          result = await scheduleLookupService.lookupByPhone(params.phone);
        } else if (params.first_name && params.last_name && params.date_of_birth) {
          result = await scheduleLookupService.lookupByNameAndDOB(
            params.first_name,
            params.last_name,
            params.date_of_birth,
          );
        } else {
          return {
            found: false,
            message: "Need phone number OR (first name + last name + DOB) to search",
          };
        }

        if (result.patientFound) {
          workflowContext.scheduleContext = {
            patientFound: true,
            upcomingAppointments: result.upcomingAppointments,
            pastAppointments: result.pastAppointments,
            lastProviderSeen: result.lastProviderSeen || undefined,
            lastLocationSeen: result.lastLocationSeen || undefined,
          };

          return {
            found: true,
            upcomingAppointments: result.upcomingAppointments,
            pastAppointments: result.pastAppointments.slice(0, 3),
            lastLocationSeen: result.lastLocationSeen,
            lastProviderSeen: result.lastProviderSeen,
            lastVisitDate: result.lastVisitDate,
          };
        }

        return { found: false };
      } catch (error) {
        console.error("[No-IVR V2] Schedule lookup error:", error);
        return { found: false, error: "lookup_failed" };
      }
    },
  });

  const checkOpenTicketsTool = tool({
    name: "check_open_tickets",
    description: `Check if this caller has any open/pending tickets from recent calls.
Call this BEFORE creating a new ticket to avoid duplicates.`,
    parameters: z.object({}),
    execute: async () => {
      console.log("[No-IVR V2] check_open_tickets called");

      if (!metadata.callerPhone) {
        return {
          checked: true,
          hasOpenTickets: false,
          message: "No caller phone available to check tickets",
        };
      }

      try {
        // Lazy import to avoid module initialization during agent bootstrap
        const { SyncAgentService } = await import("../services/syncAgentService");
        const openTickets = await SyncAgentService.checkOpenTickets(metadata.callerPhone);

        if (openTickets.length === 0) {
          return {
            checked: true,
            hasOpenTickets: false,
            openTickets: [],
          };
        }

        return {
          checked: true,
          hasOpenTickets: true,
          openTickets: openTickets.map((t) => ({
            ticketNumber: t.ticketNumber,
            reason: t.reason,
            daysAgo: t.daysAgo,
            createdWhen:
              t.daysAgo === 0
                ? "today"
                : t.daysAgo === 1
                  ? "yesterday"
                  : `${t.daysAgo} days ago`,
          })),
          message: `Caller has ${openTickets.length} open ticket(s). Consider acknowledging before creating new.`,
        };
      } catch (error) {
        console.error("[No-IVR V2] check_open_tickets error:", error);
        return { checked: false, error: "Failed to check open tickets" };
      }
    },
  });

  const logDecisionTool = tool({
    name: "log_decision",
    description: `Log an internal decision point for tracing and quality review.
Call this when you make key decisions about caller type, urgency, or escalation.`,
    parameters: z.object({
      decision_type: z.enum([
        "intent_classified",
        "urgency_assessed",
        "escalation_triggered",
        "ticket_created",
        "call_completed",
      ]).describe("Type of decision being logged"),
      value: z.string().describe("The decision value"),
      reason: z.string().optional().describe("Brief explanation"),
    }),
    execute: async (params) => {
      console.log(`[NO-IVR V2 DECISION] ${params.decision_type}:`, {
        value: params.value,
        reason: params.reason,
        callId: metadata.callId,
        currentIntent: workflowContext.currentIntent,
        currentState: workflowContext.currentState,
        timestamp: new Date().toISOString(),
      });
      return { logged: true };
    },
  });

  const createTicketTool = tool({
    name: "create_ticket",
    description: `Create a ticket in the ticketing system for non-urgent after-hours requests.
Call this ONLY when you have collected ALL required information.`,
    parameters: z.object({
      first_name: z.string().describe("Patient first name"),
      last_name: z.string().describe("Patient last name"),
      date_of_birth: z.string().describe("Full date of birth"),
      callback_number: z.string().describe("Callback phone number (10+ digits)"),
      request_category: z.enum([
        "new_appointment",
        "confirm_appointment",
        "appointment_request",
        "reschedule_appointment",
        "cancel_appointment",
        "medication_refill",
        "prescription_question",
        "billing_question",
        "insurance_question",
        "general_question",
        "message_for_provider",
        "test_results",
        "follow_up_care",
      ]).describe("Category of request"),
      request_summary: z.string().describe("Summary of what the patient needs"),
      preferred_contact: z.enum(["phone", "text", "email"]).optional(),
      doctor_name: z.string().optional(),
      location: z.string().optional(),
      requires_callback: z.boolean().optional().describe("Set to FALSE for simple confirmations"),
    }),
    execute: async (params) => {
      // Lazy import to avoid module initialization during agent bootstrap
      const { SyncAgentService } = await import("../services/syncAgentService");
      
      const requiresCallback = params.requires_callback !== undefined
        ? params.requires_callback
        : SyncAgentService.requiresCallback(params.request_category as TriageOutcome);

      console.log("[No-IVR V2] create_ticket called:", {
        name: `${params.first_name} ${params.last_name}`,
        category: params.request_category,
        requiresCallback,
      });

      const parsedDOB = parseDateOfBirth(params.date_of_birth);
      if (!parsedDOB.month || !parsedDOB.day || !parsedDOB.year) {
        return {
          success: false,
          validation_errors: ["complete date of birth (month, day, and year)"],
          message: "Missing required information: complete date of birth",
        };
      }

      let enrichedContext = scheduleContext;
      if (!scheduleContext?.patientFound || scheduleContext.matchedBy === "phone") {
        try {
          const dobForLookup = `${parsedDOB.year}-${parsedDOB.month}-${parsedDOB.day}`;
          const secondaryLookup = await scheduleLookupService.lookupByNameAndDOB(
            params.first_name,
            params.last_name,
            dobForLookup,
          );
          if (secondaryLookup.patientFound) {
            enrichedContext = secondaryLookup;
            console.log("[No-IVR V2] ✓ Secondary lookup found patient");
          }
        } catch (lookupError) {
          console.error("[No-IVR V2] Secondary lookup error:", lookupError);
        }
      }

      const finalSummary = requiresCallback
        ? params.request_summary
        : `[NO CALLBACK NEEDED] ${params.request_summary}`;

      const result = await SyncAgentService.createTicketFromAgentInput({
        firstName: params.first_name,
        lastName: params.last_name,
        birthMonth: parsedDOB.month,
        birthDay: parsedDOB.day,
        birthYear: parsedDOB.year,
        callbackNumber: params.callback_number,
        requestCategory: params.request_category as TriageOutcome,
        requestSummary: finalSummary,
        preferredContact: params.preferred_contact || undefined,
        doctorName: params.doctor_name || enrichedContext?.lastProviderSeen || undefined,
        location: params.location || enrichedContext?.lastLocationSeen || undefined,
        callData: {
          callSid: metadata.callSid,
          callerPhone: metadata.callerPhone,
          dialedNumber: metadata.dialedNumber,
          agentUsed: "no-ivr-v2",
        },
      });

      if (result.validationErrors && result.validationErrors.length > 0) {
        console.log("[No-IVR V2] VALIDATION FAILED:", result.validationErrors);
        return {
          success: false,
          validation_errors: result.validationErrors,
          message: `Missing required information: ${result.validationErrors.join(", ")}`,
        };
      }

      if (result.success) {
        console.log("[No-IVR V2] ✓ Ticket created:", result.ticketNumber);
        const completed = workflowEngine.markComplete(workflowContext);
        Object.assign(workflowContext, completed);
        return { success: true, ticket_number: result.ticketNumber };
      } else {
        console.error("[No-IVR V2] Ticket creation failed:", result.error);
        return { success: false, error: result.error || "ticket_creation_failed" };
      }
    },
  });

  const escalateToHumanTool = tool({
    name: "escalate_to_human",
    description: `Transfer the call to a human on-call provider.

⚠️ USE ONLY FOR:
1. TRUE MEDICAL EMERGENCIES: Vision loss, severe pain, eye injury, chemical exposure
2. HEALTHCARE PROVIDER CALLS: Doctors, nurses, hospitals calling about a patient
3. PATIENT CONFUSION: After 3+ failed attempts AND you cannot create a ticket

❌ NEVER ESCALATE FOR routine requests (appointments, refills, billing, etc.)`,
    parameters: z.object({
      reason: z.string().describe("Specific urgent symptoms or provider details"),
      caller_type: z.enum([
        "patient_urgent_medical",
        "healthcare_provider",
        "patient_unresponsive",
      ]),
      patient_first_name: z.string().optional(),
      patient_last_name: z.string().optional(),
      patient_dob: z.string().optional(),
      callback_number: z.string().optional(),
      symptoms_summary: z.string().optional(),
      provider_info: z.string().optional(),
    }),
    execute: async (params) => {
      console.log("[No-IVR V2] escalate_to_human called:", params);

      const escalationDetails = {
        reason: params.reason,
        callerType: params.caller_type,
        patientFirstName: params.patient_first_name,
        patientLastName: params.patient_last_name,
        patientDob: params.patient_dob,
        callbackNumber: params.callback_number,
        symptomsSummary: params.symptoms_summary,
        providerInfo: params.provider_info,
      };
      escalationDetailsMap.set(callId, escalationDetails);

      const escalated = workflowEngine.markEscalated(workflowContext, params.reason);
      Object.assign(workflowContext, escalated);

      await handoffToHuman();
      return { success: true, message: "Call transferred to on-call provider." };
    },
  });

  const agent = new RealtimeAgent({
    name: "No-IVR After-Hours Agent V2 (Workflow)",
    handoffDescription:
      "Workflow-driven after-hours agent with structured intent classification and guarded escalation.",
    instructions: systemPrompt,
    tools: [
      classifyIntentTool,
      updateSlotTool,
      lookupScheduleTool,
      checkOpenTicketsTool,
      logDecisionTool,
      createTicketTool,
      escalateToHumanTool,
    ],
  });

  agent.outputGuardrails = medicalSafetyGuardrails;

  console.log(`[No-IVR V2] ✓ Agent created with workflow tools:`, [
    "classify_intent",
    "update_slot",
    "lookup_schedule",
    "check_open_tickets",
    "log_decision",
    "create_ticket",
    "escalate_to_human",
  ]);

  return agent;
}

export const noIvrAgentV2Config = {
  slug: "no-ivr-v2",
  name: "No-IVR After-Hours Agent V2",
  description:
    "Workflow-driven agent with structured intent classification and guarded escalation routes.",
  version: "2.0.0",
  greeting: "Thank you for calling Azul Vision's after-hours line. How may I help you?",
  voice: "sage",
  language: "auto",
};
