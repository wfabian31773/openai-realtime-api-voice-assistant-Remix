/**
 * THE TICKET THE TRANSCRIPT CALLS FOR — v191.
 *
 * Operator, 2026-11-09: "we have always focused on execution of task but never
 * on quality of task. So even though we are now filing at 95% and above, we
 * are never tracking the quality of what we file. I want that to be part of
 * the daybook, I want to measure every filing with what should have filed
 * based on the actual transcription, nothing else, the actual transcript has
 * to tell us what should have been filed and what fields should have been
 * populated."
 *
 * So this reads ONE thing: the call's transcript. From it a model writes down
 * the ticket the call calls for — whether one should be filed at all, what it
 * is about, who was calling, and each field the CALLER actually gave. A field
 * the caller did not say (or confirm when the agent read it back) is null:
 * the expectation is what the transcript supports, never what the record or a
 * lookup could have filled. `filingQuality.ts` then compares it with the
 * ticket as it sits in the Support Center.
 *
 * Why a model and not a pattern: standing instruction 3 — extraction is the
 * model's job. It uses the model and account the grader already uses on every
 * call (`callGradingService.ts`, `nameFromTheRecording.ts`: gpt-4o-mini on
 * OPENAI_API_KEY), so the transcript goes nowhere it does not already go.
 *
 * Nothing here changes a call, a ticket or a gate. It is a measurement.
 */
import OpenAI from "openai";

export const FILING_EXPECTATION_MODEL = "gpt-4o-mini";
/** Bump when the instructions or the schema change; stored on every row. */
export const FILING_EXPECTATION_PROMPT_VERSION = "fq-1-20261109";
/** A backfill read, not a caller waiting: bounded, never retried in place. */
export const FILING_EXPECTATION_TIMEOUT_MS = 15_000;

export const NO_FILE_REASONS = [
  "no_request",
  "question_answered_on_call",
  "wrong_number_or_robocall",
  "hung_up_before_request",
  "caller_withdrew",
  "test_call",
  "other",
] as const;
export type NoFileReason = (typeof NO_FILE_REASONS)[number];

export const TOPICS = [
  "records",
  "optical_order_or_glasses_or_contacts",
  "scheduling_new_or_change_or_cancel_or_confirm",
  "surgery_date_or_surgery_coordination",
  "medication_or_refill",
  "clinical_question_or_symptom",
  "test_results",
  "billing",
  "provider_or_office_business",
  "other",
] as const;
export type Topic = (typeof TOPICS)[number];

export const CALLER_ROLES = [
  "patient",
  "family_or_personal_representative",
  "provider_office_or_facility",
  "health_plan",
  "pharmacy",
  "attorney_or_legal",
  "other_business",
  "unknown",
] as const;
export type CallerRole = (typeof CALLER_ROLES)[number];

export const RECORDS_DELIVERIES = ["fax", "email", "mail", "portal", "pickup"] as const;
export type RecordsDelivery = (typeof RECORDS_DELIVERIES)[number];

export const CONTACT_PREFERENCES = ["phone", "text", "email"] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];

/** The ticket the transcript calls for. Every field the caller did not give is null. */
export interface FilingExpectation {
  shouldFile: boolean;
  noFileReason: NoFileReason | null;
  topic: Topic;
  urgent: boolean;
  callerRole: CallerRole;
  requesterName: string | null;
  requesterOrganization: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  /** YYYY-MM-DD, as the caller said it. */
  patientDob: string | null;
  /** Ten digits, said or confirmed by the caller. */
  callbackNumber: string | null;
  callbackIsCallerId: boolean;
  email: string | null;
  officeNamed: string | null;
  providerNamed: string | null;
  medicationNamed: string | null;
  recordsDelivery: RecordsDelivery | null;
  contactPreference: ContactPreference | null;
  requestSummary: string | null;
}

