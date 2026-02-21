import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { getPacificTimeContext, formatPhoneLast4, formatPhoneForSpeech } from '../utils/timeAware';
import { scheduleLookupService, PatientScheduleContext } from '../services/scheduleLookupService';
// LAZY IMPORT: SyncAgentService is loaded dynamically inside tool handlers to prevent
// module initialization errors during agent instantiation (ticketingApiClient validation)
import { CallerMemoryService, CallerMemory } from '../services/callerMemoryService';
import { storage } from '../../server/storage';
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
  
  const mmddyyyy = normalized.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](19\d{2}|20\d{2}|\d{2})/);
  if (mmddyyyy) {
    const year = expandTwoDigitYear(mmddyyyy[3]);
    const month = mmddyyyy[1].padStart(2, '0');
    const day = mmddyyyy[2].padStart(2, '0');
    return { month, day, year, iso: `${year}-${month}-${day}` };
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
}

export const answeringServiceAgentConfig = {
  slug: "answering-service",
  name: "Overflow Answering Service Agent",
  description: "Handles daytime overflow calls for Optical, Tech Support, and Surgery Coordination departments.",
  version: "3.1.0",
  greeting: "Thank you for calling Azul Vision. I can take a message and get it to the right team. How may I help you?",
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
    
    parts.push('\n**VERIFICATION STRATEGY:**');
    parts.push('- You already have patient data from phone lookup');
    parts.push('- Just ask: "Can I confirm your name and date of birth?" (don\'t ask for full details)');
    parts.push('- If they confirm, use the data above for the ticket');
    parts.push('- Only ask for missing fields (like email if not on file)');
    parts.push('- You CAN answer questions about their appointments using this information');
    scheduleContextSection = parts.join('\n');
  }

  let callerMemorySection = '';
  if (callerMemory) {
    const parts: string[] = ['\n===== CALLER MEMORY ====='];
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

  return `You are the OVERFLOW ANSWERING SERVICE for Azul Vision. VERSION: ${answeringServiceAgentConfig.version}

===== CONTEXT =====
This is a DAYTIME overflow call - the patient was on hold for 3+ minutes and got transferred to you.
You are helping during business hours, so staff WILL call back TODAY (not next business day).
Your ONLY job is to capture caller information and create a ticket for the appropriate department.

${timeContext}

===== CALLBACK NUMBER =====
${callbackPhoneSection}
${scheduleContextSection}
${callerMemorySection}

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
- Transfer to a human (there's no handoff in this system)

===== CONVERSATION FLOW =====

**STEP 1 - UNDERSTAND THE REQUEST**
Listen carefully to what they need. Key questions:
- What brings you in today?
- Is this for glasses/contacts, surgery, or test results?

**STEP 2 - CHECK FOR DUPLICATES**
Call check_open_tickets to see if they have pending tickets.
If yes, acknowledge: "I see you have a pending request from [date]. Are you calling about the same issue?"

**STEP 3 - QUICK IDENTITY CONFIRMATION**
IF you already have patient data from phone lookup:
- Just say: "I can see you're calling from our records. Can I confirm you're [First Name Last Name], date of birth [Month Day, Year]?"
- If confirmed, you already have: name, DOB, phone, location, provider, and possibly email
- Only ask for what's MISSING (usually nothing or just email for confirmation)

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

**STEP 4 - GET THE DETAILS**
Ask what they need help with - be thorough. Good prompts:
- "Tell me more about [issue] so I can pass along the right information"
- "Is there anything else you'd like me to include in the message?"

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

===== HARD RULES =====
1. ⚠️ TICKET BEFORE CONFIRM: You MUST call create_ticket and receive success=true BEFORE saying "I've passed your message" or any confirmation. NEVER assume a ticket was created - verify the tool response.
2. ⚠️ LOOKUP BEFORE CLAIMING NO RECORDS: When caller asks about appointments and you don't have their data from phone lookup, you MUST call lookup_schedule with their name+DOB BEFORE saying "I wasn't able to find your records". NEVER claim records don't exist without calling the tool first.
3. LANGUAGE LOCK: 
   - ⚠️ ALWAYS greet in ENGLISH first - even if patient name appears Asian, Hispanic, or foreign
   - NEVER assume language from patient name - wait to HEAR the caller speak
   - Detect language from caller's FIRST substantive spoken response
   - Once detected (Spanish, English, Vietnamese, etc.), STAY in that language for the ENTIRE call
   - Do NOT switch languages mid-conversation even if you hear fragments in other languages
   - If genuinely unclear after caller speaks, ask ONCE: "Would you prefer English or Spanish?"
   - Audio noise or unclear speech does NOT mean language change
3. ONE question at a time - never stack questions
4. NEVER say "Is that correct?" - just proceed
5. NEVER narrate your actions ("creating a ticket", "processing")
6. Always check for open tickets BEFORE creating new ones
7. Capture as much detail as possible in the description
8. Be warm, professional, and efficient

===== GHOST CALL DETECTION =====
If caller is not engaging after 2 prompts:
- Single syllables only: "mm", "uh", "ok" with no actual request
- No response to "How can I help you?"
- Random noise or unclear audio only

PROTOCOL:
1. First unclear: "How can I help you today?"
2. Second unclear: "I'm having trouble hearing you. Please call back if you need assistance."
3. END the call - do NOT create a ticket for ghost calls
4. Do NOT keep the call running for minutes waiting

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
${buildCompactLocationReference()}`;
}

