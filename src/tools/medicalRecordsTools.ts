/**
 * The tools a Medical Records agent needs, and nothing else.
 *
 * WHAT IS DIFFERENT FROM THE OTHER QUEUES
 *
 *   Optical hard-requires a LOCATION, because one optician per office is the
 *   assignment rule. Tech Support asks for the PRESCRIBER, because somebody has
 *   to sign a prescription. Medical Records turns on two different facts:
 *
 *     WHO IS ASKING     a patient, a clinic, a health plan, an attorney
 *     WHERE IT GOES     a fax number, an office, an address, or the patient
 *
 *   Those two decide the paperwork, and both are routinely lost between the
 *   call and the ticket. Neither is a gate — a records request that arrives
 *   needing a callback is recoverable; a caller turned away is not.
 *
 * WHAT THIS AGENT MUST NOT DO
 *
 *   Release of records requires a signed authorization. Staff say so inside
 *   these tickets — "Please advise the patient that a signed Auth for Release
 *   of Medical Records is required". The agent takes the request and says the
 *   records team will follow up with what is needed. It does NOT quote the
 *   requirement as procedure, does not promise anything will be sent by any
 *   date, and never reads a record back to anyone.
 *
 *   OPEN QUESTION FOR THE OPERATOR, deliberately not invented here: should the
 *   agent proactively tell a caller an authorization form is coming? The
 *   ticket text shows staff doing it, which is evidence of practice but not an
 *   instruction to an agent.
 *
 * NO HANDOFF. Operator ruling 2026-08-12: only PCP and Scheduling transfer.
 */
import { registerTool, missing, refuseDob, dobRefusalCopy, type ToolResult } from './registry';
import { str, isTwilioCallSid, normalizePhone } from './sharedPatientTools';
import { decideDobEscape, dobStatusNote, dobEscapeMarker, type DobStatus } from './dobEscape';
import { createTicketDurable, postFailureToolResult } from '../services/durableTicketFiling';
import { verifiedDobFor, verifiedIdentityFor } from './verifiedIdentity';
import { gateRefusalsSoFar, noteGateRefusal, noteCallFact, callFactNoted } from './gateAttempts';

// ---------------------------------------------------------------- what kind

/**
 * HOW OFTEN THIS LINE MAY ASK BEFORE IT FILES ANYWAY.
 *
 * Operator, 2026-09-27, approving the records-line review's points 2 and 3:
 * *"go ahead and flip records to the runtime and the other 5 points."*
 *
 * Measured over 09-08..09-25 on the records line (RECORDS-LINE-REVIEW-20260927):
 * 21 real conversations were refused by this tool and never filed — eleven
 * for a NAME (`first_name`+`last_name` were `required`, so `validateInput`
 * refused before the handler could look at anything, and there was no escape
 * of any kind), five for the on-clock `deliver_to`/`date_range` gate (whose
 * only exit, `on_clock_ask_exhausted`, was opt-in and PCP-only by design),
 * one for a date of birth (whose escape already existed and was working).
 * Twenty of the twenty-one lasted ninety seconds or more. On the old core
 * nothing sweeps them up afterwards.
 *
 * ONE is a judgement, and it is the same one `decideDobEscape` made on
 * 2026-09-04 and `RESOLVE_ASK_LIMIT` made on 2026-09-10: the tool asks, the
 * caller answers or does not, and the second invocation files with the gap
 * written on the ticket rather than refusing again. The measured shape on
 * these lanes is that the second invocation often never comes at all (42 of
 * 75 refusals were the last tool event of their call), which is the
 * argument for the runtime's teardown sweep, not for a second ask here.
 *
 * Keyed on the CallSid through `gateAttempts`, so a sentinel or missing SID
 * keeps the old ask-every-time behaviour rather than sharing a counter
 * across calls.
 */
export const RECORDS_ASK_LIMIT = 1;
const RECORDS_TOOL = 'file_records_ticket';
const PATIENT_NAME_ASK = 'patient_name';
const ON_CLOCK_ASK = 'on_clock_fields';
const FORM_EMAIL_ASK = 'form_email';
const FORM_CHANNEL_ASK = 'form_channel';
/** Per-call latch: a records request has been filed on this call, so a re-send has something to re-send. */
const RECORDS_FILED_FACT = 'records_ticket_filed';

/**
 * THE FORM AT CALL TIME — owner, 2026-09-27.
 *
 * *"Any patient that is requesting their records should be redirected directly
 * to the digital form … We can log the records in the medical records as
 * Pending Auth so we can track it but it shouldn't start the clock and when he
 * does sign the auth it should attach right to that original request."*
 *
 * So for a PATIENT (or personal representative) who takes the link, this tool
 * files the request as `pending_authorization` — logged and trackable, off the
 * clock — and sends `formChannel`, which makes the ticketing app text or email
 * the signing link in the same request that opens the case. The signed form
 * completes that case and starts the clock. Destination and date range come
 * from the form, so the on-clock gate does not ask for them when a link is
 * going out. Third parties are untouched: no link, no form, no question added.
 *
 * `WEBSITE_DIRECTIONS` is the third channel — the caller with no mobile and no
 * email hears where to find the form. One constant, so the spoken domain can
 * be corrected in one place.
 */
export const WEBSITE_DIRECTIONS =
  'go to azul vision dot com, click Useful Links, then Medical Records, and fill out the request form there';
export type FormChannel = 'sms' | 'email' | 'verbal' | 'declined';

/**
 * The staff note when the ticket files without a patient name. Goes in
 * `callData.transcript` — the ticket's own call-metadata column — and NEVER
 * the description, which becomes the body of a patient-facing SMS.
 */
export const NAME_NOT_CAPTURED_NOTE =
  'PATIENT NAME NOT CAPTURED — the caller was asked once and the request was filed without one. ' +
  'Take the name from the call recording before matching this to a chart.';

