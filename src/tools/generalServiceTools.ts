/**
 * The answering-service capabilities as REGISTRY tools, so any composed agent
 * can be assigned them by name — Wayne's architecture, 2026-08-30: build the
 * tools, then decide which each agent has access to.
 *
 * Nothing here is new behaviour. Each tool delegates to the exact function the
 * live answering-service agent calls inline — `scheduleLookupService`, the
 * `answeringServiceTicketing` detectors, the shared `createTicketTool` guard
 * that no-ivr already files through (surgery/optical/records hard-requires,
 * cross-queue routing, human-review fallback). The live agent file is
 * untouched: its inline tools keep carrying the line while these make the
 * same capabilities assignable. One implementation, two doors.
 */
import { z } from "zod";
import { registerTool, missing, type ToolResult } from "./registry";
import { createTicketTool } from "../agents/tools/createTicketTool";
import {
  ANSWERING_SERVICE_DEPARTMENTS,
  detectDepartment,
  detectPriority,
  detectRequestReason,
  detectRequestType,
  findLocationByName,
  findProviderByName,
  getDepartmentName,
  getLocationName,
  getProviderName,
  getRequestReasonName,
  getRequestTypeName,
} from "../config/answeringServiceTicketing";

registerTool({
  name: "lookup_schedule",
  description:
    "Look up a patient's appointment history and contact record by phone number, or by full " +
    "name plus date of birth. Returns upcoming and past appointments, the last provider seen, " +
    "the last location visited, and contact details. Use it to answer appointment questions " +
    "and to fill ticket fields. A phone match is a candidate to confirm, never an identity.",
  input_schema: {
    type: "object",
    properties: {
      phone: {
        type: "string",
        description: "The patient's phone number.",
        askAs: "What is the best phone number for the patient?",
      },
      first_name: { type: "string", description: "Patient first name." },
      last_name: { type: "string", description: "Patient last name." },
      date_of_birth: {
        type: "string",
        description: "Date of birth, any spoken format.",
        askAs: "What is the patient's date of birth — month, day, then year?",
      },
    },
  },
  layer: "agent",
  timeoutMs: 10_000,
  handler: async (input): Promise<ToolResult> => {
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    const first = typeof input.first_name === "string" ? input.first_name.trim() : "";
    const last = typeof input.last_name === "string" ? input.last_name.trim() : "";
    const dob = typeof input.date_of_birth === "string" ? input.date_of_birth.trim() : "";

    if (!phone && !(first && last && dob)) {
      return missing(
        ["phone", "first_name", "last_name", "date_of_birth"],
        "I need either the patient's phone number, or their full name and date of birth.",
      );
    }
    // Lazy, the same way createTicketTool loads SyncAgentService: the
    // schedule service opens the database at module load, and this module
    // must be importable (tests, the HTTP manifest, the agent registry)
    // without one.
    const { scheduleLookupService } = await import("../services/scheduleLookupService");
    const context =
      first && last && dob
        ? await scheduleLookupService.lookupByNameAndDOB(first, last, dob)
        : await scheduleLookupService.lookupByPhone(phone);
    return { ...context, success: true };
  },
});

registerTool({
  name: "classify_request",
  description:
    "Classify what the caller needs into the department, request type and request reason the " +
    "ticketing system uses. Call it with a detailed description BEFORE create_ticket, and use " +
    "the returned IDs.",
  input_schema: {
    type: "object",
    properties: {
      request_description: {
        type: "string",
        description: "What the caller needs, in detail, in their own words where possible.",
      },
    },
    required: ["request_description"],
  },
  layer: "agent",
  timeoutMs: 5_000,
  handler: async (input): Promise<ToolResult> => {
    const text = String(input.request_description ?? "");
    if (!text.trim()) {
      return missing(["request_description"], "Tell me what the caller needs first.");
    }
    // The same detectors the live answering-service calls inline.
    const department = detectDepartment(text);
    const departmentId =
      ANSWERING_SERVICE_DEPARTMENTS[
        department.toUpperCase() as keyof typeof ANSWERING_SERVICE_DEPARTMENTS
      ];
    const requestTypeId = detectRequestType(text, department);
    const requestReasonId = detectRequestReason(text, requestTypeId);
    const locationId = findLocationByName(text);
    const providerId = findProviderByName(text);
    return {
      success: true,
      department: getDepartmentName(department),
      departmentId,
      requestType: getRequestTypeName(requestTypeId),
      requestTypeId,
      requestReason: getRequestReasonName(requestReasonId),
      requestReasonId,
      priority: detectPriority(text),
      detectedLocation: locationId ? getLocationName(locationId) : null,
      locationId: locationId ?? null,
      detectedProvider: providerId ? getProviderName(providerId) : null,
      providerId: providerId ?? null,
    };
  },
});