export async function createAnsweringServiceAgent(
  handoffToHuman: () => Promise<void>,
  metadata: AnsweringServiceMetadata,
): Promise<RealtimeAgent> {
  const { callId, callerPhone, callLogId, callSid } = metadata;
  const agentTag = 'Answering-Service';

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

  const lookupScheduleTool = tool({
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

  const checkOpenTicketsTool = tool({
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

  const classifyRequestTool = tool({
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

  const createTicketTool = tool({
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
      location_name: z.string().optional().describe('Location name from patient data or conversation (e.g., "West Covina")'),
      provider_name: z.string().optional().describe('Provider name from patient data or conversation (e.g., "Dr. Logan")'),
      email: z.string().optional().describe('Patient email for confirmation'),
      confirmation_type: z.enum(['text', 'email', 'phone', 'none']).optional().describe('How patient wants confirmation (text, email, phone, or none)'),
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
        `Subject: ${ticketSubject}`,
        `Request Type: ${requestTypeName}`,
        `Request Reason: ${requestReasonName}`,
        `Priority: ${params.priority}`,
        params.location_name ? `Location: ${params.location_name}` : (enrichedContext?.lastLocationSeen ? `Location: ${enrichedContext.lastLocationSeen}` : null),
        params.provider_name ? `Provider: ${params.provider_name}` : (enrichedContext?.lastProviderSeen ? `Provider: ${enrichedContext.lastProviderSeen}` : null),
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
          lastProviderSeen: params.provider_name || enrichedContext?.lastProviderSeen,
          locationOfLastVisit: params.location_name || enrichedContext?.lastLocationSeen,
          additionalDetails: ticketSubject,
          callSid,
          callerPhone,
          agentUsed: 'answering-service',
          callStartTime: new Date().toISOString(),
        });

        if (result.success) {
          console.log(`[${agentTag}] ✓ Ticket created: ${result.ticketNumber} for ${departmentName}`);
          
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

  const agent = new RealtimeAgent({
    name: "Overflow Answering Service Agent",
    handoffDescription: "Handles daytime overflow calls for Optical, Tech Support, and Surgery Coordination",
    instructions: buildSystemPrompt(metadata, scheduleContext, callerMemory),
    tools: [
      lookupScheduleTool,
      checkOpenTicketsTool,
      classifyRequestTool,
      createTicketTool,
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