registerTool({
  name: 'classify_records_request',
  layer: 'agent',
  timeoutMs: 1000,
  description:
    "Work out which kind of records request this is, in the practice's own " +
    "categories. Call it with the caller's own words once you understand what they " +
    'need, and before filing. It knows the difference between a copy for the ' +
    'patient, records going to another doctor, records for a health plan or an ' +
    'attorney, a letter or form, and an in-person review — so it always returns ' +
    'something. Pass its request_reason_id to file_records_ticket.',
  input_schema: {
    type: 'object',
    properties: {
      request_description: {
        type: 'string',
        description:
          "What the caller wants, in their words. e.g. 'I need my records from " +
          "the July visit faxed to Dr. Warn's office'.",
        askAs: 'Can you tell me a bit more about what you need?',
      },
    },
    required: ['request_description'],
  },
  handler: async (input): Promise<ToolResult> => {
    const { classifyRecordsRequest, MEDICAL_RECORDS_DEPARTMENT_ID } = await import(
      './medicalRecordsTaxonomy'
    );
    const { classification, isCatchAll } = classifyRecordsRequest(str(input.request_description));

    return {
      success: true,
      classified: !isCatchAll,
      department_id: MEDICAL_RECORDS_DEPARTMENT_ID,
      request_type: classification.requestType,
      request_type_id: classification.requestTypeId,
      request_reason: classification.requestReason,
      request_reason_id: classification.requestReasonId,
      ...(isCatchAll
        ? {
            // For the model, not the caller — `message` is what gets spoken.
            fix:
              'Nothing matched, so this is filed as "Other - See Description". That is a ' +
              'real category, not a guess — but it means the description is the only thing ' +
              'the team has. Make sure it says what they actually asked for, and who is ' +
              'asking.',
          }
        : {}),
    };
  },
});

// ---------------------------------------------------------------- file it

