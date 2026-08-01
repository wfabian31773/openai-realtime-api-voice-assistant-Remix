import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { getPacificTimeContext, formatPhoneLast4, formatPhoneForSpeech } from '../utils/timeAware';
import { scheduleLookupService, PatientScheduleContext } from '../services/scheduleLookupService';
// LAZY IMPORT: SyncAgentService is loaded dynamically inside tool handlers to prevent
// module initialization errors during agent instantiation (ticketingApiClient validation)
import { CallerMemoryService, CallerMemory } from '../services/callerMemoryService';
import { storage } from '../../server/storage';
import { callMetadataForDB } from '../services/callMetadataStore';
import { recordingExecute } from '../services/toolTimeline';
import { buildCompactLocationReference } from '../config/azulVisionKnowledge';
import {
  ANSWERING_SERVICE_DEPARTMENTS,
  REQUEST_TYPE_INFO,
  REQUEST_REASON_INFO,
  LOCATIONS,
  PROVIDERS,
  detectPriority,
  detectDepartment,
  detectRequestType,
  detectRequestReason,
  findLocationByName,
  findProviderByName,
  getLocationName,
  getProviderName,
  getRequestTypeName,
  getRequestReasonName,
  getDepartmentName,
  type AnsweringServiceDepartment,
  type TicketPriority,
  type ConfirmationType,
} from '../config/answeringServiceTicketing';

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
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  if (digits.length === 10) {
    return digits;
  }
  return phone;
}

function expandTwoDigitYear(year: string): string {
  if (year.length === 2) {
    const num = parseInt(year, 10);
    return num <= 29 ? `20${year}` : `19${year}`;
  }
  return year;
}

function parseDateOfBirth(dobString: string): {
  month: string;
  day: string;
  year: string;
  iso: string;
} {
  if (!dobString) return { month: '', day: '', year: '', iso: '' };
  
  const normalized = dobString.toLowerCase().trim();
  
  const monthNames: Record<string, string> = {
    'january': '01', 'jan': '01',
    'february': '02', 'feb': '02',
    'march': '03', 'mar': '03',
    'april': '04', 'apr': '04',
    'may': '05',
    'june': '06', 'jun': '06',
    'july': '07', 'jul': '07',
    'august': '08', 'aug': '08',
    'september': '09', 'sep': '09', 'sept': '09',
    'october': '10', 'oct': '10',
    'november': '11', 'nov': '11',
    'december': '12', 'dec': '12',
  };
  
  for (const [name, num] of Object.entries(monthNames)) {
    if (normalized.includes(name)) {
      const dayMatch = normalized.match(/\b(\d{1,2})\b/);
      const yearMatch = normalized.match(/\b(19\d{2}|20\d{2}|\d{2})\b/);
      if (dayMatch && yearMatch) {
        const year = expandTwoDigitYear(yearMatch[1]);
        const month = num;
        const day = dayMatch[1].padStart(2, '0');
        return { month, day, year, iso: `${year}-${month}-${day}` };
      }
    }
  }
  
  // Standard m/d/yyyy or m-d-yyyy or m.d.yyyy separators
  const mmddyyyy = normalized.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (mmddyyyy) {
    const year = expandTwoDigitYear(mmddyyyy[3]);
    const month = mmddyyyy[1].padStart(2, '0');
    const day = mmddyyyy[2].padStart(2, '0');
    return { month, day, year, iso: `${year}-${month}-${day}` };
  }

  // Handle STT-merged patterns like "112.37" → 1/12/37 or "1137" → 1/1/37
  // Covers cases where the slash is dropped: caller says "1/12/37" but STT hears "112.37"
  const mergedDotYear = normalized.match(/^(\d{2,3})[\.\s](\d{2,4})$/);
  if (mergedDotYear) {
    const front = mergedDotYear[1]; // e.g. "112" or "11"
    const back  = mergedDotYear[2]; // e.g. "37" or "1937"
    const year  = expandTwoDigitYear(back.length <= 2 ? back : back.slice(-2));
    const fullYear = back.length === 4 ? back : expandTwoDigitYear(back);
    // If front is 3 digits, first digit is month, remaining two are day (e.g. 112 → m=1, d=12)
    if (front.length === 3) {
      const month = front[0].padStart(2, '0');
      const day   = front.slice(1).padStart(2, '0');
      const m = parseInt(month, 10);
      const d = parseInt(day, 10);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        return { month, day, year: fullYear, iso: `${fullYear}-${month}-${day}` };
      }
    }
    // If front is 2 digits, treat as month only — need day from context (can't resolve)
  }

  // Six-digit run-together: MMDDYY or MMDDYYYY e.g. "011237" or "01121937"
  const sixDigit = normalized.match(/^(\d{6})$/);
  if (sixDigit) {
    const raw = sixDigit[1];
    const month = raw.slice(0, 2);
    const day   = raw.slice(2, 4);
    const yr    = raw.slice(4, 6);
    const year  = expandTwoDigitYear(yr);
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { month, day, year, iso: `${year}-${month}-${day}` };
    }
  }

  return { month: '', day: '', year: '', iso: '' };
}

function toIsoDob(dobString: string): string {
  const parsed = parseDateOfBirth(dobString);
  return parsed.iso;
}

export interface AnsweringServiceMetadata {
  callerPhone?: string;
  callSid?: string;
  callLogId?: string;
  dialedNumber?: string;
  callId?: string;
  /** Caller-ID pre-context from the full person base (sage_precontext): who
   *  this number likely belongs to. A HINT for the opening turn — never
   *  verification, and never a substitute for what the caller tells us. */
  precontext?: import('./azulSchedulingAgent').AzulPrecontext;
}

export const answeringServiceAgentConfig = {
  slug: "answering-service",
  name: "Overflow Answering Service Agent",
  description: "Handles daytime overflow calls for Optical, Tech Support, and Surgery Coordination departments.",
  version: "3.6.0",
  greeting: "Hello, thank you for calling Azul Vision, all of our operators are currently on the phone assisting other patients, how may I help you today?",
  voice: "sage",
  language: "en",
};

