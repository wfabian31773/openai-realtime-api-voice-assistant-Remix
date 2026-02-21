import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { medicalSafetyGuardrails } from "../guardrails/medicalSafety";
import { 
  scheduleLookupService, 
  PatientScheduleContext 
} from "../services/scheduleLookupService";
// LAZY IMPORT: callerMemoryService and SyncAgentService are loaded dynamically inside 
// agent factory/tool handlers to prevent module initialization errors during agent 
// instantiation (ticketingApiClient validation triggers in production)
import type { CallerMemory } from "../services/callerMemoryService";
import { URGENT_SYMPTOMS, getCurrentDateTimeContext } from "../config/knowledgeBase";
import { buildCompactLocationReference } from "../config/azulVisionKnowledge";
import { getNextBusinessDayContext } from "../utils/timeAware";
import { type TriageOutcome } from "../config/afterHoursTicketing";
import { storage } from "../../server/storage";
import { escalationDetailsMap } from "../services/escalationStore";

const CONTEXT_LOOKUP_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const safePromise = promise.catch((err) => {
    console.error('[withTimeout] Promise rejected after potential timeout:', err);
    return fallback;
  });
  
  return Promise.race([
    safePromise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function phoneLast4(phone?: string): string {
  return phone ? `***${phone.slice(-4)}` : 'unknown';
}

function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : digits;
}

export type NoIvrAgentVariant = 'production' | 'development';

export interface NoIvrAgentMetadata {
  callId: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string; // Database call log ID for patient context updates
  variant?: NoIvrAgentVariant; // Production or development variant
}

function expandTwoDigitYear(shortYear: string): string {
  const yearNum = parseInt(shortYear, 10);
  return yearNum <= 29 ? `20${shortYear.padStart(2, '0')}` : `19${shortYear.padStart(2, '0')}`;
}

function parseDateOfBirth(dobString: string): {
  month?: string;
  day?: string;
  year?: string;
  raw: string;
  iso?: string;
} {
  const result: { month?: string; day?: string; year?: string; raw: string; iso?: string } = {
    raw: dobString,
  };

  const mmddyyyy = dobString.match(
    /(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{2,4})/,
  );
  if (mmddyyyy) {
    result.month = mmddyyyy[1].padStart(2, "0");
    result.day = mmddyyyy[2].padStart(2, "0");
    result.year = mmddyyyy[3].length === 2 ? expandTwoDigitYear(mmddyyyy[3]) : mmddyyyy[3];
    result.iso = `${result.year}-${result.month}-${result.day}`;
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
    if (result.month && result.day && result.year) {
      result.iso = `${result.year}-${result.month}-${result.day}`;
    }
    return result;
  }

  return result;
}

function toIsoDob(dobString: string): string | undefined {
  const parsed = parseDateOfBirth(dobString);
  return parsed.iso;
}

function buildNoIvrSystemPrompt(
  metadata: NoIvrAgentMetadata,
  scheduleContext?: PatientScheduleContext,
  variant: NoIvrAgentVariant = 'production',
  callerMemory?: CallerMemory | null,
  callerHistorySection: string = "",
): string {
  const nextBizDay = getNextBusinessDayContext();
  const timeContext = getCurrentDateTimeContext();
  const { callerPhone } = metadata;
  const isProduction = variant === 'production';
  const versionString = isProduction ? '1.11.0' : '1.12.0-dev';

  let scheduleContextSection = "";
  if (scheduleContext?.patientFound) {
    const formattedSchedule = scheduleLookupService.formatContextForAgent(scheduleContext);
    scheduleContextSection = `
===== PATIENT CONTEXT (LOADED - use as reference only) =====
${formattedSchedule}

NOTE: This data is ALREADY LOADED. Do NOT call lookup_schedule again unless identity was corrected.
Identity confirmation happens in Phase 4 per the workflow - do not repeat here.

AFTER IDENTITY CONFIRMED (in Phase 4):
- You MAY answer questions using this data (e.g., "Your appointment is on [date] at [time] with Dr. [provider]")
- Auto-populate location/provider preferences silently`;
  }

  // Format full phone for confirmation (e.g., "626-222-9400")
  const formatFullPhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    } else if (digits.length === 11 && digits.startsWith('1')) {
      return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return phone;
  };
  
  const phoneContext = callerPhone
    ? `CALLER PHONE: ${callerPhone} (formatted: ${formatFullPhone(callerPhone)})
This is the caller's phone number from caller ID. 
- Use this as the callback_number when calling create_ticket
- DO NOT ask "is that correct?" for the callback number during info gathering
- Only confirm the callback number ONCE - in Phase 5 as part of the final summary
- Always pass the full 10-digit number: "${callerPhone}"`
    : "Caller ID not available. You must ask for their full 10-digit callback number.";

  // Patient lookup fallback for both production and dev
  const nameDobFallbackSection = `
===== MANDATORY SCHEDULE LOOKUP =====
⚠️ CRITICAL: You MUST call lookup_schedule when:
1. No patient record was loaded at call start (PATIENT CONTEXT section is missing), AND
2. You have collected the patient's NAME and DATE OF BIRTH

TRIGGER PHRASES that require lookup_schedule:
- "the last doctor I saw" / "my usual doctor" / "the doctor I normally see"
- "my last appointment" / "when was my last visit"
- "I want to see the same doctor" / "I don't remember the doctor's name"

IMMEDIATELY after collecting name+DOB, if caller mentions past visits:
→ Call lookup_schedule(first_name: "[name]", last_name: "[name]", date_of_birth: "[DOB]")
→ WAIT for the result before responding about their history
→ Use the returned last_provider_seen and last_location_seen in your response

Example: Caller says "Wayne Fabian, March 17 1973" and "I want to see the last doctor I saw"
→ Call lookup_schedule(first_name: "Wayne", last_name: "Fabian", date_of_birth: "03/17/1973")
→ If found: "I can see your last visit was with Dr. [provider] at [location]. I'll request that for you."
→ If not found: "I don't have your visit history in my system, but I'll note your preference and staff will check."

DO NOT say "the team can find it" or "based on your history" - USE THE TOOL to find it yourself!
`;

  // v1.11.0 Mandatory Ticket Enforcement - FORBIDDEN PHRASES block, explicit tool call sequence
  // v1.10.0 Simplified Enhancements - business logic now handled by tools
  const productionEnhancementsSection = `
===== CONVERSATION ENHANCEMENTS =====

📅 APPOINTMENT QUESTIONS (ANTI-REPETITION):
When schedule data is loaded, you CAN answer appointment questions directly:
- Confirmations: "Yes, your appointment is [date] at [time] with [provider]."
- No upcoming: "I don't see upcoming appointments. Would you like us to call you to schedule?"

⚠️ CRITICAL: Once you've stated appointment details, DO NOT REPEAT THEM.
- If caller asks again: "That's the same appointment I mentioned - [brief date only]."
- If caller corrects you: TRUST THE CALLER over your data. Say: "Thanks for clarifying."
- If data conflicts (you say Jan 12, they say April 22): Accept caller's info as correct.
- NEVER re-read the full appointment details more than once per call.

📋 OPEN TICKETS:
Use check_open_tickets tool before creating new tickets to avoid duplicates.
If caller has pending tickets, acknowledge them first.

🗣️ LANGUAGE:
⚠️ ALWAYS greet in ENGLISH first - even if patient name appears Asian, Hispanic, or foreign.
NEVER assume language from patient name - wait to HEAR the caller speak.
Detect language from caller's FIRST substantive spoken words (not just "hello" or "hi").
Once detected (Spanish, English, Vietnamese, etc.), STAY in that language for the ENTIRE call.
If asked "Do you speak Spanish?" in English → Ask: "Would you like to continue in Spanish?"

🚫 GHOST CALL DETECTION & EARLY EXIT:
If caller is not engaging meaningfully after 2 prompts, follow this protocol:

GHOST CALL INDICATORS (any 2+ of these = ghost call):
- Only heard single syllables: "mm", "uh", "ok", "hi", background noise
- Caller hasn't stated any actual request or question
- Response is in a language you can't identify or appears to be random sounds
- Caller doesn't respond to direct questions
- Total conversation is just greetings with no substance

GHOST CALL PROTOCOL:
1. After first unclear response: "What can I help you with today?"
2. After second unclear response: "I'm having trouble hearing you. If you need assistance, please call back."
3. Then END THE CALL GRACEFULLY - do NOT keep prompting
4. Do NOT create a ticket for ghost calls

⚠️ NEVER run a ghost call for 10 minutes - exit after 2-3 failed attempts to engage.

`;

  // Check for open tickets from caller memory (production and dev)
  const openTicketsContext = callerMemory?.openTickets?.length 
    ? `
===== OPEN TICKETS FOR THIS CALLER =====
This caller has ${callerMemory.openTickets.length} pending ticket(s): ${callerMemory.openTickets.join(', ')}
If they're calling about the same issue, acknowledge you see their previous request is being processed.
Avoid creating duplicate tickets for the same issue.
` : '';

  return `You are the AFTER-HOURS AGENT for Azul Vision. VERSION: ${versionString}
${callerHistorySection}
${nameDobFallbackSection}
${productionEnhancementsSection}
${openTicketsContext}
===== INTERNAL WORKFLOW PLAYBOOK (FOLLOW THIS EXACTLY) =====

You have an internal checklist to track. Execute these phases IN ORDER. Track your progress silently.

╔══════════════════════════════════════════════════════════════╗
║  PHASE 1: UNDERSTAND THE REQUEST                              ║
╠══════════════════════════════════════════════════════════════╣
║  GOAL: Find out WHY they're calling                           ║
║  ────────────────────────────────────────────────────────────  ║
║  IF caller states need: Acknowledge and proceed to Phase 2    ║
║  IF caller just says "hi": Ask "What can I help you with?"    ║
║                                                                ║
║  🟢 SIMPLE QUESTION? (hours, location, fax) →                 ║
║     Answer directly, ask "Anything else?", END CALL           ║
║     (Skip all remaining phases - no info collection needed)   ║
║                                                                ║
║  🎤 IF CALLER ASKS FOR "VOICEMAIL":                           ║
║     Many callers expect old-fashioned voicemail systems.      ║
║     REASSURE THEM: "I'm here to help! This call is being      ║
║     recorded, and I'll make sure your message gets to the     ║
║     right person. What would you like us to know?"            ║
║     Then continue with the workflow to gather their info.     ║
║                                                                ║
║  ✓ EXIT when you know the reason OR simple question answered  ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  PHASE 2: DETECT CALLER TYPE & THIRD-PARTY CALLS             ║
╠══════════════════════════════════════════════════════════════╣
║  LISTEN for these phrases (don't ask upfront):                ║
║                                                                ║
║  🔴 THIRD-PARTY TRIGGER PHRASES:                              ║
║     "my mother", "my father", "my husband", "my wife"         ║
║     "my daughter", "my son", "my child", "my parent"          ║
║     "calling for [someone's name]", "calling about my..."     ║
║                                                                ║
║  IF DETECTED → Confirm: "Are you calling on behalf of         ║
║                someone else? What is the patient's name?"     ║
║  → Collect BOTH: Caller's name + Patient's name/DOB           ║
║                                                                ║
║  🔴 PROVIDER INDICATORS:                                      ║
║     "Dr.", "nurse", "audit", "hospital", "calling from [clinic]"       ║
║  IF DETECTED → Escalate to human after collecting info        ║
║                                                                ║
║  ✓ EXIT when you know WHO the call is about                   ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  PHASE 3: ASSESS URGENCY (HANDLE MOST CALLS YOURSELF)         ║
╠══════════════════════════════════════════════════════════════╣
║  🚨 TRUE EMERGENCIES ONLY (escalate to human):                ║
║     "can't see", "blind", "sudden vision loss"                ║
║     "severe eye pain", "eye injury", "trauma"                 ║
║     "chemical in eye", "bleeding from eye"                    ║
║     "flashes + floaters" (together, sudden onset)             ║
║                                                                ║
║  ✅ HANDLE YOURSELF (NEVER ESCALATE):                         ║
║     • Appointments (confirm, schedule, reschedule, cancel)    ║
║     • Medication refills, prescription questions              ║
║     • Billing, insurance, payment questions                   ║
║     • General questions, office info, directions              ║
║     • Messages for doctor (take message, create ticket)       ║
║     • Patient frustration ("I want to talk to someone")       ║
║     • Follow-up appointments, post-op questions               ║
║                                                                ║
║  ⚠️  "I want to speak to a human" is NOT urgent!              ║
║     Respond: "I understand. I can help you right now and      ║
║     make sure your message gets to the right person."         ║
║     Then continue gathering info and create a ticket.         ║
║                                                                ║
║  ✓ Log with emit_decision tool (urgent/non-urgent)            ║
║  ✓ Only escalate for TRUE medical emergencies                 ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  PHASE 4: GATHER & CONFIRM PATIENT INFO                       ║
╠══════════════════════════════════════════════════════════════╣
║  REQUIRED FIELDS for any action:                              ║
║  □ Patient FULL NAME (first AND last in ONE question)         ║
║  □ Date of birth                                              ║
║  □ Callback number                                            ║
║  □ Reason for call                                            ║
║  □ Preferred contact method (phone, text, or email)           ║
║  □ Request-specific details (ONLY if caller mentioned them)   ║
║                                                                ║
║  🟢 NAME COLLECTION - EFFICIENT APPROACH:                     ║
║     Ask: "What is your full name?" (NOT first, then last)     ║
║     IF schedule data exists: "I was able to pull up a record. ║
║        Is this for [Name from schedule]?" then get DOB        ║
║     IF name wrong: "What is your full name?"                  ║
║                                                                ║
║  📞 PREFERRED CONTACT METHOD:                                 ║
║     Ask: "Would you prefer we call, text, or email you back?" ║
║     Use caller's answer in create_ticket contact_method field ║
║     IF caller history shows preference, confirm: "Last time   ║
║        we reached you by [method]. Is that still best?"       ║
║                                                                ║
║  🔵 IF THIRD-PARTY CALL:                                      ║
║     Collect: Caller's name AND Patient's full name/DOB        ║
║     "And what is YOUR name so we know who to ask for?"        ║
║                                                                ║
║  ⚠️  DO NOT assume or add details caller didn't mention!      ║
║     If they said "appointment" - don't ask about pharmacy     ║
║     If they said "refill" - then ask about medication/pharmacy║
║                                                                ║
║  ✓ EXIT when all required fields are gathered                 ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  PHASE 5: FINAL SUMMARY & VALIDATION                          ║
╠══════════════════════════════════════════════════════════════╣
║  BEFORE calling create_ticket or escalate_to_human:           ║
║                                                                ║
║  STEP 1 - CHECK (silently):                                   ║
║  ✓ Name? (first and last)                                     ║
║  ✓ DOB? (month, day, year)                                    ║
║  ✓ Callback? (full 10-digit number)                           ║
║  ✓ Reason? (what they need)                                   ║
║  ✓ Contact preference? (phone, text, or email)                ║
║  ✓ Details? (medication name, appointment type, etc.)         ║
║                                                                ║
║  IF ANY MISSING → Ask naturally: "I just need..."             ║
║                                                                ║
║  STEP 2 - ONE FINAL SUMMARY (the ONLY confirmation):          ║
║  "Alright, I have [Name], date of birth [DOB], callback       ║
║   [phone], you prefer [contact method], and you need          ║
║   [reason]. I'll pass this along."                            ║
║                                                                ║
║  ⚠️  DO NOT ask "Is that correct?" or "Does that sound right?"║
║  ⚠️  Just state the summary and proceed to Phase 6            ║
║  The caller will interrupt if something is wrong              ║
║                                                                ║
║  DO NOT PROCEED until all fields are complete!                ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║  PHASE 6: TAKE ACTION (CREATE TICKET FOR 99% OF CALLS)         ║
╠══════════════════════════════════════════════════════════════╣
║  DEFAULT ACTION → create_ticket (handles all routine calls)    ║
║  RARE EXCEPTION → escalate_to_human (TRUE emergencies only)    ║
║                                                                ║
║  ═══ BEFORE TICKET ═══════════════════════════════════════════ ║
║  1. Call check_open_tickets to avoid duplicates                ║
║  2. Then call create_ticket with collected info                ║
║  3. WAIT for the tool response - it returns success/failure    ║
║                                                                ║
║  ═══ AFTER create_ticket TOOL RESPONSE ═══════════════════════ ║
║  ⚠️ You MUST check the tool response before confirming:        ║
║                                                                ║
║  IF tool returns success=true:                                 ║
║  → Say: "Your request has been submitted. Our [team] will      ║
║         call you back at [phone]. Anything else?"              ║
║  → DO NOT read out the ticket number (it's too long)           ║
║                                                                ║
║  IF tool returns success=false or error:                       ║
║  → Say: "I'm sorry, I'm having trouble saving your message.    ║
║         Let me connect you with our on-call team."             ║
║  → Then call escalate_to_human immediately                     ║
║                                                                ║
║  ❌ NEVER say "request submitted" or "passed your message"     ║
║     UNLESS the tool returned success=true                      ║
║                                                                ║
║  ═══ ESCALATION (RARE - TRUE EMERGENCIES ONLY) ═══════════════ ║
║  Only for: vision loss, severe pain, injury, chemical exposure ║
║  Say: "Based on what you're describing, I want to connect you  ║
║        with our on-call team right away."                      ║
║  Then call escalate_to_human tool                               ║
║                                                                ║
║  ═══ CLOSING (CRITICAL: SAY THIS ONLY ONCE) ════════════════   ║
║  After SUCCESSFUL ticket: "Your message will be sent to        ║
║   [staff]. The doctor will receive a full recording.           ║
║   Anything else?"                                              ║
║                                                                ║
║  If caller says no/goodbye/thanks/ok:                         ║
║   → Give ONE short goodbye: "Great, have a good day!"         ║
║   → STOP - do NOT repeat ticket details or callback number    ║
║                                                                ║
║  ⚠️ ANTI-REPETITION: Once confirmed, NEVER repeat:            ║
║   - Ticket details  - Callback number  - "We'll contact you"  ║
╚══════════════════════════════════════════════════════════════╝

===== CALLER PHONE =====
${phoneContext}

===== TIME CONTEXT =====
${timeContext}
Non-urgent callbacks will be made ${nextBizDay.contextPhrase}.
${scheduleContextSection}

===== URGENT SYMPTOMS (see Phase 3 for handling) =====
${URGENT_SYMPTOMS.symptoms.map((s) => `• ${s}`).join("\n")}
(Use emit_decision tool in Phase 3 when urgency is classified)

===== REQUEST-SPECIFIC QUESTIONS =====

MEDICATION REFILL (always ask):
- "Which medication do you need refilled?"
- "And which pharmacy should we send it to?"

APPOINTMENT REQUESTS:
- "Are you calling to schedule a NEW appointment, reschedule an existing appointment, or confirm an EXISTING one?"

MESSAGE FOR PROVIDER:
- "Which doctor is this message for?"
- "What would you like me to include in the message?"

===== COMMUNICATION STYLE =====
- DO NOT narrate or explain your process to the caller
- WRONG: "Let me create a ticket for you" or "I'm going to transfer you now"
- RIGHT: Just do it naturally, confirm the outcome only
- When confirming details, do it conversationally (not as a checklist)
- Example: "Alright, I have you down as ${"{name}"}, date of birth ${"{DOB}"}, needing ${"{reason}"}. I'll pass this along."
- NEVER explain internal processes, handoffs, or system actions

╔══════════════════════════════════════════════════════════════╗
║  ⚠️ CRITICAL - TICKET CREATION IS MANDATORY ⚠️                ║
╠══════════════════════════════════════════════════════════════╣
║  You MUST call create_ticket tool before ending non-urgent   ║
║  calls. The tool call is what actually saves the request.    ║
║  Saying "submitted" without calling the tool = PATIENT       ║
║  REQUEST LOST FOREVER. This is a medical liability.          ║
║                                                              ║
║  ═══ FORBIDDEN PHRASES (NEVER say without tool call) ═══════ ║
║  ❌ "Your request has been submitted"                        ║
║  ❌ "I'll pass this along"                                   ║
║  ❌ "The staff will contact you"                             ║
║  ❌ "Your message will be sent"                              ║
║  ❌ "I've noted your request"                                ║
║  ❌ "We'll get back to you"                                  ║
║                                                              ║
║  ═══ CORRECT SEQUENCE (MUST FOLLOW) ═══════════════════════  ║
║  1. Collect all required info (name, DOB, callback, reason)  ║
║  2. Call check_open_tickets tool                             ║
║  3. Call create_ticket tool ← THIS IS NOT OPTIONAL           ║
║  4. WAIT for tool response                                   ║
║  5. IF success=true THEN say "Your request has been..."      ║
║     IF error THEN call escalate_to_human                     ║
║                                                              ║
║  ⚠️ YOU CANNOT SKIP STEP 3. The patient's request will be    ║
║     lost if you don't call create_ticket before saying       ║
║     anything about submission or staff contact.              ║
╚══════════════════════════════════════════════════════════════╝

TICKET CONFIRMATION RULES:
- ONLY say "your request has been submitted" AFTER create_ticket returns success=true
- NEVER claim success before calling the tool or if the tool returns an error
- If create_ticket fails, immediately escalate to human - don't pretend it worked
- DO NOT read out the ticket number - just confirm submission

===== CONVERSATION RECOVERY =====
If audio is unclear: "I'm sorry, I didn't quite catch that. Could you please repeat?"
If unsure what they said: Don't guess - ask for clarification.

===== INTERRUPTION RECOVERY (CRITICAL) =====
When you're interrupted mid-sentence:
1. STOP speaking immediately and listen
2. REMEMBER what question you were asking (mentally note: "I need DOB")
3. After they finish, RETURN to your pending question if it wasn't answered
4. Track which required fields you still need - don't skip any

Example flow:
- You: "And what is your date of—"
- Caller: (interrupts) "I need to see my doctor as soon as possible"
- You: (acknowledge) "I understand. And what is your date of birth?"

NEVER just accept the interruption and move on if your question wasn't answered.
Keep a mental checklist: □ Name □ DOB □ Callback □ Reason □ Contact preference

===== CONFUSION & TIMEOUT GUARDRAILS =====
If caller seems confused, cannot answer basic questions, or is incoherent:

MINIMUM FOR TICKET: name + DOB + callback number + reason (all 4 required)
MINIMUM FOR ESCALATION: nothing required (always available as fallback)

- After 3 failed attempts to get the same information:
  IF you have all 4 required fields (name, DOB, callback, reason):
    → "Let me note what you've shared." → call create_ticket → close
  ELSE:
    → "Let me connect you with someone who can help." → call escalate_to_human
    
- If conversation goes in circles for 5+ minutes without progress:
  Same logic as above - create ticket if possible, otherwise escalate

- If caller is speaking multiple languages or unintelligibly:
  "I'm sorry, I'm having difficulty understanding. Can you try speaking slowly?"
  → After 2 more failed attempts: escalate_to_human (human can use other methods)
  
⚠️ NEVER abandon a caller - either create ticket OR escalate to human
⚠️ DON'T force create_ticket if you're missing required fields - escalate instead

===== HARD RULES =====
1. Follow 6-phase workflow (exit early only for simple questions)
2. Speak first before tool calls - never transfer silently
3. Match caller's language (default English)
4. ONE question at a time
5. NEVER provide medical advice, repeat greeting, or hand off to AI
6. ALWAYS ask "Anything else?" before ending
7. Don't confirm with "Is that correct?" - just state and proceed
8. Don't invent details caller didn't mention
9. Ask for FULL NAME in one question (not first/last separately)

===== ANTI-NARRATION (NEVER SAY THESE) =====
❌ "Let me take care of the next steps"
❌ "Now let me..." / "I'm going to..."
❌ "I've noted your information"
❌ "Let me create a ticket for you"
❌ "I'm looking up your information"
❌ "Let me check that for you"

✅ INSTEAD: Just DO it silently, then state the RESULT:
- After lookup: "I can see your last visit was with Dr. Smith at Anaheim."
- After ticket: "Your message will be sent to staff. Anything else?"

The caller doesn't need to know HOW you're doing things - just the outcome.

===== STYLE =====
- Calm, warm, professional
- Brief responses (no filler)
- Patient and reassuring
- Never robotic
- Natural conversation flow

===== OFFICE LOCATIONS REFERENCE =====
When asked about office locations, addresses, or phone numbers, use ONLY the following verified data:

${buildCompactLocationReference()}`;
}