registerTool({
  name: 'file_records_ticket',
  layer: 'agent',
  timeoutMs: 30000,
  description:
    'File the request for the medical records team. This is the last step of the ' +
    "call. It needs the patient's name, date of birth and a callback number. Also " +
    'get WHO IS ASKING (the patient themselves, another doctor\'s office, a health ' +
    'plan, an attorney) and WHERE IT SHOULD GO (a fax number, an office, or to the ' +
    'patient) — those two decide what paperwork the team needs. Pass the ' +
    'request_reason_id from classify_records_request.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string', description: "Patient's first name.", askAs: 'May I please have the patient\'s first name?' },
      last_name: { type: 'string', description: "Patient's last name.", askAs: 'May I please have the last name?' },
      /**
       * LEAD THE ASK, AND ALWAYS SEND IT BACK. Two separate 2026-09-03 findings
       * in one field; see sharedPatientTools for the operator's wording.
       *
       * The ORDER in the question is the guard — *"if you just say can I have
       * your date of birth, people give it to you in any format they want"*.
       *
       * The description is the other half. dobShape went live at 23:18 and the
       * first three filing calls after it all recorded "(none)": the model was
       * not sending this field AT ALL. Those three filed anyway because
       * lookup_patient had made a certain match and the handler fell back to the
       * verified record — which is exactly why the loss looked random. It stays
       * out of `required` (validateInput refuses before the handler, and that
       * would kill the fallback), so the description is where it gets said.
       */
      date_of_birth: { type: 'string', description: 'What the caller said, exactly as they said it. ALWAYS pass this when they have given it — leaving it out is what refuses the ticket.', askAs: 'And may I please have the date of birth, starting with the month, then the day, then the year?' },
      callback_number: { type: 'string', description: 'Best number to reach the caller.', askAs: 'What is the best number to reach you?' },
      request_description: { type: 'string', description: 'What they need, in their words.', askAs: 'What records do you need?' },
      request_reason_id: { type: 'string', description: 'From classify_records_request.' },
      requester: {
        type: 'string',
        description:
          'REQUIRED. Who is asking, in their own words — the patient themselves, a ' +
          'relative or someone with power of attorney, another doctor\'s office, a health ' +
          'plan, an attorney or records company. Include the organisation name when there ' +
          'is one. This decides whether a statutory records clock applies, so it cannot ' +
          'be guessed or left out.',
        askAs: 'And just so I route this correctly — are you the patient yourself, or calling on someone\'s behalf?',
      },
      /**
       * THE SAME ANSWER, STATED RATHER THAN INFERRED — added 2026-09-13.
       *
       * `requester` is prose and `classifyRequester` reads it. That works when
       * a caller introduces themselves, and it is the ONLY input a caller-facing
       * lane can offer. It does not work for a lane that already KNOWS: PCP
       * holds `callerIsThePatient` and `statedRelationship` on its director,
       * and its one attempt to express that knowledge as prose produced
       * "…calling on the patient's behalf", which matched SPEAKING_FOR_ANOTHER
       * and resolved to `other` — a family member taken OFF a clock that
       * applies to them. Round-tripping a known fact through a text classifier
       * is what broke; this is the field that stops it.
       *
       * NEVER LETS A REQUEST OFF THE CLOCK. See `resolveRequesterType`: a
       * stated type is trusted except where it would move a request the prose
       * puts ON the clock to one that is off it. That asymmetry is the
       * taxonomy's own — being wrongly on costs a self-imposed deadline, being
       * wrongly off is a CAP violation on the obligation the CAP polices.
       */
      requester_type: {
        type: 'string',
        description:
          'OPTIONAL, and only when you actually know rather than infer: patient | ' +
          'personal_representative | provider | health_plan | legal | other. Send it when the ' +
          'caller has told you plainly who they are. Leave it out and it is read from `requester`.',
      },
      /**
       * THE ASK IS SPENT — file with the gap rather than refuse. See the gate
       * in the handler for why, and for why it is opt-in. Operator, 2026-09-13.
       */
      on_clock_ask_exhausted: {
        type: 'boolean',
        description:
          'Only for a lane that cannot ask for a delivery destination or date range. Files the ' +
          'case with the gap recorded on it instead of refusing. Do not set this to skip a question ' +
          'you are able to ask.',
      },
      deliver_to: {
        type: 'string',
        description: 'Where it should go: a fax number, an office and city, an address, or "to the patient".',
        askAs: 'Where should these be sent?',
      },
      date_range: {
        type: 'string',
        description: 'Which visits or dates they need, if they said.',
        askAs: 'Which dates do you need covered?',
      },
      location: { type: 'string', description: 'The office they attend, if it came up.' },
      provider: { type: 'string', description: 'The doctor they saw, if it came up.' },
      email: {
        type: 'string',
        description: 'The email address, spelled out, when the patient chose to receive the form by email.',
        askAs: "What's the email address? Please spell it out for me.",
      },
      form_channel: {
        type: 'string',
        description:
          'ONLY when the requester is the patient or their personal representative, after ' +
          'classify_records_request confirmed a records request: how they want the signing link — ' +
          '"sms" (a mobile that receives texts), "email" (then send `email` too), "verbal" (no mobile ' +
          'or email — you read them the website directions), or "declined". Never for a provider, ' +
          'health plan, attorney or records company.',
        askAs:
          'I can send you a short link to finish and sign this request — is this a mobile number ' +
          'that receives texts, or would you rather have it by email?',
      },
      call_sid: { type: 'string', description: 'The call id, so a retry cannot double-file.' },
      caller_phone: { type: 'string', description: 'The number they called from.' },
      dialed_number: { type: 'string', description: 'The number they dialled.' },
    },
    /**
     * `date_of_birth` is NOT in this list, and the gate on it is unchanged.
     *
     * `validateInput` refuses before the handler runs, so while it sat here the
     * handler could never consult the record `lookup_patient` had already
     * matched — and the caller was asked for a date of birth the process was
     * holding. 45 calls in the fourteen days to 2026-09-01 were refused for one
     * and ended with no ticket; on 23 of them the patient had already been
     * identified.
     *
     * The handler still refuses when it has neither the caller's answer nor a
     * verified record for that same name, in the same words as before.
     */
    /**
     * `first_name` and `last_name` LEFT this list on 2026-09-27. While they sat
     * here `validateInput` refused before the handler ran, so a call whose
     * patient had already been identified by `lookup_patient` was refused for
     * a name the process was holding, and a caller who would not give one was
     * refused for ever — eleven real conversations in fourteen business days,
     * none of them filed. The handler now asks ONCE and then files without.
     */
    required: ['callback_number', 'request_description', 'requester'],
  },
  handler: async (input): Promise<ToolResult> => {
    let first = str(input.first_name);
    let last = str(input.last_name);
    const dob = str(input.date_of_birth);
    const phone = str(input.callback_number);
    const description = str(input.request_description);
    const callSid = str(input.call_sid);

    /**
     * THE NAME: the record first, one ask second, the request regardless.
     *
     * 1. RULE ZERO — if `lookup_patient` established WHO this is on this call,
     *    the name is on file and nobody is asked for it. `verifiedIdentityFor`
     *    answers only a CERTAIN match (a phone candidate is refused by design,
     *    standing instruction 6), which is the same source `verifiedDobFor`
     *    already trusts for the date of birth two screens down.
     * 2. Otherwise the caller is asked ONCE, one field per question (RULE ZERO
     *    2b), and the refusal's `fix` tells the model this is the one ask.
     * 3. The next invocation files with no name and a staff note. A records
     *    request with a callback number and no name is workable; a caller
     *    turned away is not. The description never carries the note — it is
     *    an SMS body.
     */
    let nameNote: string | undefined;
    if (!first || !last) {
      const known = verifiedIdentityFor(callSid);
      if (known) {
        first = known.firstName;
        last = known.lastName;
        // No name in the log line: this is the one place a masked identifier
        // would still be the patient.
        console.info('[records] patient name taken from the verified record for this call');
      } else if (gateRefusalsSoFar(callSid, RECORDS_TOOL, PATIENT_NAME_ASK) >= RECORDS_ASK_LIMIT) {
        first = '';
        last = '';
        nameNote = NAME_NOT_CAPTURED_NOTE;
        console.warn(
          `[RECORDS] patient name not captured and the ask is spent — filing to Medical Records without one (${callSid || 'no sid'})`,
        );
      } else {
        noteGateRefusal(callSid, RECORDS_TOOL, PATIENT_NAME_ASK);
        const absent = [!first ? 'first_name' : null, !last ? 'last_name' : null].filter(
          (f): f is string => f !== null,
        );
        return missing(
          absent,
          !first ? "May I please have the patient's first name?" : 'May I please have the last name?',
          'Ask for the name ONCE, one field at a time. If they cannot or will not give it, call ' +
            'file_records_ticket again with everything else — it will file without a name and the ' +
            'records team will take it from the recording. Never refuse to file over a name.',
        );
      }
    }

    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      return missing(['callback_number'], 'I only caught part of that number — can I get all ten digits?');
    }
    /**
     * THE CEILING THAT WAS MISSING, NOT JUST THE WRONG VALUE SENT.
     *
     * A floor with no ceiling let a second number or an extension through as
     * a plausible-looking phone. Sending it (even normalized) would have
     * filed a ticket with a callback number nobody could reach — worse than
     * the loud 400 it replaces, and invisible in the ticket count. 90-day
     * distribution of real filed patient_phone digit lengths: 10 (180), 11
     * (1219), 12 (1 — an outlier, not evidence to widen this). 11 covers
     * >99.9% of real captures; refuse above it rather than guess.
     *
     * 11 digits not starting with 1 is refused too — normalizePhone() is
     * slice(-10), correctly loose for the lookup use it was written for, but
     * an 11-digit capture with a wrong leading digit (a mis-heard digit, a
     * stray keypress) would silently drop that digit and produce a
     * plausible, wrong, 10-digit number. Same failure shape as the raw
     * string this fix replaced, one digit narrower.
     */
    if (digits.length > 11 || (digits.length === 11 && digits[0] !== '1')) {
      return missing(
        ['callback_number'],
        "That's more digits than one phone number — can you give me just the callback number, without an extension or a second number?",
      );
    }

    const { MEDICAL_RECORDS_DEPARTMENT_ID, recordsReasonById, classifyRecordsRequest,
            classifyRequester, determineCapClock, resolveRequesterType } = await import('./medicalRecordsTaxonomy');

    // WHO IS ASKING IS HARD-REQUIRED ON THIS QUEUE, the way LOCATION is on
    // Optical — and for a stronger reason than assignment.
    //
    // Azul Vision is under a Corrective Action Plan with HHS OCR over late
    // medical records. A PATIENT's request runs on a statutory clock the
    // practice must report on; a health plan's or an attorney's does not.
    // Measured 2026-08-13: all 470 mr_cases rows are pathway 'roa_patient',
    // 421 of them minted by the voice agent, and NOT ONE has a requestor
    // captured. At least 77 are demonstrably third-party. Nothing downstream
    // can reconstruct this after the call ends, so the call is the only place
    // it can be got.
    const requesterRaw = str(input.requester);
    if (!requesterRaw) {
      return missing(
        ['requester'],
        'And just so I route this correctly — are you the patient yourself, or calling on someone\'s behalf?',
      );
    }
    const requesterType = resolveRequesterType(str(input.requester_type), classifyRequester(requesterRaw));
    const cap = determineCapClock(requesterType);

    // A CALLER WHO PRESSED THE WRONG OPTION IS NOT SENT AWAY — and is not
    // offered a records form either. Decided HERE, before the channel ask,
    // on the same words the redirect below reads, so the one question this
    // tool adds is never put to somebody who rang about an appointment.
    const { detectCrossQueue } = await import('./queueRouting');
    const redirect = detectCrossQueue(description, MEDICAL_RECORDS_DEPARTMENT_ID);

    // THE LINK, decided here so the on-clock gate below can stand down for it.
    // Only an on-clock requester ever gets one; a third party's `form_channel`
    // is ignored rather than refused, because the model may send it and the
    // answer is simply "no form for you".
    let formChannelRaw = str(input.form_channel).toLowerCase();

    /**
     * THE CHANNEL IS ASKED BY THE TOOL, NOT LEFT TO THE PROMPT — v79.
     *
     * The records lane's first business day on the runtime, 2026-09-28: the
     * prompt told the model to offer the link (RULE ZERO 2c, the format in
     * the question), and on the four real patient calls of the first hour it
     * did not — every create-ticket POST answered `form: {requested:false}`,
     * every patient case opened ON the fifteen-day clock with no signing link,
     * and the transcripts carry no funnel line at all. What the model DID do
     * was file with no channel, take the on-clock refusal for destination and
     * dates, and walk down the old path: a refusal is a question, and the
     * question it was asked was the wrong one. So the FIRST refusal on a
     * patient's request with no channel stated is now the channel question
     * itself, in the prompt's own words (askAs on the schema), and only a
     * spoken "verbal" or "declined" reaches the destination-and-dates gate.
     *
     * ONCE, keyed on the call like every other ask here (`RECORDS_ASK_LIMIT`).
     * A second invocation still carrying no channel is the model failing to
     * relay the answer, not the caller failing to give one — and the
     * fallback is the one the email ask already uses: a text to the callback
     * number, which a landline turns into a delivery failure on the case for
     * the staff button to pick up. The alternative — an on-clock case with no
     * link — is the thing the operator called unacceptable (2026-09-28,
     * *"these are cap cases"*).
     *
     * Not asked of a third party (no form for them), not asked when the
     * request is redirected out of Medical Records (no form on a ticket that
     * left), NOT asked of a lane that has declared it cannot ask
     * (`on_clock_ask_exhausted` — PCP, which sets it on every records filing
     * because it collects neither a destination nor a range; its patients
     * get the form from the app's backfill, not from a question the lane
     * has no place to put), and a sentinel CallSid asks every time —
     * gateAttempts' own rule.
     */
    const askExhausted = input.on_clock_ask_exhausted === true;
    const channelStated =
      formChannelRaw === 'sms' || formChannelRaw === 'email' ||
      formChannelRaw === 'verbal' || formChannelRaw === 'declined';
    if (cap.onClock && !redirect && !channelStated && !askExhausted) {
      if (gateRefusalsSoFar(callSid, RECORDS_TOOL, FORM_CHANNEL_ASK) >= RECORDS_ASK_LIMIT) {
        console.warn(
          `[RECORDS] form channel not stated after one ask — sending the link by text to the ` +
            `callback number rather than opening an on-clock case with no link (${callSid || 'no sid'})`,
        );
        formChannelRaw = 'sms';
      } else {
        noteGateRefusal(callSid, RECORDS_TOOL, FORM_CHANNEL_ASK);
        return missing(
          ['form_channel'],
          'I can send you a short link to finish and sign this request — is this a mobile number ' +
            'that receives texts, or would you rather have it by email?',
          'Ask exactly that, ONCE. Then call file_records_ticket again with form_channel "sms", ' +
            'or "email" plus the address spelled out, or "verbal" if they have neither or decline ' +
            'the link. Do not ask where the records should be sent or which dates — the form ' +
            'collects both.',
        );
      }
    }

    let formChannel: 'sms' | 'email' | undefined =
      cap.onClock && (formChannelRaw === 'sms' || formChannelRaw === 'email')
        ? (formChannelRaw as 'sms' | 'email')
        : undefined;
    const spokenDirections = cap.onClock && formChannelRaw === 'verbal';
    if (formChannel === 'email' && !str(input.email)) {
      if (gateRefusalsSoFar(callSid, RECORDS_TOOL, FORM_EMAIL_ASK) >= RECORDS_ASK_LIMIT) {
        // Asked once and no address came. A text to the callback number is the
        // fallback the caller can still act on; if it is a landline the delivery
        // failure lands on the case and the staff button is the fallback.
        formChannel = 'sms';
      } else {
        noteGateRefusal(callSid, RECORDS_TOOL, FORM_EMAIL_ASK);
        return missing(
          ['email'],
          "What's the email address? Please spell it out for me.",
          'Ask ONCE and read it back. If they cannot give one, call file_records_ticket again with ' +
            'form_channel "sms" (or "verbal" if this is not a mobile).',
        );
      }
    }

    // ON THE CLOCK MEANS THE FIELDS ARE NOT OPTIONAL.
    //
    // Operator, 2026-08-13: "can we hard gate the records to require the
    // appropriate fields". For a patient right-of-access request the practice
    // must report on timing under the CAP, and an `mr_cases` row is built from
    // exactly these: what records, over what dates, delivered how. A case
    // opened without them starts a statutory clock that nobody can actually
    // work, which is the worst of both.
    //
    // GATED ONLY WHEN THE CLOCK APPLIES. A health plan or an attorney asking
    // for a chart is not on the clock, and refusing their request over a
    // missing date range would turn a reporting requirement into a reason to
    // turn callers away — the thing this queue exists not to do.
    //
    // The gate is on PRESENCE, not content. "All of it" and "I'm not sure" are
    // both valid answers; the agent asks once, the caller says something, it
    // files. What is not acceptable is silence in a column the CAP report reads.
    // THE FORM COLLECTS DESTINATION AND DATES, better than the phone does
    // (owner, 2026-09-27, doc 17 decision 2), so the gate stands down when a
    // link is going out. A caller who declines the link still gets both asks.
    if (cap.onClock && !formChannel) {
      const gaps: string[] = [];
      if (!str(input.deliver_to)) gaps.push('deliver_to');
      if (!str(input.date_range)) gaps.push('date_range');
      /**
       * THE UNASSIGNED EXIT, FOR A RECORDS CASE. Operator ruling, 2026-09-13,
       * choosing this over adding the question to the PCP lane.
       *
       * The gate below is his own (2026-08-13, *"can we hard gate the records
       * to require the appropriate fields"*) and it is right for a lane that
       * can ask: an `mr_cases` row with no destination starts a statutory clock
       * nobody can work. But PCP has never collected a date range, so applied
       * there the gate does not produce an answer — it produces a REFUSAL, and
       * the request stays in department 18 where Medical Records never sees it.
       * Measured: 54 PCP records tickets in department 18 against 2 in
       * department 16, both of those predating the route that was supposed to
       * fix it.
       *
       * So a caller that has nothing left to ask sets this flag and the request
       * lands in department 16 with the gap written on it, rather than not
       * landing at all. Exactly the shape of optical's `routingAskExhausted`
       * (#288): take the request unassigned and let a human triage it, because
       * a row a clerk can chase beats a row in the wrong queue.
       *
       * OPT-IN, and until 2026-09-27 the records lane was untouched by it: that
       * lane CAN ask and does, so only a caller that said it had exhausted the
       * ask got the exit. The records lane now has its own exit — the
       * per-call ask below — and this flag stays for PCP, which never asks.
       *
       * AND IT FIRES ON THE FIRST INVOCATION, not the second. That is the whole
       * lesson of `decideDobEscape` and of #291's Codex P1: an escape reachable
       * only on a retry is unreachable on these lanes, where 42 of 75 refusals
       * were the LAST tool event of their call. An escape that needs the model
       * to come back is not an escape.
       */
      /**
       * AND THE EXIT IS NO LONGER OPT-IN ON THIS LANE. Operator, 2026-09-27
       * (point 3 of the records-line review): five patients' own requests in
       * fourteen business days were refused here and never filed. The gate
       * still asks — once — and the next invocation files with the gap written
       * on the ticket in the same words the PCP exit uses, so a clerk chases
       * the destination instead of a request that never existed.
       */
      const onClockAskSpent = gateRefusalsSoFar(callSid, RECORDS_TOOL, ON_CLOCK_ASK) >= RECORDS_ASK_LIMIT;
      if (gaps.length && (askExhausted || onClockAskSpent)) {
        console.warn(
          `[RECORDS] on-clock fields not captured (${gaps.join(', ')}) and the ask is spent ` +
            `(${askExhausted ? 'caller flagged it' : 'asked once on this call'}) — ` +
            `filing to Medical Records with the gap recorded rather than refusing (${callSid || 'no sid'})`,
        );
      } else if (gaps.length) {
        noteGateRefusal(callSid, RECORDS_TOOL, ON_CLOCK_ASK);
        return missing(
          gaps,
          gaps.length === 2
            ? 'Two quick things so the records team can start on this — where should these be sent, and which dates do you need covered?'
            : gaps[0] === 'deliver_to'
              ? 'And where should these be sent — to you, or to an office?'
              : 'And which dates do you need covered? "Everything" is a fine answer.',
          'Ask ONCE. Whatever they answer — or if they cannot — call file_records_ticket again ' +
            'with everything you have; it will file with the gap noted for the records team.',
        );
      }
    }

    // The reason must be one of THIS department's, whatever we were handed.
    const named = input.request_reason_id ? Number(input.request_reason_id) : NaN;
    const cls =
      (Number.isFinite(named) ? recordsReasonById(named) : null) ??
      classifyRecordsRequest(description).classification;

    // Who is asking and where it goes are the two facts this queue turns on.
    // On their own lines so a records clerk reads them rather than hunting
    // through a paragraph for a fax number.
    const deliverTo = str(input.deliver_to);
    const dateRange = str(input.date_range);
    // The clock line goes FIRST. A records clerk opening this ticket should not
    // have to read to the bottom to learn whether it is CAP-reportable.
    const body = [
      `${cap.note}`,
      `\n\n${description}`,
      `\n\nRequested by: ${requesterRaw} [${requesterType}]`,
      /**
       * A GAP SAYS SO, IN THE PLACE THE ANSWER WOULD HAVE BEEN.
       *
       * These two lines used to vanish when empty, which is fine when the gate
       * guarantees they are filled — and is exactly wrong once the on-clock
       * exit above can file without them. A missing line reads as "not
       * applicable"; a clerk chasing nothing is how a case sits until the
       * statutory clock runs out.
       *
       * A MISSING DESTINATION SAYS SO WHETHER OR NOT THE CLOCK APPLIES, and
       * that is a change from the first version of this line — which read
       * "only spelled out when the clock applies, because that is when
       * somebody has to act on the absence."
       *
       * True while the only off-clock cases came from the records lane, which
       * asks. It stopped being true on 2026-09-14, when professional records
       * requests began reaching this queue from PCP: those are off the clock
       * by definition, PCP can run out of asks, and nobody can send a chart
       * anywhere without knowing where. An empty line reads as "not
       * applicable" and the case sits.
       *
       * The DATE RANGE below is deliberately still keyed on the clock. A plan
       * or a clinic usually wants one specific encounter, so a chase line for
       * a range nobody needs is noise on a ticket rather than a gap in it.
       *
       * Same wording as `ticketDeliveryNote`, so a staffer sees one phrase
       * whichever path filed the case.
       */
      deliverTo
        ? `\nSend to: ${deliverTo}`
        : formChannel
          ? '\nSend to: on the signed form (link sent during the call).'
          : '\nSend to: NOT CAPTURED — confirm with the requester before sending anything.',
      dateRange
        ? `\nDates needed: ${dateRange}`
        : formChannel
          ? '\nDates needed: on the signed form.'
          : cap.onClock ? '\nDates needed: NOT CAPTURED — confirm the range with the requester.' : '',
    ].join('');

    // Free text becomes the body of a patient-facing SMS on the other side. One
    // character outside GSM-7 turns a 160-character segment into 70 and makes
    // the message far more exposed to US carrier A2P filtering.
    const { sanitizeForSms } = await import('../services/gsm7');
    const cleanDescription = sanitizeForSms(body);
    if (cleanDescription.changed) {
      console.info('[Records] description normalised to GSM-7 before filing');
    }

    const { sanitizeProviderName, sanitizeLocationName } = await import(
      '../services/ticketFieldSanitizers'
    );
    const cleanProvider = sanitizeProviderName(str(input.provider)).value;
    const cleanLocation = sanitizeLocationName(str(input.location)).value;

    const { ticketingApiClient, lookupWasUnavailable } = await import(
      '../../server/services/ticketingApiClient'
    );
    const { normalizeDobParts } = await import('./dobParts');
    let parts = normalizeDobParts(dob);
    if (!parts) {
      /**
       * ASK ONCE, NOT TWICE. Operator instruction, 2026-09-01: *"if we do our
       * job and validate and pass the patient records along, you will not have
       * this issue."*
       *
       * `lookup_patient` found this caller — it does on 95% of queue calls —
       * and the service returned their date of birth with the match. Nothing
       * carried it here, so the agent asked for something the process already
       * held, and 45 calls in fourteen days ended with no ticket because the
       * caller could not answer. On 23 of those we already knew who they were.
       *
       * Only ever for the SAME NAME as the verified match, and only from a
       * match the lookup was certain about. See verifiedIdentity.ts.
       */
      const known = verifiedDobFor(callSid, first, last);
      parts = known ? normalizeDobParts(known) : null;
      if (parts) {
        // No name in the log line: this is the one place a masked identifier
        // would still be the patient.
        console.info('[records] date of birth taken from the verified record for this call');
      }
    }
    if (!parts) {
      /**
       * THE CALLER ALREADY ANSWERED — STOP DEPENDING ON THE MODEL TO RELAY IT.
       *
       * 2026-09-08, the queue lanes, one full business day: 75 substantive
       * calls hit this gate and 53 of them filed nothing. It is the single
       * biggest cause of a call producing no ticket, and the measurement says
       * the gate is not where it fails:
       *
       *  - On 75 of 75, the model called this tool with NO `date_of_birth`
       *    argument at all. `dobShape` reads "(none)" on every refusal, across
       *    surgery, tech and optical.
       *  - In 51 of the 75, the caller's own transcribed words contain a birth
       *    year or a month name. They answered the question that was asked.
       *  - In 42 of the 75 the refusal is the LAST TOOL CALL OF THE CALL, so
       *    the ask-once-then-file escape below never gets its second attempt.
       *    It is unreachable in the majority of cases.
       *
       * The two sources above both go through the model or the record. This
       * one does not: it is what the caller said on this call, taken from the
       * transcript the bridge was already keeping and nothing else could see.
       *
       * ONLY FROM THE TURN THAT ANSWERED THE QUESTION. A caller says surgery
       * dates and appointment dates too, and filing a wrong birthday is worse
       * than filing none — see spokenDob.ts for the adjacency rule and what it
       * still cannot catch.
       */
      const { spokenDobFor } = await import('./spokenDob');
      const heard = spokenDobFor(callSid);
      parts = heard ? normalizeDobParts(heard) : null;
      if (parts) {
        // The line names neither the value nor the patient, for the same
        // reason as the one above it.
        console.info('[records] date of birth taken from what the caller said on this call');
      }
    }
    /**
     * ASK ONCE, THEN FILE IT ANYWAY. Operator ruling 2026-09-04, and the same
     * ruling he gave for optical's office on 2026-09-01. The measurement that
     * settles it: the location gate has this escape and recovered 9 of 11; this
     * gate did not and recovered 0 of 23. See dobEscape.ts.
     */
    let dobStatus: DobStatus | null = null;
    if (!parts) {
      const escape = decideDobEscape(callSid, 'file_records_ticket', dob);
      if (escape.askAgain) {
        /**
         * The first refusal only, and it carries BOTH channels: `message` is
         * the coaching line the agent says, `fix` is what the model itself got
         * wrong. The two branches of `fix` need OPPOSITE corrections — telling
         * the model "ask the caller again" when it simply omitted the argument
         * is what built the loop.
         */
        const copy = dobRefusalCopy(dob);
        return refuseDob(callSid, first, last, copy.message, copy.fix);
      }
      dobStatus = escape.status;
      console.info(dobEscapeMarker('file_records_ticket', dobStatus, callSid));
    }

    const lookup =
      cleanProvider || cleanLocation
        ? await ticketingApiClient.lookupProviderAndLocation({
            ...(cleanProvider ? { providerName: cleanProvider } : {}),
            ...(cleanLocation ? { locationName: cleanLocation } : {}),
          })
        : // Nothing to look up. That is a ran-and-matched-nothing, not an
          // outage — say so explicitly so `lookupWasUnavailable` cannot read
          // a bare object as a failure.
          {
            success: true,
            outcome: 'no_match' as const,
            providerId: undefined,
            locationId: undefined,
            locationMatches: [],
            error: undefined,
          };

    /**
     * A LOOKUP THAT NEVER RAN IS NOT AN OFFICE THAT DOES NOT EXIST.
     *
     * `lookupProviderAndLocation` used to catch its own error and answer
     * `{success:false}` — the same shape as a name that matched nobody. Optical
     * read only `locationId`, collapsed the two, and on 2026-08-31 told 43
     * callers their real office did not exist; see `LookupOutcome` in
     * ticketingApiClient. This queue said nothing at all, which on a department
     * under a Corrective Action Plan with HHS OCR is its own problem: the
     * office and doctor a caller named were dropped, and the ticket looks
     * exactly like one where they were never asked.
     *
     * Nothing here refuses. Neither field is a gate on this queue — the module
     * header says so, and a records request that arrives needing a callback is
     * recoverable where a refused caller is not. What changes is that the loss
     * is visible: the caller's words still travel in `locationOfLastVisit` /
     * `lastProviderSeen`, the ids are omitted rather than sent null, this logs
     * loudly, and the priority is raised so the ticket is not filed away as
     * routine with a hole in it.
     *
     * NOT in the description. It carries the CAP clock line and the caller's
     * own words, and it becomes the body of a patient-facing SMS —
     * `docs/BACKEND_HANDOFF.md` lists annotating it under changes that made
     * things worse. There is no staff-notes field on `CreateTicketParams`.
     */
    const lookupUnavailable = lookupWasUnavailable(lookup);
    const lostToOutage =
      lookupUnavailable &&
      ((Boolean(cleanLocation) && !lookup.locationId) ||
        (Boolean(cleanProvider) && !lookup.providerId));
    if (lostToOutage) {
      console.error(
        `[records] ✗ LOOKUP UNAVAILABLE — filing ` +
          `'${cleanLocation || cleanProvider}' with no id. Cause: ${lookup.error ?? 'unknown'}`,
      );
    }

    // A CALLER WHO PRESSED THE WRONG OPTION IS NOT SENT AWAY.
    //
    // On this line the detector mostly stays quiet on purpose: a records
    // request names other departments' subjects constantly ("the notes from my
    // cataract surgery"), and queueRouting holds those here. What it still
    // catches is the genuinely different request — someone who reached records
    // and wants an appointment.
    // `redirect` was decided above the channel ask, on these same words.
    const filedDepartmentId = redirect?.departmentId ?? MEDICAL_RECORDS_DEPARTMENT_ID;
    const filedTypeId = redirect?.requestTypeId ?? cls.requestTypeId;
    const filedReasonId = redirect?.requestReasonId ?? cls.requestReasonId;
    const filedDescription = redirect
      ? `${redirect.note}\n\n${cleanDescription.value}`
      : cleanDescription.value;
    /**
     * THE STATUS GOES FIRST, ABOVE THE CALLER'S OWN WORDS.
     *
     * Operator, 2026-09-04: *"where date of birth would be, you just put
     * unavailable or unmatched, so this way we know what was happening."*
     * It cannot go in the birth columns — they are varchar(2)/(2)/(4) — so it
     * goes where staff actually look, and first, because the point is that
     * nobody matches this to a chart without checking the recording.
     */
    /**
     * THE STATUS DOES NOT GO IN THE DESCRIPTION.
     *
     * That field becomes the body of a patient-facing SMS — `opticalTools`
     * sanitizes it to GSM-7 for exactly that reason, and BACKEND_HANDOFF
     * section 6 lists "annotating unrouted tickets in description" among the
     * changes caught in review. Prepending "Confirm identity from the call
     * recording before matching this to a chart" would have texted the
     * caller an instruction meant for staff (Codex, PR #268 round 5).
     *
     * The operator's ruling — *"where date of birth would be, you just put
     * unavailable or unmatched, so this way we know what was happening"* —
     * is about STAFF knowing. `callData` carries it to the ticket's own
     * call-metadata columns, which no message to the patient reads.
     */
    const filedDescriptionWithDobStatus = filedDescription;
    const dobStaffNote = dobStatus ? dobStatusNote(dobStatus) : undefined;
    if (redirect) {
      console.info(
        `[records] routed to ${redirect.departmentName} (dept ${redirect.departmentId}) — ` +
          `${redirect.requestReason}`,
      );
    }

    // ONE ENDPOINT, ALWAYS. create-ticket, with the department stated.
    // Never submit-ticket: it re-derives the DEPARTMENT server-side and
    // defaults to 8.
    const res = await createTicketDurable({
      departmentId: filedDepartmentId,
      requestTypeId: filedTypeId,
      requestReasonId: filedReasonId,
      // Omitted, not blanked, when the ask was spent: the app treats a missing
      // name as missing and a blank one as a name.
      ...(first ? { patientFirstName: first } : {}),
      ...(last ? { patientLastName: last } : {}),
      // Last ten digits, not the raw string and not all of `digits` — see
      // normalizePhone() in utils/phone.ts. The floor+ceiling above already
      // refused anything that isn't one plausible phone number, so this is
      // exactly ten digits or it wasn't reached. Traced 2026-08-21: the raw
      // string is what filed zero tickets across 3 calls / 32 POSTs over 14
      // days (their schema caps patientPhone at 20 chars, the raw string has
      // no upper bound). Safe format-wise: their own sendSMS() normalizer
      // strips non-digits and re-derives this same string before dialing out.
      patientPhone: normalizePhone(phone),
      patientEmail: str(input.email) || undefined,
      preferredContactMethod: 'phone',
      // Omitted entirely when the escape was taken. create-ticket takes these
      // as optional (traced 2026-09-03), and the columns are varchar(2)/(2)/(4)
      // so a word like "unavailable" could not be stored there even if we tried
      // — the status rides in the description instead, which is what staff read.
      ...(parts
        ? {
            patientBirthMonth: parts.month,
            patientBirthDay: parts.day,
            patientBirthYear: parts.year,
          }
        : {}),
      ...(lookup.providerId ? { providerId: lookup.providerId } : {}),
      ...(lookup.locationId ? { locationId: lookup.locationId } : {}),
      ...(cleanLocation ? { locationOfLastVisit: cleanLocation } : {}),
      lastProviderSeen: cleanProvider || undefined,
      description: filedDescriptionWithDobStatus,
      // Raised only when an outage cost us an id we had the name for — never
      // for a name the lookup ran and rejected, which is an ordinary fact
      // about the call. See the block above the lookup for why this is the
      // signal rather than a note in the text.
      priority: lostToOutage ? 'high' : 'medium',
      // Structured, so the ticketing app can stop defaulting mr_cases to
      // 'roa_patient'. Extra fields are ignored by an endpoint that does not
      // read them yet, which is why they are safe to send today — but the
      // ticketing app is the half that has to change for the clock to be right.
      requestorType: cap.requesterType,
      // LOGGED, CLOCK NOT STARTED when the link goes out: the signed form is
      // the written request and starts the clock on the same case (owner,
      // 2026-09-27). A redirected ticket never carries a form — it left
      // Medical Records.
      requestPathway: formChannel && !redirect ? 'pending_authorization' : cap.pathway,
      capClockApplies: formChannel && !redirect ? false : cap.onClock,
      ...(formChannel && !redirect ? { formChannel } : {}),
      // A NAME, not a description. The ticketing agent, 2026-08-13: "Send
      // requestorName even when the requester is the patient. Zero of 470 rows
      // carry one. The name is the evidence that a classification was made;
      // without it an audit cannot tell 'confirmed patient' from 'defaulted to
      // patient', which is the hole we are climbing out of."
      //
      // "I am the patient" is not evidence of anything. When the requester IS
      // the patient the name is theirs; otherwise it is whatever they said,
      // which is where the organisation usually sits ("SCAN Health Plan",
      // "an attorney at Lexitas").
      requestorName:
        cap.requesterType === 'patient' ? `${first} ${last}`.trim() || undefined : requesterRaw,
      callData: {
        agentUsed: 'records',
        ...(callSid ? { callSid } : {}),
        // Staff-only. Never the description — that is an SMS body.
        ...(nameNote || dobStaffNote
          ? { transcript: [nameNote, dobStaffNote].filter(Boolean).join('\n') }
          : {}),
      },
      // Guarded: callSid can be a sentinel ("unknown", "latest", ...), never
      // a real Twilio SID, when the retry lands on someone else's key.
      ...(isTwilioCallSid(callSid) ? { idempotencyKey: `call-${callSid}` } : {}),
    });

    if (!res.success || !res.ticketNumber) {
      return postFailureToolResult(res, 'file_records_ticket');
    }

    // A records request exists on this call: `send_records_form` may now re-send.
    noteCallFact(callSid, RECORDS_FILED_FACT);

    const sendForm = Boolean(formChannel) && !redirect;
    const formSent = sendForm && res.form?.sent === true;
    const byText = formChannel === 'sms';
    const formMessage = redirect
      ? undefined
      : formSent
        ? `Filed as ${res.ticketNumber}. Tell them: your request is logged, and I've just sent a link by ` +
          `${byText ? 'text to this number' : 'email to that address'} — a short form, about four minutes, ` +
          `and you sign at the end; that is what lets us release the records. Read the ticket number back. ` +
          `Do not promise a date.`
        : sendForm
          ? `Filed as ${res.ticketNumber}. The link could NOT be sent just now. Tell them the request is ` +
            `logged and the records team will send them the authorization form. Read the ticket number back.`
          : spokenDirections
            ? `Filed as ${res.ticketNumber}. Tell them: your request is logged; to sign the authorization, ` +
              `${WEBSITE_DIRECTIONS}. Read the ticket number back. Do not promise a date.`
            : undefined;

    return {
      success: true,
      ticket_number: res.ticketNumber,
      ...(sendForm || spokenDirections
        ? { form_channel: spokenDirections ? 'verbal' : formChannel, form_sent: formSent }
        : {}),
      ...(sendForm && !formSent && res.form?.error ? { fix: `The app did not send the link: ${res.form.error}. You may offer the other channel once with send_records_form.` } : {}),
      // REPORT WHAT WAS FILED, not what the home queue classified it as.
      //
      // These used to report `cls`, the home-queue classification, even when
      // the ticket had been redirected. A live curl on 2026-08-13 filed "my
      // glasses broke at the hinge" into Optical and reported reason 542 —
      // department 3's catch-all, which is not on the ticket and not the
      // department's. The number the agent reads back has to be the number a
      // person will find.
      request_reason: redirect ? redirect.requestReason : cls.requestReason,
      request_reason_id: filedReasonId,
      // Say plainly what is missing, so the agent can still ask before the call
      // ends rather than a clerk chasing it tomorrow.
      requester_type: cap.requesterType,
      cap_clock_applies: cap.onClock,
      ...(deliverTo ? {} : { note_destination: 'No destination captured — ask where these should be sent.' }),
      ...(redirect
        ? { routed_to: redirect.departmentName, routed_department_id: redirect.departmentId }
        : {}),
      message: redirect
        ? `Filed as ${res.ticketNumber} with our ${redirect.departmentName} team. Read the ticket number back and say that team will follow up.`
        : formMessage ??
          `Filed as ${res.ticketNumber}. Read the ticket number back to the caller. Do not promise a date or say the records have been sent.`,
    };
  },
});