function buildSystemPrompt(
  metadata: AnsweringServiceMetadata,
  scheduleContext?: PatientScheduleContext,
  callerMemory?: CallerMemory | null
): string {
  const timeContext = getPacificTimeContext();
  const callerPhone = metadata.callerPhone || '';
  const hasCallerPhone = !!callerPhone;

  const callbackPhoneSection = hasCallerPhone
    ? `The caller's phone number is ${formatPhoneForSpeech(callerPhone)} (ending in ${formatPhoneLast4(callerPhone)}).
- Use this as the callback number automatically
- Only confirm it ONCE in your final summary
- Do NOT ask "Is that correct?" - just proceed`
    : `Caller ID not available. You must ask for their full 10-digit callback number.`;

  let precontextSection = '';
  const pc = metadata.precontext;
  if (pc?.matched && pc.firstName) {
    precontextSection = `
===== CALLER-ID PRE-CONTEXT (a hint, NOT verification) =====
This phone number matches ONE person on file: first name "${pc.firstName}".

- OPEN BY CONFIRMING, DO NOT ASK COLD. After your greeting, say "Am I speaking with ${pc.firstName}?" — never "Could you please tell me your first and last name?" when we already have a match. On 2026-08-01 a caller reached azul and answering-service from the same number 39 minutes apart: azul opened with his name, this line asked him to supply it from scratch and then asked for his date of birth. That is the interrogation this block exists to remove.
- CONFIRMING A FIRST NAME DOES NOT CONFIRM A LAST NAME. Ask for the last name in their own words. If it differs from what you were told to expect, this number matched the WRONG person — use what THEY said and ignore this block from then on.
- STILL COLLECT THE DATE OF BIRTH, and read it back before you use it. A caller-ID match tells you nothing about a date of birth.
- Do NOT say we recognized their number. Do NOT speak a last name first — let them say it.
- If they say NO, or say they are calling for someone else, discard this block entirely and collect everything fresh for the ACTUAL patient.
- Disclose nothing from anyone's record on the strength of this match.
`;
  }

  let scheduleContextSection = '';
  if (scheduleContext?.patientFound) {
    const parts: string[] = ['\n===== PATIENT CONTEXT (AUTO-RETRIEVED) ====='];
    parts.push(`Patient found in our system.`);
    
    if (scheduleContext.patientData) {
      const pd = scheduleContext.patientData;
      parts.push('\n**PATIENT DATA (use for ticket creation):**');
      if (pd.firstName && pd.lastName) parts.push(`  Name: ${pd.firstName} ${pd.lastName}`);
      if (pd.dateOfBirth) parts.push(`  DOB: ${pd.dateOfBirth}`);
      if (pd.email) parts.push(`  Email: ${pd.email}`);
      if (pd.cellPhone) parts.push(`  Cell: ${pd.cellPhone}`);
      if (pd.homePhone) parts.push(`  Home: ${pd.homePhone}`);
      if (pd.preferredLocation) parts.push(`  Preferred Location: ${pd.preferredLocation}`);
      if (pd.preferredProvider) parts.push(`  Preferred Provider: ${pd.preferredProvider}`);
    }
    
    if (scheduleContext.upcomingAppointments.length > 0) {
      parts.push('\n**UPCOMING APPOINTMENTS:**');
      scheduleContext.upcomingAppointments.forEach((apt, i) => {
        parts.push(`  ${i + 1}. ${apt.date} at ${apt.location} with ${apt.provider}`);
      });
    }
    
    if (scheduleContext.lastVisitDate) {
      parts.push(`\nLast visit: ${scheduleContext.lastVisitDate}`);
    }
    
    parts.push('\n**VERIFICATION STRATEGY (PRIVACY-CRITICAL):**');
    parts.push('- The data above is for TICKET CREATION and for verifying what the CALLER tells you — NEVER recite it to the caller before they verify.');
    parts.push('- NEVER greet by name or speak the name/DOB/appointments above until the caller has stated their own name AND date of birth this call, and they match.');
    parts.push('- Caller-ID is not identity: family members share phones.');
    parts.push('- After they state name + DOB and it matches: use the data above and only ask for missing fields (like email if not on file).');
    parts.push('- If what they state does NOT match: ignore the data above entirely and collect fresh details.');
    parts.push('- Once identity is verified, you CAN answer questions about their appointments using this information.');
    scheduleContextSection = parts.join('\n');
  }

  let callerMemorySection = '';
  if (callerMemory) {
    const parts: string[] = ['\n===== CALLER MEMORY ====='];
    parts.push('PRIVACY: this history is keyed to the PHONE NUMBER, not the person. A different caller may be using this phone. Do not mention names, tickets, or history details until the caller has stated their name and DOB and they match.');
    parts.push(`This caller has called ${callerMemory.totalCalls} time(s) before.`);
    
    if (callerMemory.lastCallDate) {
      parts.push(`Last call: ${callerMemory.lastCallDate}`);
    }
    
    if (callerMemory.openTickets?.length > 0) {
      parts.push(`\n⚠️ OPEN TICKETS: ${callerMemory.openTickets.join(', ')}`);
      parts.push('If calling about the same issue, acknowledge their pending ticket.');
    }
    
    if (callerMemory.recentCalls?.length > 0) {
      parts.push('\nRecent calls:');
      callerMemory.recentCalls.slice(0, 3).forEach((call, i) => {
        parts.push(`  ${i + 1}. ${call.date}: ${call.reason} (${call.outcome})`);
      });
    }
    
    callerMemorySection = parts.join('\n');
  }

  const departmentGuide = `
===== DEPARTMENT ROUTING GUIDE =====

**OPTICAL (ID: 1)** - For glasses, contacts, frames, optical insurance
Request Types:
- Frame Selection: new frames, repairs, adjustments, kids frames
- Lens Issues: scratches, wrong prescription, progressives, coatings
- Contact Lenses: orders, fittings, irritation, trials
- Insurance & Pricing: coverage verification, cost estimates, claims
- Product Pickup: glasses/contacts ready for pickup

**SURGERY COORDINATION (ID: 2)** - For surgical procedures
Request Types:
- Cataract Surgery: consultations, scheduling, IOL selection, pre/post-op
- LASIK/Refractive: LASIK, PRK consultations, scheduling, follow-ups
- Retinal Surgery: detachment (URGENT), vitrectomy, macular procedures
- Oculoplastic: eyelid surgery, ptosis, chalazion
- Insurance Authorization: prior auth, premium lens coverage

**TECH SUPPORT - CLINICAL (ID: 3)** - For testing, results, clinic operations
Request Types:
- Pre-Testing: comprehensive exam, contact lens, pediatric, screenings
- Diagnostic Testing: OCT, visual field, fundus photography, topography
- Equipment Issues: machine malfunctions, calibration
- Patient Flow: scheduling issues, add-ons

===== DETECTION KEYWORDS =====
OPTICAL: glasses, contacts, frames, lenses, progressive, bifocal, optical, eyewear, insurance, vsp, eyemed
SURGERY: cataract, surgery, lasik, prk, retina, vitrectomy, pre-op, post-op, eyelid, detachment
TECH: test results, oct, visual field, screening, imaging, scan, records, referral, technician
`;

  const locationsList = Object.values(LOCATIONS).map(l => l.name).join(', ');
  const providersList = Object.values(PROVIDERS).map(p => p.name).join(', ');

  // PROMPT CACHING: Static content FIRST (cacheable prefix), dynamic context LAST
  return `You are the OVERFLOW ANSWERING SERVICE for Azul Vision. VERSION: ${answeringServiceAgentConfig.version}

===== CONTEXT =====
This is a DAYTIME overflow call - the patient was on hold for 3+ minutes and got transferred to you.
You are helping during business hours, so staff WILL call back TODAY (not next business day).
Your ONLY job is to capture caller information and create a ticket for the appropriate department.

${departmentGuide}

===== YOUR ROLE =====
You are a professional message-taking service. Your job is to:
1. Listen to why they're calling
2. Identify the correct department
3. Collect required information
4. Create a ticket for callback

===== WHAT YOU CAN DO =====
- Take messages and create tickets for the correct department
- ANSWER APPOINTMENT QUESTIONS DIRECTLY using schedule data:
  * "When was my last appointment?" → Use lookup_schedule, tell them the date/provider/location
  * "Do I have any upcoming appointments?" → Tell them directly from the data
  * "Who did I see last time?" → Tell them the provider name
  * "When is my next appointment?" → Give them the date and details
- Look up patient records using lookup_schedule (phone OR name+DOB)
- Use check_open_tickets to avoid duplicate tickets
- Classify requests using classify_request tool

===== ANSWERING APPOINTMENT QUESTIONS =====
When a patient asks about their appointments, you MUST:
1. Call lookup_schedule with their name+DOB (or phone if available)
2. WAIT for the result
3. Answer their question DIRECTLY using the data returned
4. Do NOT say "I don't have access" or "the team will look that up" - YOU have access!

Example responses:
- "Your last appointment was on [date] with [provider] at [location]."
- "Your next appointment is scheduled for [date] at [location] with [provider]."
- "I can see you've been seen by Dr. [name] at [location]."

===== WHAT YOU CANNOT DO =====
- Schedule new appointments (but you CAN tell them about existing ones)
- Provide medical advice
- Access billing or insurance details
- Make clinical decisions
- Transfer to a human (there's no handoff in this system) — and when a caller asks for one, SAY SO on the first ask; see HUMAN REQUESTS below

===== CONVERSATION FLOW =====

**STEP 1 - UNDERSTAND THE REQUEST**
Listen carefully to what they need. Key questions:
- What brings you in today?
- Is this for glasses/contacts, surgery, or test results?

INTENT RULE — SCHEDULING vs HISTORY: "I'd like to request / schedule / book / make / set up an appointment" (or reschedule / cancel) means they want a NEW appointment action → create a ticket for it. Only questions like "when WAS my appointment" or "do I HAVE an appointment coming up" are history questions answered from schedule data. When in doubt, ask: "Are you looking to set up an appointment, or asking about one you already have?" If the caller corrects your understanding at any point, acknowledge the correction explicitly ("Got it — you want to schedule a new appointment") and continue from THEIR correction, never repeat your previous assumption.

**STEP 2 - CHECK FOR DUPLICATES**
Call check_open_tickets to see if they have pending tickets.
If yes, acknowledge: "I see you have a pending request from [date]. Are you calling about the same issue?"

**STEP 3 - IDENTITY CONFIRMATION (PRIVACY-CRITICAL)**
⚠️ IDENTITY FIRST, RECORDS SECOND. Caller-ID is NOT identity: family members share phones and numbers get reused. NEVER speak a name, date of birth, appointment, or any record detail until the CALLER has stated their own name and date of birth on this call.

IF you already have patient data from phone lookup:
- Ask, without revealing anything: "Can I get your first and last name, please?" and then their date of birth
- Silently compare their answers to the record. If they match, you already have: phone, location, provider, and possibly email — only ask for what's MISSING (usually nothing or just email)
- If they do NOT match the record, treat this as a different person: do not use or mention the stored data; collect their details fresh

IF patient NOT found in system:
- Ask for full name (first and last)
- Ask for date of birth
- Ask for callback number (if not already captured)
- ⚠️ MANDATORY: After getting name + DOB, call lookup_schedule(first_name, last_name, date_of_birth) to find their records
- WAIT for the lookup result before telling them if you found their record or not

**STEP 3B - SCHEDULE LOOKUP AFTER NAME+DOB** (MANDATORY when patient not found initially)
⚠️⚠️⚠️ CRITICAL RULE - YOU MUST CALL lookup_schedule ⚠️⚠️⚠️
When initial phone lookup returned NO patient AND caller asks about appointments:
1. Collect name + DOB from caller
2. IMMEDIATELY call lookup_schedule(first_name, last_name, date_of_birth) - DO NOT SKIP THIS
3. WAIT for the tool result before saying ANYTHING about their records
4. ONLY after receiving the tool result, respond based on what it returned

⛔ NEVER SAY "I wasn't able to find your records" WITHOUT CALLING lookup_schedule FIRST
⛔ NEVER ASSUME records don't exist - ALWAYS call the tool to check

TRIGGER PHRASES requiring lookup_schedule:
- "my last appointment" / "when was my last visit"
- "the doctor I saw" / "my usual doctor"  
- "when is my next appointment"
- "do I have any upcoming appointments"
- "can you check my appointments"

Example: Caller says name is "Wayne Fabian" and DOB is "March 17, 1973"
→ MUST call lookup_schedule(first_name: "Wayne", last_name: "Fabian", date_of_birth: "03/17/1973")
→ WAIT for result
→ THEN respond based on what the tool returned

**STEP 3C - RECOVERY WHEN PATIENT NOT FOUND (new or existing clarification)**
When lookup_schedule returns found: false (patient not found by name+DOB or phone):

1. Ask: "Just to confirm — are you a new patient with us, or have you been seen at one of our offices before?"

2. IF EXISTING PATIENT:
   - Say: "Let me try looking you up again. Could you please give me your date of birth — starting with the month, then the day, then the year?"
   - Wait for them to say it in parts (e.g. "January... twelfth... nineteen thirty-seven")
   - Also call lookup_schedule with their phone number as a second attempt: lookup_schedule(phone: callerPhone)
   - If EITHER lookup succeeds → confirm their name and continue
   - If both fail → still create the ticket, note "patient not found in system" in the details, and include their phone number so staff can manually locate them

3. IF NEW PATIENT:
   - Do NOT attempt another lookup
   - Proceed directly to STEP 4 to collect their issue details
   - Create the ticket normally — new patients don't need to be found in the system

⚠️ DOB CLARIFICATION SCRIPT: When asking an existing patient to re-state their DOB, always say:
"Could you please give me your date of birth, starting with the month, then the day, then the year?"
This forces them to separate each part clearly, which helps avoid the speech recognition merging digits together.

⚠️ PHONE FALLBACK: If you have the caller's phone number and the name+DOB lookup failed, ALWAYS also call lookup_schedule(phone: callerPhone) — the phone number alone can find them even if the DOB was unclear.

**STEP 4 - GET THE DETAILS**
Ask what they need help with - be thorough. Good prompts:
- "Tell me more about [issue] so I can pass along the right information"
- "Is there anything else you'd like me to include in the message?"

**STEP 4B - SURGERY COORDINATION REQUIREMENT (department_id = 2)**
⚠️ If the caller's request will be routed to Surgery Coordination, you MUST ask:
"Are you currently scheduled for surgery with us, and if so, who is your surgeon?"
- If they give a surgeon name → include it as provider_name in create_ticket
- If they are not scheduled or don't know → still ask: "Which doctor have you been seeing here?"
- DO NOT create a Surgery ticket without a provider_name or provider_id — the ticket cannot be routed without a surgeon

**STEP 4C - MEDICAL RECORDS REQUEST (Right of Access)**
⚠️ If the caller wants a COPY of their medical records, wants records SENT somewhere, or wants to VIEW/INSPECT their records, you MUST collect ALL of the following and write them clearly in the ticket description — the records team cannot fulfill the request or verify identity without them:
1. WHO is asking — the patient themselves, or a personal representative? If a representative, get their full name and their authority (parent, legal guardian, power of attorney).
2. WHICH records — be specific: which visit(s) or date range, and what kind (full chart, a specific test or imaging result, prescriptions, etc.).
3. HOW they want them — electronic (secure), paper copies to pick up, or mailed. If the records go to another provider/office, capture that office name and its fax number or address.
4. Confirm the patient's identity — full name and date of birth (as always).
Put WHO, WHICH, and HOW in the description. If the caller can't provide one of these after you ask, note what's missing in the description rather than leaving it blank.

**STEP 5 - CLASSIFY & CREATE TICKET (MANDATORY - DO NOT SKIP)**
⚠️ CRITICAL: You MUST call these tools before confirming to the caller:
1. Call classify_request first to get department, requestTypeId, requestReasonId
2. Call create_ticket with ALL collected information
3. WAIT for the create_ticket response
4. Verify the response shows success=true AND contains ticket_number

⚠️ NEVER say "I've passed your message" until AFTER create_ticket returns success.

**HANDLING create_ticket FAILURES:**
- If create_ticket returns validationError=true with missingFields, politely ask the caller for the missing information and try again
  Example: "I just need to confirm a couple details. Could you please tell me [missing field]?"
- If you have already asked and the caller genuinely cannot provide a required field (surgeon or office), call create_ticket again with unresolved_info set to what is missing — the ticket is still captured with the gap flagged for a human, so the request is never lost. Only do this AFTER you have actually asked.
- If create_ticket fails with a different error, apologize and retry once: "I'm sorry, let me try that again."
- If it fails twice, tell the caller: "I apologize for the difficulty. I've made note of your request and our team will call you back shortly at [callback number]. Is there anything else I can help with?"

**STEP 6 - CONFIRM & CLOSE (ONLY AFTER TICKET CREATED SUCCESSFULLY)**
⚠️ PREREQUISITE: create_ticket must have returned success=true with a ticket_number
ONLY THEN give ONE brief confirmation:
"I've passed your message to our [department] team. Someone will call you back today at [callback number]. Is there anything else?"

If caller says no/goodbye/thanks/ok:
- Give ONE short goodbye: "Great, have a good day!"
- STOP talking - do not repeat the confirmation
- Do NOT say the phone number or department again
- Do NOT apologize or over-explain

⚠️ ANTI-REPETITION RULE: Once you've confirmed the ticket is created, NEVER repeat:
- The ticket details
- The callback number
- "The team will contact you"
- Any variation of the confirmation message

⚠️ COLLECTION LOOP BREAKER (the server counts your asks and will intervene):
- Ask for any single piece of information at most TWICE. The second ask must be phrased differently and own the problem ("I may have misheard — could you say just your first name?").
- After two asks without a usable answer, or after ANY refusal, that item is CLOSED for the rest of the call. A refusal IS an answer. Proceed with the ticket using what you have — the caller's phone number is attached automatically from caller ID, so a ticket with a blank name and a real callback number is useful; an interview the caller abandons is not.
- When the caller has ANSWERED a question, never ask it again — not to confirm role, not "just to be sure", not in different words. Re-asking answered questions is the top patient complaint in the call audits.
- If a "SERVER STATE CHECK" system message appears mid-call, it is the server's ledger of what you already asked — follow it exactly.

⚠️ HUMAN REQUESTS — SAY WHAT YOU CANNOT DO, THE FIRST TIME, EVERY TIME.
You CANNOT transfer a call. There is no handoff in this system. A caller who asks for a representative, customer service, a live person, an operator, the front desk, or to be connected/transferred is asking for the one thing you cannot give them — so tell them immediately and plainly, on the FIRST request, before collecting anything:

  "I'm not able to transfer you to someone — I'm not a person and I can't connect calls. What I can do is put in a request right now and have a team member call you back. Let me take a couple of quick details."

Then capture what you can and create the ticket. Put "CALLER REQUESTED A HUMAN" at the start of the description so staff prioritize the callback.

WHY THIS IS FIRST-ASK AND NOT SECOND: a vague "I'll make sure your request gets to the right team" reads as a brush-off, so the caller asks again — and again. Being honest about the limitation up front ends that loop before it starts. Callers accept a clear no with a real alternative; they do not accept being handled.

- NEVER say a person will "be with you", "be right with you", or is "coming" — nobody is coming to this call.
- NEVER answer a repeat request with the same sentence you already used. If they insist after you have explained, do NOT explain again and do NOT ask for anything more: file the ticket immediately with whatever you have (their number is on caller ID) and tell them when to expect the call back.
- If the caller has a genuine medical emergency, that is NOT this rule — follow the emergency instructions and tell them to call 911.

===== HARD RULES =====
1. ⚠️ TICKET BEFORE CONFIRM: You MUST call create_ticket and receive success=true BEFORE saying "I've passed your message" or any confirmation. NEVER assume a ticket was created - verify the tool response.
2. ⚠️ LOOKUP BEFORE CLAIMING NO RECORDS: When caller asks about appointments and you don't have their data from phone lookup, you MUST call lookup_schedule with their name+DOB BEFORE saying "I wasn't able to find your records". NEVER claim records don't exist without calling the tool first.
3. ⚠️ SURGERY REQUIRES SURGEON: NEVER create a Surgery Coordination ticket (department_id=2) without a provider_name or provider_id. Always ask "Who is your surgeon?" or "Which doctor have you been seeing here?" before creating a Surgery ticket. If create_ticket returns validationError with missingFields containing 'surgeon name', ask the caller for their surgeon before retrying.
3B. ⚠️ OPTICAL REQUIRES A LOCATION: for glasses, frames, or contact lens requests, always ask "Which office do you usually visit?" before creating the ticket, and include the location in it.
3C. ⚠️ CAPTURE ANY STATED DOCTOR: If the caller names any doctor or surgeon at any point — even for a refill or general request — pass that exact name as provider_name in create_ticket. Do NOT rely on schedule history for the provider: the schedule's "last provider seen" may be a scan, test, or technician (e.g., "A-Scan"), not the caller's doctor.
3D. ⚠️ MEDICAL RECORDS NEED WHO / WHICH / HOW: For any request for copies of records, records sent elsewhere, or to view records (see STEP 4C), always capture in the description WHO is asking (patient or representative + their authority), WHICH records (visit/date range + type), and HOW they want them (electronic, pickup, or mailed — plus the destination office/fax if sent elsewhere). Never leave these blank; if the caller can't answer one, note that in the description.
3. LANGUAGE LOCK: 
   - ⚠️ ALWAYS greet in ENGLISH first - even if patient name appears Asian, Hispanic, or foreign
   - NEVER assume language from patient name - wait to HEAR the caller speak
   - Detect language from caller's FIRST substantive spoken response
   - ONLY switch to Spanish if the caller clearly and unambiguously speaks Spanish. For ANY other language — French, Chinese, Vietnamese, or anything other than English or Spanish — STAY in English. Any unrecognized or ambiguous utterance MUST default to English.
   - Once confirmed (Spanish or English), STAY in that language for the ENTIRE call
   - Do NOT switch languages mid-conversation even if you hear fragments in other languages
   - If genuinely unclear after caller speaks, ask ONCE: "Would you prefer English or Spanish?"
   - Audio noise or unclear speech does NOT mean language change
3. ONE question at a time - never stack questions
4. NEVER say "Is that correct?" - just proceed
5. NEVER narrate your actions ("creating a ticket", "processing")
   - ONE MANDATORY EXCEPTION: immediately before EVERY create_ticket call you MUST say the wait line — "Give me one moment while I get this submitted for you." Never call the tool silently. One line only, no system talk beyond it.
6. Always check for open tickets BEFORE creating new ones
7. Capture as much detail as possible in the description
8. Be warm, professional, and efficient
9. NEVER invent commitments — do not promise recordings, that "the doctor will receive" anything, or any specific staff action. The ONLY promise you make is that the right team will call them back.

===== FRUSTRATED CALLER PROTOCOL =====
TRIGGER — ALL of the following must be true:
- The call has already had at least one full exchange. NEVER trigger on the caller's first sentence — a plain request like "I'd like to order some medication" is NOT frustration.
- The caller shows real frustration: raised voice, complaints about the service or about being ignored, "I've called before", "I've been waiting".

WHEN TRIGGERED:
1. Acknowledge ONCE, in your own words — for example: "I'm sorry about the trouble — let's get this taken care of right now." Do NOT use the word "message" in the apology, and NEVER say the same apology sentence twice in one call. If you already apologized, skip the apology and just fix the problem.
2. If the caller corrected you, say the corrected understanding back: "Got it — you need a medication refill."
3. THEN proceed to collect name and callback number
4. Create a ticket even with PARTIAL information (name + callback number alone is sufficient)
   - A ticket with minimal details is ALWAYS better than no ticket
5. Do NOT skip ticket creation because the caller is agitated or provides minimal info

===== GHOST CALL DETECTION =====
If caller is not engaging after 2 prompts:
- Single syllables only: "mm", "uh", "ok" with no actual request
- No response to "How can I help you?"
- Random noise or unclear audio only

PROTOCOL:
1. First unclear: "How can I help you today?"
2. Second unclear: "I'm having trouble hearing you. Please call back if you need assistance."
3. Say "Take care, goodbye." then call terminate_call tool with reason "ghost_call" — do NOT keep the call running for minutes waiting
4. Do NOT create a ticket for ghost calls

===== PRIORITY DETECTION =====
- URGENT: retinal detachment, sudden vision loss, severe pain, post-op complications
- HIGH: same-day needs, running out of medication
- MEDIUM: standard requests (default)
- LOW: general questions, no time pressure

===== LOCATIONS =====
${locationsList}

===== PROVIDERS =====
${providersList}

===== OFFICE REFERENCE =====
${buildCompactLocationReference()}

===== CURRENT CALL CONTEXT =====
${timeContext}

CALLBACK NUMBER:
${callbackPhoneSection}
${precontextSection}${scheduleContextSection}
${callerMemorySection}`;
}