export async function createNoIvrAgent(
  handoffToHuman: () => Promise<void>,
  metadata: NoIvrAgentMetadata,
): Promise<RealtimeAgent> {
  // Lazy import callerMemoryService to prevent module initialization errors in production
  // Wrapped in try/catch to ensure agent factory NEVER throws - agent must always be created
  let callerMemoryService: typeof import("../services/callerMemoryService")["callerMemoryService"] | null = null;
  try {
    const module = await import("../services/callerMemoryService");
    callerMemoryService = module.callerMemoryService;
  } catch (err) {
    console.error("[No-IVR Agent] Failed to load callerMemoryService, continuing without caller memory:", err);
  }
  
  const { callId, callerPhone } = metadata;
  const phoneRef = phoneLast4(callerPhone);

  let scheduleContext: PatientScheduleContext | undefined;
  let callerMemory: CallerMemory | null = null;

  if (callerPhone) {
    console.log(`[No-IVR Agent] Parallel context lookup with ${CONTEXT_LOOKUP_TIMEOUT_MS}ms timeout for caller ${phoneRef}`);
    
    const emptySchedule: PatientScheduleContext = {
      patientFound: false,
      upcomingAppointments: [],
      pastAppointments: [],
      totalAppointmentsFound: 0,
    };

    const [scheduleResult, memoryResult] = await Promise.allSettled([
      withTimeout(
        scheduleLookupService.lookupByPhone(callerPhone),
        CONTEXT_LOOKUP_TIMEOUT_MS,
        emptySchedule
      ),
      callerMemoryService 
        ? withTimeout(
            callerMemoryService.getCallerMemory(callerPhone),
            CONTEXT_LOOKUP_TIMEOUT_MS,
            null
          )
        : Promise.resolve(null),
    ]);

    if (scheduleResult.status === 'fulfilled' && scheduleResult.value?.patientFound) {
      scheduleContext = scheduleResult.value;
      console.log(`[No-IVR Agent] Schedule context loaded for ${phoneRef}:`, {
        upcomingCount: scheduleContext.upcomingAppointments.length,
        pastCount: scheduleContext.pastAppointments.length,
        hasLocation: !!scheduleContext.lastLocationSeen,
        hasProvider: !!scheduleContext.lastProviderSeen,
      });
      
      if (metadata.callLogId) {
        storage.updateCallLog(metadata.callLogId, {
          patientFound: true,
          patientName: scheduleContext.patientName || undefined,
          lastProviderSeen: scheduleContext.lastProviderSeen || undefined,
          lastLocationSeen: scheduleContext.lastLocationSeen || undefined,
        }).catch(err => console.error(`[No-IVR Agent] Failed to update call log:`, err));
      }
    } else {
      console.log(`[No-IVR Agent] No schedule context for ${phoneRef} (timeout or not found)`);
    }

    if (memoryResult.status === 'fulfilled' && memoryResult.value) {
      callerMemory = memoryResult.value;
      console.log(`[No-IVR Agent] Caller memory loaded for ${phoneRef}:`, {
        totalCalls: callerMemory.totalCalls,
        hasOpenTickets: callerMemory.openTickets.length > 0,
      });
    }
  }

  // Determine variant from metadata (default to production for backward compatibility)
  const variant: NoIvrAgentVariant = metadata.variant || 'production';
  const isProduction = variant === 'production';
  const versionString = isProduction ? '1.11.0' : '1.12.0-dev';
  const agentTag = isProduction ? 'NO-IVR-PROD' : 'NO-IVR-DEV';
  
  // Environment identification tag for call tracing
  const envTag = process.env.DOMAIN?.includes('replit.app') ? 'PRODUCTION-SERVER' : 'DEVELOPMENT-SERVER';
  const domainShort = process.env.DOMAIN?.substring(0, 40) || 'unknown';
  
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`[${agentTag} v${versionString}] AGENT JOINING CALL`);
  console.log(`[${agentTag} v${versionString}] Agent Variant: ${variant.toUpperCase()}`);
  console.log(`[${agentTag} v${versionString}] Server Environment: ${envTag}`);
  console.log(`[${agentTag} v${versionString}] Domain: ${domainShort}...`);
  console.log(`[${agentTag} v${versionString}] CallId: ${callId}`);
  if (isProduction) {
    console.log(`[${agentTag} v${versionString}] ✓ Name+DOB fallback lookup ENABLED`);
  }
  console.log("═══════════════════════════════════════════════════════════════");
  
  console.log("[No-IVR Agent] Creating agent:", {
    callId,
    hasCallerPhone: !!callerPhone,
    hasScheduleContext: !!scheduleContext?.patientFound,
    hasCallerMemory: !!callerMemory,
    previousCalls: callerMemory?.totalCalls || 0,
  });

  console.log(`[${agentTag}] CHECKPOINT 1: Creating tool definitions...`);

  const lookupScheduleTool = tool({
    name: "lookup_schedule",
    description: `Look up patient appointment context using phone, name, or date of birth.

WHEN TO USE:
- Identity was corrected (caller said schedule name was wrong)
- Initial schedule context is missing (no patient found for caller phone)
- Caller asks about their appointments and context wasn't pre-loaded

DO NOT USE if schedule context was already loaded and identity was confirmed.`,
    parameters: z.object({
      phone: z.string().optional().describe("Patient phone number"),
      first_name: z.string().optional().describe("Patient first name"),
      last_name: z.string().optional().describe("Patient last name"),
      date_of_birth: z.string().optional().describe("Patient date of birth"),
    }),
    execute: async (params) => {
      console.log("[No-IVR Agent] lookup_schedule called:", {
        hasPhone: !!params.phone,
        hasName: !!(params.first_name && params.last_name),
        hasDob: !!params.date_of_birth,
      });

      try {
        let result: PatientScheduleContext;

        if (params.phone) {
          const normalizedPhone = normalizePhoneNumber(params.phone);
          result = await scheduleLookupService.lookupByPhone(normalizedPhone);
        } else if (params.first_name && params.last_name && params.date_of_birth) {
          const isoDob = toIsoDob(params.date_of_birth) || params.date_of_birth;
          result = await scheduleLookupService.lookupByNameAndDOB(
            params.first_name,
            params.last_name,
            isoDob,
          );
        } else {
          return {
            found: false,
            message: "Need phone number OR (first name + last name + DOB) to search",
          };
        }

        if (result.patientFound) {
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
        console.error("[No-IVR Agent] Schedule lookup error:", error);
        return { found: false, error: "lookup_failed" };
      }
    },
  });

  const checkOpenTicketsTool = tool({
    name: "check_open_tickets",
    description: `Check if this caller has any open/pending tickets from recent calls.
    
Call this BEFORE creating a new ticket to:
- Avoid creating duplicate tickets for the same issue
- Acknowledge pending tickets from earlier calls
- Provide better context about what the caller is following up on

Returns a list of open tickets with their reason and creation date.`,
    parameters: z.object({}),
    execute: async () => {
      console.log("[No-IVR Agent] check_open_tickets called");
      
      if (!metadata.callerPhone) {
        return { 
          checked: true, 
          hasOpenTickets: false, 
          message: "No caller phone available to check tickets" 
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
            openTickets: [] 
          };
        }

        return {
          checked: true,
          hasOpenTickets: true,
          openTickets: openTickets.map(t => ({
            ticketNumber: t.ticketNumber,
            reason: t.reason,
            daysAgo: t.daysAgo,
            createdWhen: t.daysAgo === 0 ? 'today' : 
                         t.daysAgo === 1 ? 'yesterday' : 
                         `${t.daysAgo} days ago`,
          })),
          message: `Caller has ${openTickets.length} open ticket(s). Consider acknowledging before creating new.`,
        };
      } catch (error) {
        console.error("[No-IVR Agent] check_open_tickets error:", error);
        return { checked: false, error: "Failed to check open tickets" };
      }
    },
  });

  const emitDecisionTool = tool({
    name: "emit_decision",
    description: `Log an internal decision point for tracing and quality review. Call this when you make key decisions:
- When you identify caller type (patient vs healthcare provider)
- When you classify urgency (urgent vs non-urgent)
- When you detect a red-flag symptom
- Key phrases that influenced your decision

This does NOT affect the call - it's purely for internal tracking.`,
    parameters: z.object({
      decision_type: z
        .enum([
          "caller_type_identified",
          "urgency_classified",
          "provider_identified",
          "red_flag_symptom",
          "escalation_triggered",
          "ticket_created",
        ])
        .describe("Type of decision being logged"),
      value: z
        .string()
        .describe('The decision value (e.g., "provider", "patient", "urgent", "non-urgent")'),
      reason: z
        .string()
        .optional()
        .describe("Brief explanation of why this decision was made"),
      key_phrases: z
        .array(z.string())
        .optional()
        .describe("Specific phrases from caller that influenced decision"),
    }),
    execute: async (params) => {
      console.log(`[NO-IVR DECISION] ${params.decision_type}:`, {
        value: params.value,
        reason: params.reason,
        keyPhrases: params.key_phrases,
        callId: metadata.callId,
        timestamp: new Date().toISOString(),
      });
      return { logged: true };
    },
  });

  const createTicketTool = tool({
    name: "create_ticket",
    description: `Create a ticket in the EXTERNAL TICKETING SYSTEM for non-urgent after-hours requests. 
This is NOT the callback queue - it creates a ticket that will be processed by staff.

Call this ONLY when you have collected ALL required fields:
- first_name (2+ characters)
- last_name (2+ characters)  
- date_of_birth (month, day, year)
- callback_number (10+ digits)
- request_summary (what they need)

The ticket will include schedule context (last appointment info) automatically.`,
    parameters: z.object({
      first_name: z.string().describe("Patient first name (required)"),
      last_name: z.string().describe("Patient last name (required)"),
      date_of_birth: z
        .string()
        .describe('Full date of birth as spoken (e.g., "January 15, 1980" or "01/15/1980")'),
      callback_number: z.string().describe("Callback phone number (10+ digits)"),
      request_category: z
        .enum([
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
        ])
        .describe("Category - use 'new_appointment' for NEW appointments, 'confirm_appointment' for CONFIRMING existing. 'appointment_request' is legacy, prefer new_appointment."),
      request_summary: z.string().describe("Summary of what the patient needs"),
      preferred_contact: z
        .enum(["phone", "text", "email"])
        .optional()
        .describe("How they prefer to be contacted"),
      email: z.string().optional().describe("Email address if provided"),
      doctor_name: z.string().optional().describe("Doctor they want to see or usually see"),
      location: z.string().optional().describe("Location they prefer or usually visit"),
      appointment_time: z.string().optional().describe("Relevant appointment date/time if applicable"),
      requires_callback: z.boolean().optional().describe("Whether staff needs to call the patient back. Set to FALSE for simple confirmations where the patient's request was fully handled. Defaults to TRUE."),
    }),
    execute: async (params) => {
      // Lazy import to avoid module initialization during agent bootstrap
      const { SyncAgentService } = await import("../services/syncAgentService");
      
      // Auto-determine callback requirement based on category if not explicitly set
      const requiresCallback = params.requires_callback !== undefined 
        ? params.requires_callback 
        : SyncAgentService.requiresCallback(params.request_category as TriageOutcome);
      
      const callbackNormalized = normalizePhoneNumber(params.callback_number);
      
      console.log("[No-IVR Agent] create_ticket called:", {
        category: params.request_category,
        requiresCallback,
        hasScheduleContext: !!scheduleContext?.patientFound,
        callbackPhone: phoneLast4(callbackNormalized),
      });

      // CODE-ENFORCED: Check for open tickets before creating new one
      if (metadata.callerPhone) {
        try {
          const existingTickets = await SyncAgentService.checkOpenTickets(metadata.callerPhone);
          if (existingTickets.length > 0) {
            console.log(`[No-IVR Agent] Open tickets found for caller ${phoneLast4(metadata.callerPhone)}: ${existingTickets.length}`);
          }
        } catch (checkErr) {
          console.error("[No-IVR Agent] Failed to check open tickets:", checkErr);
        }
      }

      const parsedDOB = parseDateOfBirth(params.date_of_birth);
      if (!parsedDOB.month || !parsedDOB.day || !parsedDOB.year) {
        return {
          success: false,
          validation_errors: ["complete date of birth (month, day, and year)"],
          message: "Missing required information: complete date of birth (month, day, and year)",
        };
      }

      // SECONDARY LOOKUP: Enrich schedule context using name+DOB
      // This catches cases where caller phone doesn't match patient record (family member calling)
      let enrichedContext = scheduleContext;
      if (!scheduleContext?.patientFound || scheduleContext.matchedBy === 'phone') {
        console.log("[No-IVR Agent] Performing secondary schedule lookup...");
        try {
          const dobForLookup = parsedDOB.iso || `${parsedDOB.year}-${parsedDOB.month}-${parsedDOB.day}`;
          const secondaryLookup = await scheduleLookupService.lookupByNameAndDOB(
            params.first_name,
            params.last_name,
            dobForLookup
          );
          if (secondaryLookup.patientFound) {
            enrichedContext = secondaryLookup;
            console.log("[No-IVR Agent] Secondary lookup: patient found with schedule context");
          } else {
            console.log("[No-IVR Agent] Secondary lookup: no records found");
          }
        } catch (lookupError) {
          console.error("[No-IVR Agent] Secondary lookup error:", lookupError);
        }
      }

      // Prepend [NO CALLBACK NEEDED] tag to summary when callback is not required
      const finalSummary = requiresCallback 
        ? params.request_summary 
        : `[NO CALLBACK NEEDED] ${params.request_summary}`;
      
      // Build full patient name for simplified endpoint
      const patientFullName = `${params.first_name} ${params.last_name}`;

      // Map preferred_contact to simplified endpoint format
      const contactMethodMap: Record<string, 'phone' | 'sms' | 'email'> = {
        'phone': 'phone',
        'text': 'sms',
        'email': 'email',
      };
      const preferredContactSimplified = params.preferred_contact
        ? contactMethodMap[params.preferred_contact] || 'phone'
        : 'phone';

      // Use NEW SIMPLIFIED ENDPOINT - more reliable, all mapping done server-side
      const result = await SyncAgentService.submitSimplifiedTicket({
        patientFullName,
        patientDOB: params.date_of_birth, // Any format - API handles parsing
        reasonForCalling: finalSummary,
        preferredContactMethod: preferredContactSimplified,
        patientPhone: callbackNormalized,
        patientEmail: params.email,
        lastProviderSeen: params.doctor_name || enrichedContext?.lastProviderSeen,
        locationOfLastVisit: params.location || enrichedContext?.lastLocationSeen,
        additionalDetails: params.appointment_time ? `Appointment: ${params.appointment_time}` : undefined,
        callSid: metadata.callSid,
        callerPhone: metadata.callerPhone,
        dialedNumber: metadata.dialedNumber,
        agentUsed: 'no-ivr',
        callStartTime: new Date().toISOString(),
      });

      if (result.error?.includes('Missing required information')) {
        console.log("[No-IVR Agent] VALIDATION FAILED:", result.error);
        return {
          success: false,
          validation_errors: [result.error],
          message: result.message || 'Please collect missing information and try again.',
        };
      }

      if (result.success && result.ticketNumber) {
        console.log(`[TICKET CREATE] ✓ SUCCESS for call ${metadata.callSid}: ${result.ticketNumber}`);
        console.log(`[TICKET CREATE]   Patient: ${params.first_name} ${params.last_name}, Category: ${params.request_category}`);
        
        // Log any lookup warnings
        if (result.lookupWarnings && result.lookupWarnings.length > 0) {
          console.warn(`[TICKET CREATE] Lookup warnings: ${result.lookupWarnings.join(', ')}`);
        }
        
        return { 
          success: true, 
          message: "Request submitted successfully. Confirm to patient that their request has been submitted and they will receive a callback."
        };
      } else {
        const errorMsg = result.error || "ticket_creation_failed";
        console.error(`[TICKET CREATE] ✗ FAILED for call ${metadata.callSid}: ${errorMsg}`);
        console.error(`[TICKET CREATE]   Patient: ${params.first_name} ${params.last_name}, Category: ${params.request_category}`);
        return { 
          success: false, 
          error: errorMsg,
          message: "FAILED to submit request. Apologize and escalate to human immediately."
        };
      }
    },
  });

  const escalateToHumanTool = tool({
    name: "escalate_to_human",
    description: `Transfer the call to a human on-call provider. 

⚠️ USE ONLY FOR THESE SPECIFIC SITUATIONS:
1. TRUE MEDICAL EMERGENCIES: Vision loss, severe pain, eye injury, chemical exposure, trauma
2. HEALTHCARE PROVIDER CALLS: Doctors, nurses, hospitals calling about a patient
3. PATIENT CONFUSION: After 3+ failed attempts to communicate AND you cannot create a ticket

❌ NEVER ESCALATE FOR:
- Appointment confirmations, scheduling, rescheduling, cancellations
- Medication refills or prescription questions  
- Billing or insurance questions
- General questions about office hours, locations, fax numbers
- Patient frustration or impatience (be patient, handle it yourself)
- "I want to speak to someone" without urgent symptoms

If a patient says "I want to speak to a human" but their request is non-urgent,
respond: "I understand. I'm here to help and can take your message right now.
The doctor will receive a full recording and transcript of our call."

PREREQUISITE: Collect caller info BEFORE calling this tool.`,
    parameters: z.object({
      reason: z.string().describe("Specific urgent symptoms or provider details - NOT general frustration"),
      caller_type: z
        .enum(["patient_urgent_medical", "healthcare_provider", "patient_unresponsive"])
        .describe("patient_urgent_medical=true emergency, healthcare_provider=Dr/nurse/hospital, patient_unresponsive=cannot communicate after 3 attempts"),
      patient_first_name: z.string().optional().describe("Patient first name if collected"),
      patient_last_name: z.string().optional().describe("Patient last name if collected"),
      patient_dob: z.string().optional().describe("Patient date of birth if collected"),
      callback_number: z.string().optional().describe("Callback number if collected"),
      symptoms_summary: z.string().optional().describe("Summary of urgent symptoms if applicable"),
      provider_info: z.string().optional().describe("Provider name/facility if healthcare provider call"),
    }),
    execute: async (params) => {
      console.info("[HANDOFF] escalate_to_human tool called:", {
        callerType: params.caller_type,
        reason: params.reason?.substring(0, 100),
        hasSymptoms: !!params.symptoms_summary,
        hasProviderInfo: !!params.provider_info,
        callId,
      });

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

      try {
        await handoffToHuman();
        console.info("[HANDOFF] ✓ handoffToHuman() completed successfully");
        return { success: true, message: "Call transferred to on-call provider." };
      } catch (handoffError) {
        console.error("[HANDOFF] ✗ handoffToHuman() threw error:", handoffError);
        return { success: false, message: "Transfer failed - please take a message instead." };
      }
    },
  });

  console.log(`[${agentTag}] CHECKPOINT 2: All tools created, building prompt...`);

  const callerHistorySection = (callerMemory && callerMemoryService)
    ? callerMemoryService.buildContextForPrompt(callerMemory)
    : "";

  console.log(`[${agentTag}] CHECKPOINT 3: Building system prompt...`);
  const instructions = buildNoIvrSystemPrompt(metadata, scheduleContext, variant, callerMemory, callerHistorySection);
  console.log(`[${agentTag}] CHECKPOINT 4: Prompt built (${instructions.length} chars), creating RealtimeAgent...`);

  const agent = new RealtimeAgent({
    name: isProduction ? "No-IVR After-Hours Agent (PROD)" : "No-IVR After-Hours Agent (DEV)",
    handoffDescription:
      "Unified after-hours agent that handles all call types through natural conversation - no IVR menu.",
    instructions,
    tools: [
      lookupScheduleTool,
      checkOpenTicketsTool,
      emitDecisionTool,
      createTicketTool,
      escalateToHumanTool,
    ],
  });

  console.log(`[${agentTag}] CHECKPOINT 5: RealtimeAgent created, adding guardrails...`);
  agent.outputGuardrails = medicalSafetyGuardrails;

  console.log(`[${agentTag}] ✓ Agent created with tools:`, [
    "lookup_schedule",
    "emit_decision",
    "create_ticket",
    "escalate_to_human",
  ]);
  console.log(`[${agentTag}] ✓ Version: ${versionString}`);

  return agent;
}

export const noIvrAgentConfig = {
  slug: "no-ivr",
  name: "No-IVR After-Hours Agent",
  description: "Single agent that answers all calls directly without IVR menu. Uses conversation to determine caller type and urgency. Transfers to human for urgent cases.",
  version: "1.11.0",
  greeting: "Thank you for calling Azul Vision's after-hours line. How may I help you?",
  voice: "sage",
  language: "en", // Default to English - prompt handles language detection/switching
};