/**
 * The shared tool, invoked exactly as the runtime's dispatch invokes every
 * SDK tool: `invoke(ctx, argsAsJsonString)` (agentBinding.ts). Same guard,
 * same entry point, no second door into it.
 */
async function runSharedCreateTicket(params: Record<string, unknown>): Promise<string> {
  const result = await createTicketTool.invoke({} as never, JSON.stringify(params));
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

const CREATE_TICKET_INPUT = z.object({
  departmentId: z.number(),
  requestTypeId: z.number(),
  requestReasonId: z.number(),
  patientFirstName: z.string().min(1),
  patientLastName: z.string().min(1),
  patientPhone: z.string().min(1),
  description: z.string().min(1),
});

registerTool({
  name: "create_ticket",
  description:
    "File the caller's request as a ticket. Confirm the callback number with the caller BEFORE " +
    "filing — correcting it afterwards means a second ticket and a patient who was told the " +
    "wrong thing. Surgery tickets require a surgeon, optical tickets a location, medical-records " +
    "tickets a date of birth; if the caller genuinely cannot provide one after being asked, pass " +
    "unresolvedInfo and the request routes to human review instead of being lost. Returns the " +
    "ticket number.",
  input_schema: {
    type: "object",
    properties: {
      departmentId: { type: "number", description: "From classify_request." },
      requestTypeId: { type: "number", description: "From classify_request." },
      requestReasonId: { type: "number", description: "From classify_request." },
      patientFirstName: { type: "string", description: "Patient first name." },
      patientLastName: { type: "string", description: "Patient last name." },
      patientPhone: {
        type: "string",
        description: "Confirmed callback number.",
        askAs: "Is the number ending in the last four digits I have the best one to reach you?",
      },
      patientEmail: { type: "string", description: "Patient email, when offered." },
      preferredContactMethod: {
        type: "string",
        enum: ["phone", "text", "email"],
        description: "How the patient prefers the follow-up.",
      },
      lastProviderSeen: {
        type: "string",
        description: "Doctor last seen. REQUIRED for surgery tickets.",
        askAs: "Which doctor is the patient scheduled with?",
      },
      locationOfLastVisit: {
        type: "string",
        description: "Office of the last visit. REQUIRED for optical tickets.",
        askAs: "Which office does the patient usually visit?",
      },
      patientBirthMonth: { type: "string", description: "Birth month, two digits." },
      patientBirthDay: { type: "string", description: "Birth day, two digits." },
      patientBirthYear: {
        type: "string",
        description: "Birth year, four digits. REQUIRED for medical-records tickets.",
      },
      locationId: { type: "number", description: "Location ID when known." },
      providerId: { type: "number", description: "Provider ID when known." },
      description: { type: "string", description: "The request, in detail." },
      priority: {
        type: "string",
        enum: ["low", "normal", "medium", "high", "urgent"],
        description: "Priority; defaults to medium.",
      },
      unresolvedInfo: {
        type: "string",
        description:
          "ONLY after asking: what required field the caller cannot provide, so the request " +
          "routes to human review instead of being lost.",
      },
    },
    required: [
      "departmentId",
      "requestTypeId",
      "requestReasonId",
      "patientFirstName",
      "patientLastName",
      "patientPhone",
      "description",
    ],
  },
  layer: "agent",
  timeoutMs: 20_000,
  handler: async (input): Promise<ToolResult> => {
    const parsed = CREATE_TICKET_INPUT.safeParse(input);
    if (!parsed.success) {
      return missing(
        parsed.error.issues.map((i) => i.path.join(".")),
        "I still need the classification IDs, the patient's name, a confirmed callback number, and what they need.",
      );
    }
    // The shared guard no-ivr files through: hard-requires, cross-queue
    // routing, review-queue fallback. Its answer is a ticket number or an
    // "ERROR: ..." sentence for the model.
    const result = await runSharedCreateTicket(input);
    if (typeof result === "string" && result.startsWith("ERROR:")) {
      return { success: false, error: result.slice("ERROR:".length).trim() };
    }
    return { success: true, ticketNumber: result };
  },
});