// ---------------------------------------------------------------- re-send

/**
 * THE SECOND CHANCE. The first send rides inside `file_records_ticket`; this
 * is for the caller who says the text did not arrive or wants it by email
 * instead. Gated on a filing having SUCCEEDED on this call — a server-side
 * per-call fact, never a model argument (the v17 P1 lesson). The ticketing
 * app re-mints the single-use token, so the earlier link stops working, and
 * the URL never reaches this process.
 */
/**
 * A refusal that carries guidance for the MODEL (and, when there is something
 * true to say, a line for the caller). `ToolFailure` types only `error`; the
 * bridge JSON-stringifies the whole result, so the extra keys reach the model
 * exactly as `missing()`'s do. The cast is the price of a typed union that
 * predates the `fix` channel.
 */
function refuse(error: string, extra: { fix: string; message?: string }): ToolResult {
  return { success: false, error, ...extra } as ToolResult;
}

registerTool({
  name: 'send_records_form',
  layer: 'agent',
  // A network POST to the ticketing app, bounded like the filing tool's.
  timeoutMs: 20000,
  description:
    'Re-send the signing link for the records request already filed on THIS call — by text or by ' +
    'email — when the caller says it has not arrived or wants the other channel. Only after ' +
    'file_records_ticket has succeeded on this call.',
  input_schema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: '"sms" or "email".',
        askAs: 'Would you like it by text or by email?',
      },
      email: {
        type: 'string',
        description: 'The email address, spelled out, when they chose email.',
        askAs: "What's the email address? Please spell it out for me.",
      },
      call_sid: { type: 'string', description: 'The call id, so the request filed on this call is the one re-sent.' },
    },
    required: ['channel'],
  },
  handler: async (input): Promise<ToolResult> => {
    const callSid = str(input.call_sid);
    const channel = str(input.channel).toLowerCase();
    if (channel !== 'sms' && channel !== 'email') {
      return refuse('channel must be "sms" or "email"', { fix: 'Call again with channel "sms" or "email".' });
    }
    if (!callFactNoted(callSid, RECORDS_FILED_FACT)) {
      // No `message`: an instruction to the model must never sit in the channel
      // the agent speaks (v43).
      return refuse('no records request filed on this call', {
        fix:
          'No records request has been filed on this call yet, so there is nothing to re-send. File it ' +
          'with file_records_ticket (with form_channel) — the link goes out with the filing.',
      });
    }
    const email = str(input.email);
    if (channel === 'email' && !email) {
      return missing(['email'], "What's the email address? Please spell it out for me.");
    }
    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    const r = await ticketingApiClient.sendRecordsIntakeLink({
      callSid,
      channel,
      ...(email ? { email } : {}),
    });
    if (!r.success) {
      return refuse(r.error ?? 're-send failed', {
        message: 'I was not able to send that just now. The records team will send the form to you instead.',
        fix: `The re-send failed (${r.error ?? 'unknown'}). Do not try again on this call; say the team will send it.`,
      });
    }
    return {
      success: true,
      form_channel: channel,
      form_sent: true,
      message:
        channel === 'sms'
          ? 'Sent. Tell them a text with the link is on its way to this number; it takes about four minutes and they sign at the end.'
          : 'Sent. Tell them the email with the link is on its way; it takes about four minutes and they sign at the end.',
    };
  },
});
