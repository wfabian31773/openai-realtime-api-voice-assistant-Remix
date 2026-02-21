import {
  IntentType,
  WorkflowContext,
  ConversationSlots,
  SlotType,
  ESCALATION_KEYWORDS,
} from './workflowTypes';
import {
  WorkflowDefinition,
  getWorkflowForIntent,
  getMissingRequiredSlots,
  SLOT_DEFINITIONS,
} from './workflowDefinitions';
import { workflowEngine, type WorkflowDirective } from './workflowEngine';
import { URGENT_SYMPTOMS, getCurrentDateTimeContext } from '../config/knowledgeBase';
import { buildCompactLocationReference } from '../config/azulVisionKnowledge';
import { getNextBusinessDayContext } from '../utils/timeAware';
import type { PatientScheduleContext } from '../services/scheduleLookupService';
import type { CallerMemory } from '../services/callerMemoryService';

interface PromptContext {
  callId: string;
  callerPhone?: string;
  scheduleContext?: PatientScheduleContext;
  callerMemory?: CallerMemory | null;
  workflowContext: WorkflowContext;
  directive: WorkflowDirective;
}

export function buildWorkflowDrivenPrompt(promptContext: PromptContext): string {
  const { 
    callerPhone, 
    scheduleContext, 
    callerMemory, 
    workflowContext, 
    directive 
  } = promptContext;

  const sections: string[] = [];

  sections.push(buildRoleSection());
  sections.push(buildCurrentStateSection(workflowContext, directive));
  sections.push(buildDataCollectionSection(directive));
  sections.push(buildGuardrailsSection());
  sections.push(buildScheduleContextSection(scheduleContext));
  sections.push(buildCallerMemorySection(callerMemory));
  sections.push(buildPhoneContextSection(callerPhone));
  sections.push(buildTimeContextSection());
  sections.push(buildLocationReferenceSection());
  sections.push(buildStyleSection());

  return sections.filter(s => s.length > 0).join('\n\n');
}

function buildRoleSection(): string {
  return `You are the AFTER-HOURS AGENT for Azul Vision. VERSION: 2.0.0-workflow

Your job is to collect patient information and take action. You follow a structured workflow - not free-form conversation.`;
}

function buildCurrentStateSection(context: WorkflowContext, directive: WorkflowDirective): string {
  const intent = context.currentIntent 
    ? `DETECTED INTENT: ${formatIntentName(context.currentIntent)}` 
    : 'INTENT: Not yet identified';

  const state = `CURRENT STATE: ${context.currentState}`;
  const action = `NEXT ACTION: ${directive.action}`;

  let instructions = '';
  switch (directive.action) {
    case 'collect_slot':
      instructions = `
TASK: Collect the following information from the caller.
REQUIRED: ${directive.missingSlots?.map(s => formatSlotName(s)).join(', ')}
FOCUS ON: ${directive.slotToCollect ? formatSlotName(directive.slotToCollect) : 'any missing info'}

Ask naturally but stay focused. Get ONE piece of info at a time.`;
      break;

    case 'confirm_summary':
      instructions = `
TASK: Summarize what you've collected and proceed.
SUMMARY: ${directive.summary}

State the summary briefly: "I have [name], date of birth [DOB], callback [number], needing [reason]. I'll pass this along."
DO NOT ask "Is that correct?" - just state it and proceed.`;
      break;

    case 'execute':
      instructions = `
TASK: Execute the appropriate action.
ACTION: ${directive.workflow.completionAction}

Call the appropriate tool now:
- create_ticket: For non-urgent requests (appointments, refills, messages)
- answer_directly: For simple questions (hours, locations, fax)`;
      break;

    case 'escalate':
      instructions = `
TASK: Transfer to human on-call provider.
REASON: ${directive.escalationReason}

Say: "Based on what you're describing, I want to connect you with our on-call team right away."
Then call escalate_to_human with the collected information.`;
      break;

    case 'answer':
      instructions = `
TASK: Answer the question directly from your knowledge.
Use the location reference section below for hours, addresses, phone numbers.
After answering, ask "Is there anything else I can help you with?"`;
      break;

    case 'complete':
      instructions = `
TASK: The call is complete.
Thank the caller and end the conversation gracefully.`;
      break;
  }

  return `===== WORKFLOW STATE =====
${intent}
${state}
${action}
${instructions}`;
}

function buildDataCollectionSection(directive: WorkflowDirective): string {
  if (directive.action !== 'collect_slot') return '';

  const collectedSlots = Object.entries(directive.context.slots)
    .filter(([_, v]) => v && String(v).trim())
    .map(([k, v]) => `✓ ${formatSlotName(k as SlotType)}: ${v}`)
    .join('\n');

  const missingSlots = directive.missingSlots
    ?.map(s => `□ ${formatSlotName(s)}`)
    .join('\n') || '';

  return `===== DATA COLLECTION PROGRESS =====
COLLECTED:
${collectedSlots || '(none yet)'}

STILL NEEDED:
${missingSlots}

RULES:
- Ask for FULL NAME in one question (not first, then last)
- Accept DOB in any format (spoken or numeric)
- Use caller ID for callback unless they provide a different number
- ONE question at a time - don't overwhelm the caller`;
}