export async function createAnsweringServiceAgent(
  handoffToHuman: () => Promise<void>,
  metadata: AnsweringServiceMetadata,
): Promise<RealtimeAgent> {
  const { callId, callerPhone, callLogId, callSid } = metadata;
  const agentTag = 'Answering-Service';

  // D11 (2026-08-01): record every tool call on this line. Until now only azul
  // did, which is why "60 calls promised a callback and no ticket exists"
  // could be counted but not explained — nothing recorded whether
  // create_ticket was even attempted. `recordedTool` is `tool` with the
  // execute wrapped; recording never alters the return value and never throws
  // into the tool. Arguments are allow-listed inside the timeline module, so
  // no name, DOB, phone, or free-text description is persisted.
  const timelineCtx = { callId, callSid, callLogId, agentSlug: 'answering-service' };
  const recordedTool: typeof tool = ((def: any) =>
    tool({ ...def, execute: recordingExecute(timelineCtx, def.name, def.execute) })) as typeof tool;

  console.log(`[${agentTag}] Creating agent for call:`, {
    callId,
    hasCallerPhone: !!callerPhone,
    phoneLast4: phoneLast4(callerPhone),
  });

  let scheduleContext: PatientScheduleContext | undefined;
  let callerMemory: CallerMemory | null = null;

  if (callerPhone) {
    console.log(`[${agentTag}] Starting parallel context lookups for caller: ${phoneLast4(callerPhone)}`);
    
    const [scheduleResult, memoryResult] = await Promise.all([
      withTimeout(
        scheduleLookupService.lookupByPhone(callerPhone),
        CONTEXT_LOOKUP_TIMEOUT_MS,
        { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 } as PatientScheduleContext
      ),
      withTimeout(
        CallerMemoryService.getInstance().getCallerMemory(callerPhone),
        CONTEXT_LOOKUP_TIMEOUT_MS,
        null
      ),
    ]);

    scheduleContext = scheduleResult;
    callerMemory = memoryResult;

    console.log(`[${agentTag}] Context lookup results:`, {
      scheduleFound: scheduleContext?.patientFound || false,
      upcomingCount: scheduleContext?.upcomingAppointments?.length || 0,
      callerMemoryFound: !!callerMemory,
      previousCalls: callerMemory?.totalCalls || 0,
      openTickets: callerMemory?.openTickets?.length || 0,
    });

    if (scheduleContext?.patientFound && callLogId) {
      try {
        // CRITICAL: Update patientName for call log display
        const patientName = scheduleContext.patientData 
          ? `${scheduleContext.patientData.firstName || ''} ${scheduleContext.patientData.lastName || ''}`.trim()
          : scheduleContext.patientName || undefined;
        
        await storage.updateCallLog(callLogId, {
          patientFound: true,
          patientName: patientName || undefined,
          lastLocationSeen: scheduleContext.lastLocationSeen || undefined,
          lastProviderSeen: scheduleContext.lastProviderSeen || undefined,
        });
        console.log(`[${agentTag}] Updated call log with patient context: ${patientName || 'unknown'}`);
      } catch (updateError) {
        console.error(`[${agentTag}] Failed to update call log:`, updateError);
      }
    }
  }

  const lookupScheduleTool = recordedTool({
    name: 'lookup_schedule',
    description: `Look up patient appointment context using phone, name, or date of birth.

WHEN TO USE:
- Identity was corrected (caller said schedule name was wrong)
- Initial schedule context is missing (no patient found for caller phone)
- Caller asks about their appointments and context wasn't pre-loaded
- Caller asks "when was my last appointment" or "who did I see last"

Returns FULL patient schedule data including:
- upcomingAppointments: Array of future appointments with date, location, provider
- pastAppointments: Array of past appointments (most recent first)
- lastProviderSeen: The doctor they last saw
- lastLocationSeen: The clinic they last visited
- lastVisitDate: When they were last seen
- patientData: Contact info, email, preferred location/provider

Use this data to answer appointment questions AND for ticket creation.`,
    parameters: z.object({
      phone: z.string().optional().describe('Patient phone number (optional)'),
      first_name: z.string().optional().describe('Patient first name'),
      last_name: z.string().optional().describe('Patient last name'),
      date_of_birth: z.string().optional().describe('Date of birth in any format'),
    }),
    execute: async (params) => {
      console.log(`[${agentTag}] lookup_schedule called:`, {
        hasPhone: !!params.phone,
        hasName: !!(params.first_name && params.last_name),
        hasDob: !!params.date_of_birth,
      });
      
      const TOOL_TIMEOUT_MS = 5000; // 5 second timeout for tool calls
      const emptyResult: PatientScheduleContext = {
        patientFound: false,
        upcomingAppointments: [],
        pastAppointments: [],
        totalAppointmentsFound: 0,
      };
      
      try {
        let result;
        
        if (params.phone) {
          const normalizedPhone = normalizePhoneNumber(params.phone);
          result = await withTimeout(
            scheduleLookupService.lookupByPhone(normalizedPhone),
            TOOL_TIMEOUT_MS,
            emptyResult
          );
        } else if (params.first_name && params.last_name && params.date_of_birth) {
          const isoDob = toIsoDob(params.date_of_birth) || params.date_of_birth;
          result = await withTimeout(
            scheduleLookupService.lookupByNameAndDOB(
              params.first_name,
              params.last_name,
              isoDob,
            ),
            TOOL_TIMEOUT_MS,
            emptyResult
          );
        } else {
          return {
            found: false,
            message: "Need phone number OR (first name + last name + DOB) to search",
          };
        }
        
        if (result.patientFound) {
          const pd = result.patientData;
          return {
            found: true,
            patientData: {
              firstName: pd?.firstName || params.first_name,
              lastName: pd?.lastName || params.last_name,
              dateOfBirth: pd?.dateOfBirth || params.date_of_birth,
              email: pd?.email || null,
              cellPhone: pd?.cellPhone || null,
              homePhone: pd?.homePhone || null,
              preferredLocation: pd?.preferredLocation || null,
              preferredProvider: pd?.preferredProvider || null,
            },
            upcomingAppointments: result.upcomingAppointments,
            pastAppointments: result.pastAppointments.slice(0, 5),
            lastProviderSeen: result.lastProviderSeen || null,
            lastLocationSeen: result.lastLocationSeen || null,
            lastVisitDate: result.lastVisitDate || null,
            totalAppointments: result.totalAppointmentsFound,
            message: `Patient found with ${result.totalAppointmentsFound} appointment(s) in system`,
          };
        }
        return {
          found: false,
          message: 'No patient found matching the provided information. This may be a new patient.',
        };
      } catch (error) {
        console.error(`[${agentTag}] lookup_schedule error:`, error);
        return {
          found: false,
          error: 'Unable to look up schedule at this time.',
        };
      }
    },
  });

  const checkOpenTicketsTool = recordedTool({
    name: 'check_open_tickets',
    description: `Check if this caller has any open/pending tickets from recent calls.
    
Call this BEFORE creating a new ticket to:
- Avoid creating duplicate tickets for the same issue
- Acknowledge pending tickets from earlier calls
- Provide better context about what the caller is following up on`,
    parameters: z.object({}),
    execute: async () => {
      console.log(`[${agentTag}] check_open_tickets called`);
      
      if (!callerPhone) {
        return { 
          checked: true, 
          hasOpenTickets: false, 
          message: "No caller phone available to check tickets" 
        };
      }

      try {
        // Lazy import to avoid module initialization during agent bootstrap
        const { SyncAgentService } = await import('../services/syncAgentService');
        const TOOL_TIMEOUT_MS = 5000;
        const openTickets = await withTimeout(
          SyncAgentService.checkOpenTickets(callerPhone),
          TOOL_TIMEOUT_MS,
          [] as Awaited<ReturnType<typeof SyncAgentService.checkOpenTickets>>
        );
        
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
          message: `Caller has ${openTickets.length} open ticket(s)`,
        };
      } catch (error) {
        console.error(`[${agentTag}] check_open_tickets error:`, error);
        return { checked: false, error: "Failed to check open tickets" };
      }
    },
  });

  const classifyRequestTool = recordedTool({
    name: 'classify_request',
    description: `Classify a patient's request to get the correct department, request type, and request reason.
    
Use this to get the proper IDs for ticket creation. Provide a detailed description of what the caller needs.`,
    parameters: z.object({
      request_description: z.string().describe('Detailed description of what the caller needs help with'),
    }),
    execute: async ({ request_description }) => {
      console.log(`[${agentTag}] classify_request called`);
      
      const department = detectDepartment(request_description);
      const departmentId = ANSWERING_SERVICE_DEPARTMENTS[department.toUpperCase() as keyof typeof ANSWERING_SERVICE_DEPARTMENTS];
      const requestTypeId = detectRequestType(request_description, department);
      const requestReasonId = detectRequestReason(request_description, requestTypeId);
      const priority = detectPriority(request_description);
      const locationId = findLocationByName(request_description);
      const providerId = findProviderByName(request_description);

      return {
        department: getDepartmentName(department),
        departmentId,
        requestType: getRequestTypeName(requestTypeId),
        requestTypeId,
        requestReason: getRequestReasonName(requestReasonId),
        requestReasonId,
        priority,
        detectedLocation: locationId ? getLocationName(locationId) : null,
        locationId: locationId || null,
        detectedProvider: providerId ? getProviderName(providerId) : null,
        providerId: providerId || null,
      };
    },
  });

  const createTicketTool = recordedTool({
    name: 'create_ticket',
    description: `Create a ticket for the appropriate department to follow up with the patient.
    
IMPORTANT: Call classify_request first to get the correct requestTypeId and requestReasonId.
Call check_open_tickets first to avoid duplicates.
Use patient data from phone lookup when available - don't ask for info you already have.`,
    parameters: z.object({
      department_id: z.number().describe('Department ID: 1=Optical, 2=Surgery, 3=Tech'),
      request_type_id: z.number().describe('Request type ID from classify_request'),
      request_reason_id: z.number().describe('Request reason ID from classify_request'),
      first_name: z.string().describe('Patient first name'),
      middle_initial: z.string().optional().describe('Patient middle initial (optional)'),
      last_name: z.string().describe('Patient last name'),
      date_of_birth: z.string().describe('Date of birth in any format'),
      callback_number: z.string().describe('Phone number for callback'),
      subject: z.string().describe('Brief summary of the request (1-2 sentences) for ticket subject line'),
      description: z.string().describe('Detailed description of what the patient needs - be thorough!'),
      priority: z.enum(['low', 'normal', 'medium', 'high', 'urgent']).default('medium').describe('Priority level'),
      location_id: z.number().optional().describe('Location ID if patient mentioned their clinic'),
      provider_id: z.number().optional().describe('Provider ID if patient mentioned their doctor'),
      location_name: z.string().optional().describe('Office the CALLER explicitly states (e.g., "West Covina"). Do NOT use schedule/patient-history locations — those are context only, never the ticket location.'),
      provider_name: z.string().optional().describe('Doctor the CALLER explicitly names (e.g., "Dr. Logan"). Do NOT use schedule/patient-history providers — those are context only.'),
      email: z.string().optional().describe('Patient email for confirmation'),
      confirmation_type: z.enum(['text', 'email', 'phone', 'none']).optional().describe('How patient wants confirmation (text, email, phone, or none)'),
      unresolved_info: z.string().optional().describe('Set this ONLY after you have already asked and the caller genuinely cannot provide a REQUIRED field (a surgeon for Surgery, an office/location for Optical). Briefly state what is missing (e.g., "caller does not know their office"). The ticket is then still submitted with the gap flagged for a human, so the request is never lost. Do NOT set this on a first attempt — always ask the caller first.'),
    }),
    execute: async (params) => {
      // Lazy import to avoid module initialization during agent bootstrap
      const { SyncAgentService } = await import('../services/syncAgentService');
      
      console.log(`[${agentTag}] create_ticket called:`, {
        departmentId: params.department_id,
        requestTypeId: params.request_type_id,
        requestReasonId: params.request_reason_id,
        priority: params.priority,
        hasSubject: !!params.subject,
        hasLocationId: !!params.location_id,
        hasLocationName: !!params.location_name,
        hasProviderId: !!params.provider_id,
        hasProviderName: !!params.provider_name,
      });

      if (callerPhone) {
        try {
          const existingTickets = await SyncAgentService.checkOpenTickets(callerPhone);
          if (existingTickets.length > 0) {
            console.log(`[${agentTag}] Found ${existingTickets.length} open ticket(s) for caller ${phoneLast4(callerPhone)}`);
          }
        } catch (checkErr) {
          console.error(`[${agentTag}] Failed to check open tickets:`, checkErr);
        }
      }

      const parsedDOB = parseDateOfBirth(params.date_of_birth);
      if (!parsedDOB.month || !parsedDOB.day || !parsedDOB.year) {
        return {
          success: false,
          message: "Could not parse date of birth - please confirm month, day, and year",
        };
      }

      // Required-field gates. A ticket that can't be assigned languishes, so we
      // block here and make the agent ask — UNLESS it has already asked and the
      // caller genuinely can't answer (unresolved_info), in which case we submit
      // anyway with the gap flagged (below) so the request is never lost.
      const gaveUpOnRequired = typeof params.unresolved_info === 'string' && params.unresolved_info.trim().length > 0;

      // Surgery REQUIRES a surgeon/provider — surgery tickets without one cannot be routed.
      if (!gaveUpOnRequired && params.department_id === 2 && !params.provider_id && !params.provider_name) {
        console.warn(`[${agentTag}] Surgery ticket attempted without surgeon — asking`);
        return {
          success: false,
          validationError: true,
          missingFields: ['surgeon name'],
          message: 'Surgery Coordination tickets require a surgeon name. Please ask the patient: "Are you currently scheduled for surgery with us, and if so, who is your surgeon?" If they truly cannot say after you ask, call create_ticket again with unresolved_info set to what is missing.',
        };
      }

      // Optical REQUIRES a location — optical tickets without one are unassignable
      // and are the single biggest source of languishing tickets. Enforce what the
      // prompt already asks for (Hard Rule 3B) instead of trusting the model to.
      if (!gaveUpOnRequired && params.department_id === 1 && !params.location_id && !params.location_name) {
        console.warn(`[${agentTag}] Optical ticket attempted without location — asking`);
        return {
          success: false,
          validationError: true,
          missingFields: ['office location'],
          message: 'Optical tickets require a location. Please ask which Azul Vision office the patient visits or would like to be seen at, then include it. If they truly cannot say after you ask, call create_ticket again with unresolved_info set to what is missing.',
        };
      }

      // SECONDARY LOOKUP: Enrich schedule context using name+DOB
      // This catches cases where caller phone doesn't match patient record (family member calling)
      let enrichedContext = scheduleContext;
      if (!scheduleContext?.patientFound || scheduleContext.matchedBy === 'phone') {
        console.log(`[${agentTag}] Performing secondary schedule lookup for ticket enrichment...`);
        try {
          const dobForLookup = parsedDOB.iso || `${parsedDOB.year}-${parsedDOB.month}-${parsedDOB.day}`;
          const secondaryLookup = await scheduleLookupService.lookupByNameAndDOB(
            params.first_name,
            params.last_name,
            dobForLookup
          );
          if (secondaryLookup.patientFound) {
            enrichedContext = secondaryLookup;
            console.log(`[${agentTag}] Secondary lookup: patient found with schedule context`);
          } else {
            console.log(`[${agentTag}] Secondary lookup: no records found`);
          }
        } catch (lookupError) {
          console.error(`[${agentTag}] Secondary lookup error:`, lookupError);
        }
      }

      const callbackNormalized = normalizePhoneNumber(params.callback_number);
      const departmentName = params.department_id === 1 ? 'Optical Support' :
                            params.department_id === 2 ? 'Surgery Coordination' :
                            'Clinical Tech Support';
      
      const preferredContact = params.confirmation_type === 'none' ? undefined : params.confirmation_type;
      
      // Use enriched context for location/provider if not explicitly provided
      let resolvedLocationId = params.location_id;
      if (!resolvedLocationId && params.location_name) {
        resolvedLocationId = findLocationByName(params.location_name);
      }
      if (!resolvedLocationId && enrichedContext?.lastLocationSeen) {
        resolvedLocationId = findLocationByName(enrichedContext.lastLocationSeen);
      }
      
      let resolvedProviderId = params.provider_id;
      if (!resolvedProviderId && params.provider_name) {
        resolvedProviderId = findProviderByName(params.provider_name);
      }
      if (!resolvedProviderId && enrichedContext?.lastProviderSeen) {
        resolvedProviderId = findProviderByName(enrichedContext.lastProviderSeen);
      }

      const requestTypeName = getRequestTypeName(params.request_type_id);
      const requestReasonName = getRequestReasonName(params.request_reason_id);
      
      const ticketSubject = params.subject || `${requestTypeName}: ${requestReasonName}`;
      
      // Build schedule context section for ticket if we have enriched data
      const scheduleSection: string[] = [];
      if (enrichedContext?.patientFound) {
        scheduleSection.push('--- Patient History (from schedule) ---');
        if (enrichedContext.lastVisitDate) {
          scheduleSection.push(`Last Visit: ${enrichedContext.lastVisitDate}`);
        }
        if (enrichedContext.lastProviderSeen) {
          scheduleSection.push(`Last Provider: ${enrichedContext.lastProviderSeen}`);
        }
        if (enrichedContext.lastLocationSeen) {
          scheduleSection.push(`Last Location: ${enrichedContext.lastLocationSeen}`);
        }
        if (enrichedContext.upcomingAppointments?.length > 0) {
          const nextAppt = enrichedContext.upcomingAppointments[0];
          scheduleSection.push(`Next Appointment: ${nextAppt.date} at ${nextAppt.location} with ${nextAppt.provider}`);
        }
        if (enrichedContext.patientData?.email) {
          scheduleSection.push(`Email on file: ${enrichedContext.patientData.email}`);
        }
        if (enrichedContext.patientData?.cellPhone) {
          scheduleSection.push(`Cell on file: ${enrichedContext.patientData.cellPhone}`);
        }
        scheduleSection.push('---');
      }
      
      const fullDescription = [
        gaveUpOnRequired ? `⚠️ NEEDS HUMAN REVIEW — could not complete on the call. Missing: ${params.unresolved_info!.trim()}` : null,
        `Subject: ${ticketSubject}`,
        `Request Type: ${requestTypeName}`,
        `Request Reason: ${requestReasonName}`,
        `Priority: ${params.priority}`,
        params.location_name ? `Location: ${params.location_name}` : null,
        params.provider_name ? `Provider: ${params.provider_name}` : null,
        '',
        'Details:',
        params.description,
        '',
        ...scheduleSection,
      ].filter(Boolean).join('\n');

      try {
        // Build full patient name for simplified endpoint
        const patientFullName = params.middle_initial 
          ? `${params.first_name} ${params.middle_initial}. ${params.last_name}`
          : `${params.first_name} ${params.last_name}`;

        // Map confirmation_type to simplified endpoint format
        const contactMethodMap: Record<string, 'phone' | 'sms' | 'email'> = {
          'phone': 'phone',
          'text': 'sms',
          'email': 'email',
        };
        const preferredContactSimplified = params.confirmation_type && params.confirmation_type !== 'none'
          ? contactMethodMap[params.confirmation_type] || 'phone'
          : 'phone';

        // Use NEW SIMPLIFIED ENDPOINT - more reliable, all mapping done server-side
        const result = await SyncAgentService.submitSimplifiedTicket({
          patientFullName,
          patientDOB: params.date_of_birth, // Any format - API handles parsing
          reasonForCalling: fullDescription, // Full description becomes the reason
          preferredContactMethod: preferredContactSimplified,
          patientPhone: callbackNormalized,
          patientEmail: params.email,
          lastProviderSeen: params.provider_name || undefined,
          locationOfLastVisit: params.location_name || undefined,
          additionalDetails: ticketSubject,
          callSid,
          callerPhone,
          agentUsed: 'answering-service',
          callStartTime: new Date().toISOString(),
        });

        if (result.success) {
          console.log(`[${agentTag}] ✓ Ticket created: ${result.ticketNumber} for ${departmentName}`);
          
          // Write caller name back to call metadata so it is persisted at call-end
          const resolvedName = [params.first_name, params.last_name].filter(Boolean).join(' ').trim();
          if (resolvedName && callId) {
            const callMeta = callMetadataForDB.get(callId);
            if (callMeta && !callMeta.callerName) {
              callMeta.callerName = resolvedName;
            }
          }

          // Log any lookup warnings
          if (result.lookupWarnings && result.lookupWarnings.length > 0) {
            console.warn(`[${agentTag}] Lookup warnings: ${result.lookupWarnings.join(', ')}`);
          }
          
          return {
            success: true,
            ticketNumber: result.ticketNumber,
            department: departmentName,
            message: `Ticket ${result.ticketNumber} created for ${departmentName}`,
          };
        } else {
          // Handle missing fields from simplified endpoint
          if (result.error?.includes('Missing required information')) {
            console.warn(`[${agentTag}] Ticket validation failed: ${result.error}`);
            return {
              success: false,
              validationError: true,
              missingFields: [result.error],
              message: result.message || 'Please collect missing information and try again.',
            };
          }
          
          // Other API errors
          console.error(`[${agentTag}] Ticket creation failed:`, result.error);
          return {
            success: false,
            error: result.error || 'Unknown error',
            message: `Ticket creation failed: ${result.error || 'Unknown error'}. Please try again.`,
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[${agentTag}] create_ticket exception:`, errorMessage);
        return {
          success: false,
          error: errorMessage,
          message: `Ticket creation error: ${errorMessage}. Please try again.`,
        };
      }
    },
  });

  const terminateCallTool = recordedTool({
    name: "terminate_call",
    description: `Terminate the call server-side immediately. Use this to actually end the call — do NOT rely solely on verbal goodbye.

USE FOR:
- ghost_call: caller not responding after 2 prompts
- robot_call: IVR bleed-through or automated system detected
- spam: spam/telemarketing detected
- max_turns_exceeded: call has gone on too long with no resolution

Always say a brief goodbye phrase BEFORE calling this tool.`,
    parameters: z.object({
      reason: z
        .enum(["ghost_call", "robot_call", "spam", "max_turns_exceeded"])
        .describe("Reason for terminating the call"),
    }),
    execute: async (params) => {
      console.log(`[${agentTag}] terminate_call - reason: ${params.reason}, callId: ${callId || 'unknown'}`);
      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          console.error(`[${agentTag}] terminate_call - missing OPENAI_API_KEY`);
          return { success: false, error: "missing_api_key" };
        }
        if (!callId) {
          console.error(`[${agentTag}] terminate_call - missing callId`);
          return { success: false, error: "missing_call_id" };
        }
        const response = await fetch(
          `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        if (response.ok) {
          console.log(`[${agentTag}] terminate_call ✓ Call ${callId} terminated (${params.reason})`);
          return { success: true, reason: params.reason };
        } else {
          const text = await response.text().catch(() => "");
          console.warn(`[${agentTag}] terminate_call ⚠️ Hangup returned ${response.status}: ${text}`);
          return { success: false, status: response.status };
        }
      } catch (error) {
        console.error(`[${agentTag}] terminate_call error:`, error);
        return { success: false, error: String(error) };
      }
    },
  });

  const agent = new RealtimeAgent({
    name: "Overflow Answering Service Agent",
    handoffDescription: "Handles daytime overflow calls for Optical, Tech Support, and Surgery Coordination",
    instructions: buildSystemPrompt(metadata, scheduleContext, callerMemory),
    tools: [
      lookupScheduleTool,
      checkOpenTicketsTool,
      classifyRequestTool,
      createTicketTool,
      terminateCallTool,
    ],
  });

  console.log(`[${agentTag}] ✓ Agent created v${answeringServiceAgentConfig.version} with tools:`, [
    "lookup_schedule",
    "check_open_tickets",
    "classify_request",
    "create_ticket",
  ]);

  return agent;
}