export const FILING_EXPECTATION_INSTRUCTIONS =
  "You read the transcript of one phone call to Azul Vision, an eye-care practice. Lines start with AGENT: or CALLER:. " +
  "Write down the ticket this call calls for, using ONLY what the transcript says. " +
  "A field is filled only when the CALLER said it, or clearly confirmed it (yes) when the AGENT read it back. " +
  "Never use something only the AGENT said and the caller did not confirm. Never guess. Anything not given is null. " +
  "should_file is true when the caller made a request that needs a staff member to act or call back " +
  "(a message, a callback, a change, a records request, a refill, a question the agent could not answer). " +
  "It is false when no request was made, the agent fully answered a question on the call, it was a wrong number or a robocall, " +
  "the caller hung up before saying what they needed, the caller withdrew the request, or it was plainly a test call; " +
  "then give no_file_reason, otherwise no_file_reason is null. " +
  "topic is what the request is about. urgent is true only when the caller described an urgent eye symptom " +
  "(sudden vision loss, a curtain or flashes with new floaters, severe pain, an injury, bleeding after surgery). " +
  "caller_role is who is calling: the patient, a family member or personal representative, a provider office or facility " +
  "(a doctor's office, clinic, hospital, surgery center, lab), a health plan, a pharmacy, an attorney, another business, or unknown. " +
  "requester_name and requester_organization are the caller's own name and organization, only when the caller is NOT the patient. " +
  "patient_first_name and patient_last_name are the name of the patient the call is about, as said or spelled by the caller; " +
  "when someone calls about another person, it is that person's name, not the caller's. " +
  "patient_dob is the patient's date of birth as YYYY-MM-DD, only when the caller said a full date. " +
  "callback_number is the ten-digit number to call back, only when the caller said it or confirmed it; " +
  "callback_is_caller_id is true when the caller confirmed the number the agent read back as the one they are calling from. " +
  "email is an email address the caller gave. office_named is an Azul Vision office or city the caller named for this request. " +
  "provider_named is a doctor or surgeon the caller named. medication_named is a medication the caller named. " +
  "records_delivery is how the caller asked records to be sent (fax, email, mail, portal or pickup). " +
  "contact_preference is how the caller asked to be contacted (phone, text or email). " +
  "request_summary is one short line saying what the caller needs, without names, dates of birth or phone numbers.";

const nullableString = { type: ["string", "null"] } as const;
const nullableEnum = (values: readonly string[]) => ({ type: ["string", "null"], enum: [...values, null] });

/** Strict structured-output schema: every property required, nulls allowed where a field can be absent. */
export const FILING_EXPECTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    should_file: { type: "boolean" },
    no_file_reason: nullableEnum(NO_FILE_REASONS),
    topic: { type: "string", enum: [...TOPICS] },
    urgent: { type: "boolean" },
    caller_role: { type: "string", enum: [...CALLER_ROLES] },
    requester_name: nullableString,
    requester_organization: nullableString,
    patient_first_name: nullableString,
    patient_last_name: nullableString,
    patient_dob: nullableString,
    callback_number: nullableString,
    callback_is_caller_id: { type: "boolean" },
    email: nullableString,
    office_named: nullableString,
    provider_named: nullableString,
    medication_named: nullableString,
    records_delivery: nullableEnum(RECORDS_DELIVERIES),
    contact_preference: nullableEnum(CONTACT_PREFERENCES),
    request_summary: nullableString,
  },
  required: [
    "should_file", "no_file_reason", "topic", "urgent", "caller_role", "requester_name", "requester_organization",
    "patient_first_name", "patient_last_name", "patient_dob", "callback_number", "callback_is_caller_id", "email",
    "office_named", "provider_named", "medication_named", "records_delivery", "contact_preference", "request_summary",
  ],
} as const;

export interface ExpectationInput {
  transcript: string;
  lane: string | null;
  callStartedAt: Date | null;
}

/** What the model answered, raw. Injected in tests. */
export type ExpectationAsker = (input: ExpectationInput) => Promise<unknown>;