function buildGuardrailsSection(): string {
  return `===== ESCALATION GUARDRAILS =====
⚠️ MANDATORY ESCALATION (call escalate_to_human):
${ESCALATION_KEYWORDS.slice(0, 10).map(k => `• "${k}"`).join('\n')}

If caller mentions ANY of these symptoms, collect minimal info (name, callback) and escalate immediately.

❌ NEVER ESCALATE FOR:
• Appointment questions (confirm, schedule, reschedule, cancel)
• Medication refills or prescription questions
• Billing or insurance questions
• General office questions
• Patient frustration or "I want to speak to someone"

When caller says "I want to speak to a human" without urgent symptoms:
→ "I understand. I can help you right now and make sure your message gets to the right person."
→ Continue collecting info and create ticket`;
}

function buildScheduleContextSection(scheduleContext?: PatientScheduleContext): string {
  if (!scheduleContext?.patientFound) return '';

  const lastAppt = scheduleContext.pastAppointments[0];
  const upcomingCount = scheduleContext.upcomingAppointments.length;

  let section = `===== PATIENT SCHEDULE (LOADED) =====
Patient record found for this phone number.`;

  if (scheduleContext.patientName) {
    section += `\nNAME IN SYSTEM: ${scheduleContext.patientName}`;
  }
  if (lastAppt) {
    section += `\nLast visit: ${lastAppt.date} at ${lastAppt.location} with ${lastAppt.provider}`;
  }
  if (upcomingCount > 0) {
    section += `\nUpcoming: ${upcomingCount} appointment(s) scheduled`;
    const next = scheduleContext.upcomingAppointments[0];
    if (next) {
      section += ` - Next: ${next.date} at ${next.timeOfDay} with ${next.provider}`;
    }
  }
  if (scheduleContext.lastProviderSeen) {
    section += `\nLast provider: ${scheduleContext.lastProviderSeen}`;
  }
  if (scheduleContext.lastLocationSeen) {
    section += `\nLast location: ${scheduleContext.lastLocationSeen}`;
  }

  section += `\n\nFor appointment confirmations: You CAN answer directly using this data.
For new appointments: Auto-populate provider/location preferences from this data.`;

  return section;
}

function buildCallerMemorySection(callerMemory?: CallerMemory | null): string {
  if (!callerMemory) return '';

  let section = `===== CALLER HISTORY =====
This caller has called ${callerMemory.totalCalls} time(s) before.`;

  if (callerMemory.patientName) {
    section += `\nKnown as: ${callerMemory.patientName}`;
  }
  if (callerMemory.lastCallDate) {
    section += `\nLast call: ${callerMemory.lastCallDate}`;
  }
  if (callerMemory.preferredContactMethod) {
    section += `\nPreferred contact: ${callerMemory.preferredContactMethod}`;
  }
  if (callerMemory.openTickets?.length) {
    section += `\n⚠️ Has ${callerMemory.openTickets.length} open ticket(s): ${callerMemory.openTickets.join(', ')}`;
    section += `\nIf calling about same issue, acknowledge their pending request.`;
  }

  return section;
}

function buildPhoneContextSection(callerPhone?: string): string {
  if (!callerPhone) {
    return `===== CALLER PHONE =====
Caller ID not available. You must ask for their full 10-digit callback number.`;
  }

  const formatted = formatPhone(callerPhone);
  return `===== CALLER PHONE =====
CALLER PHONE: ${callerPhone} (formatted: ${formatted})
Use this as the callback number when creating tickets.
Only confirm the callback number ONCE - in the final summary.`;
}

function buildTimeContextSection(): string {
  const timeContext = getCurrentDateTimeContext();
  const nextBizDay = getNextBusinessDayContext();

  return `===== TIME CONTEXT =====
${timeContext}
Non-urgent callbacks will be made ${nextBizDay.contextPhrase}.`;
}

function buildLocationReferenceSection(): string {
  return `===== OFFICE LOCATIONS =====
${buildCompactLocationReference()}`;
}

function buildStyleSection(): string {
  return `===== COMMUNICATION STYLE =====
- Calm, warm, professional
- Brief responses (no filler words)
- ONE question at a time
- Match caller's language (default English)
- Never narrate your process ("Let me create a ticket...")
- Just DO actions silently, then state the RESULT
- Never provide medical advice
- Always ask "Anything else?" before ending`;
}

function formatIntentName(intent: IntentType): string {
  return intent.replace(/_/g, ' ').toUpperCase();
}

function formatSlotName(slot: SlotType | string): string {
  return slot.replace(/_/g, ' ');
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

export function getWorkflowDirectiveForContext(context: WorkflowContext): WorkflowDirective {
  return workflowEngine.getNextDirective(context);
}