/** The context line the model sees above the transcript: the line called and when. Nothing about the patient. */
export function contextLine(input: ExpectationInput): string {
  const when = input.callStartedAt && !Number.isNaN(input.callStartedAt.getTime())
    ? input.callStartedAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", hour: "numeric", minute: "2-digit" })
    : "unknown";
  return `Line: ${input.lane ?? "unknown"}. Call started (Pacific): ${when}.`;
}

let client: OpenAI | null = null;

/** The production asker. Throws on a missing key, a timeout or an API error; the worker logs the kind and retries later. */
export const askModelForFilingExpectation: ExpectationAsker = async (input) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("no_api_key");
  client ??= new OpenAI({ apiKey: key, timeout: FILING_EXPECTATION_TIMEOUT_MS, maxRetries: 0 });
  const res = await client.chat.completions.create({
    model: FILING_EXPECTATION_MODEL,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: "filing_expectation", strict: true, schema: FILING_EXPECTATION_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [
      { role: "system", content: FILING_EXPECTATION_INSTRUCTIONS },
      { role: "user", content: `${contextLine(input)}\n\n${input.transcript}` },
    ],
  });
  const text = res.choices[0]?.message?.content ?? "";
  return JSON.parse(text);
};

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || /^(null|none|unknown|n\/a|not provided)$/i.test(t)) return null;
  return t.slice(0, max);
}

function oneOf<T extends string>(v: unknown, values: readonly T[]): T | null {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null;
}

/** A real calendar date in YYYY-MM-DD, or null. */
export function isoDate(v: unknown): string | null {
  const s = str(v, 20);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900) return null;
  return s;
}

/** The last ten digits of a US number, or null. */
export function tenDigits(v: unknown): string | null {
  const s = str(v, 40);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? ten : null;
}

/**
 * The model's answer, checked. Anything outside the schema is dropped to null
 * rather than trusted; an answer with no usable topic or role is not an
 * expectation at all (null), so a garbled reply is never counted as a finding.
 */
export function normaliseExpectation(raw: unknown): FilingExpectation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const topic = oneOf(r.topic, TOPICS);
  const callerRole = oneOf(r.caller_role, CALLER_ROLES);
  if (typeof r.should_file !== "boolean" || !topic || !callerRole) return null;
  const shouldFile = r.should_file;
  return {
    shouldFile,
    noFileReason: shouldFile ? null : (oneOf(r.no_file_reason, NO_FILE_REASONS) ?? "other"),
    topic,
    urgent: r.urgent === true,
    callerRole,
    requesterName: str(r.requester_name),
    requesterOrganization: str(r.requester_organization),
    patientFirstName: str(r.patient_first_name, 80),
    patientLastName: str(r.patient_last_name, 80),
    patientDob: isoDate(r.patient_dob),
    callbackNumber: tenDigits(r.callback_number),
    callbackIsCallerId: r.callback_is_caller_id === true,
    email: str(r.email, 200)?.includes("@") ? str(r.email, 200) : null,
    officeNamed: str(r.office_named),
    providerNamed: str(r.provider_named),
    medicationNamed: str(r.medication_named),
    recordsDelivery: oneOf(r.records_delivery, RECORDS_DELIVERIES),
    contactPreference: oneOf(r.contact_preference, CONTACT_PREFERENCES),
    requestSummary: str(r.request_summary, 300),
  };
}

/** True when the transcript holds at least one caller line: nothing to read otherwise. */
export function hasCallerSpeech(transcript: string | null | undefined): boolean {
  return /(^|\n)\s*CALLER:\s*\S/.test(transcript ?? "");
}

/**
 * Read one call. Null when there is no caller speech or the model's answer is
 * unusable. A thrown error (no key, timeout, API error) propagates so the
 * worker can count the attempt and log its KIND — never its content.
 */
export async function extractFilingExpectation(
  input: ExpectationInput,
  ask: ExpectationAsker = askModelForFilingExpectation,
): Promise<FilingExpectation | null> {
  if (!hasCallerSpeech(input.transcript)) return null;
  return normaliseExpectation(await ask(input));
}
