/**
 * FILING QUALITY: WHAT WAS FILED AGAINST WHAT THE TRANSCRIPT CALLED FOR — v191.
 *
 * The expectation (`filingExpectation.ts`) is read from the transcript alone.
 * This module compares it with the ticket as it sits in the Support Center and
 * says, per call: whether a ticket should have been filed and was; whether it
 * went where the rulings send that kind of request; and, for every field the
 * CALLER gave, whether the ticket carries it, carries something else, or lacks
 * it.
 *
 * Two things are deliberately NOT errors:
 *   - A field on the ticket the caller did not say (`beyond_transcript`). RULE
 *     ZERO carries the matched record forward, so a date of birth or an office
 *     from the chart is correct even though the transcript never says it. It
 *     is counted so it can be read, never charged to the agent.
 *   - A department with no recorded ruling for that kind of request on that
 *     line (`no_rule`). Only rulings written in CLAUDE.md are encoded here;
 *     anything else would be this module inventing routing policy.
 *
 * Pure: no database, no network. `scripts/filing-quality.ts` feeds it the two
 * exports and prints the summary the Daybook reads.
 */
import type { FilingExpectation, Topic } from "./filingExpectation";

export const DEPARTMENTS = {
  optical: 1,
  surgery: 2,
  tech: 3,
  afterHours: 8,
  hvaHub: 9,
  medicalRecords: 16,
  pcpSupport: 18,
} as const;

const AFTER_HOURS_LANES = new Set(["no-ivr", "no-ivr-v2"]);
const QUEUE_LANES = new Set(["optical", "surgery", "tech", "records"]);

/** The ticket as it sits in the Support Center (the export's columns, snake_case). */
export interface TicketRow {
  call_sid: string;
  ticket_number: string | null;
  /** The department the agent filed it in (the ticket.created event), when known. */
  filed_department_id: number | null;
  /** Where it is now: staff may have moved it. */
  department_id: number | null;
  priority: string | null;
  location_id: number | null;
  provider_id: number | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_birth_month: string | null;
  patient_birth_day: string | null;
  patient_birth_year: string | null;
  patient_phone: string | null;
  patient_email: string | null;
  records_requestor_type: string | null;
  records_request_pathway: string | null;
  records_requestor_name: string | null;
  pcp_caller_name: string | null;
  pcp_caller_organization: string | null;
  pcp_caller_callback_number: string | null;
  pcp_caller_email: string | null;
  merged: boolean | null;
  /**
   * The ticket was withdrawn by the PCP hang-up rule (v100, archived with that
   * rule's reason). A withdrawn ticket is no filing: the call reads as the
   * ruling, not as a filing.
   */
  withdrawn?: boolean | null;
  created_at: string | null;
}

/** One call from the Hub export: its expectation, and what the call row says about how it ended. */
export interface ExpectationRow {
  call_sid: string;
  agent_used: string | null;
  call_started_at: string | null;
  runtime_outcome: string | null;
  /**
   * `call_logs.ticket_number`: the ticket THIS call filed, by the write-back.
   * A ticket's own call_sid can be a later call's (the app folds a callback
   * onto the open ticket and re-stamps it), so tickets are matched on this too.
   */
  ticket_number?: string | null;
  expectation: FilingExpectation | null;
  skipped_reason: string | null;
}

export type FilingVerdict =
  | "unreadable"
  | "filed"
  | "missed_filing"
  | "no_ticket_by_ruling"
  | "filed_not_needed"
  | "correctly_not_filed";

export type DepartmentVerdict = "match" | "mismatch" | "no_rule" | "not_filed";

export type FieldVerdict = "match" | "variant" | "differs" | "missing" | "beyond_transcript";

export const CHECKED_FIELDS = [
  "patient_first_name",
  "patient_last_name",
  "patient_dob",
  "callback_number",
  "email",
  "office",
  "provider",
  "requester",
] as const;
export type CheckedField = (typeof CHECKED_FIELDS)[number];

export interface FilingComparison {
  callSid: string;
  lane: string;
  verdict: FilingVerdict;
  ticketNumber: string | null;
  department: DepartmentVerdict;
  expectedDepartment: number | null;
  filedDepartment: number | null;
  movedByStaff: boolean;
  fields: Partial<Record<CheckedField, FieldVerdict>>;
  /** Records request from someone other than the patient, filed as the patient's own (ticket #73052's defect). */
  recordsRequester: "correct" | "wrong" | "missing" | null;
  urgencyMissed: boolean;
  /** Filed, sent where the rules send it, nothing the caller gave missing or wrong. */
  clean: boolean;
}

/** A PCP records request from these callers is routed to Medical Records (v15/v16). */
const PCP_RECORDS_ROUTED = new Set(["patient", "family_or_personal_representative", "provider_office_or_facility", "health_plan", "attorney_or_legal"]);
/** A professional caller on PCP: their requests stay in PCP Support. */
const PCP_PROFESSIONALS = new Set(["provider_office_or_facility", "health_plan", "pharmacy", "attorney_or_legal", "other_business"]);

/**
 * The department the rulings send this request to, or null when there is no
 * recorded ruling for it on this line, or when the code makes a judgement the
 * transcript cannot see. Encodes only:
 *   - records go to Medical Records from every line (2026-09-12/14 rulings,
 *     v15/v16, v73; after hours v190, operator 2026-11-09). On PCP only for a
 *     patient, family, provider, plan or attorney: a pharmaceutical rep or a
 *     professional the agent cannot identify stays in PCP Support by design (v16);
 *   - PCP: scheduling goes to the HVA Hub (v17); a professional's other requests
 *     stay in PCP Support; a PATIENT's request is routed by topic like a queue
 *     call (glasses to Optical), and anything else from a patient has no rule;
 *   - glasses, contacts and optical orders go to Optical on every line, after hours too (v161);
 *   - after hours: an urgent symptom's record is After Hours (v88, v93). Nothing
 *     else after hours has a rule here: a same-day request of any topic goes to
 *     After Hours (v89) and the transcript cannot say the call was same-day;
 *   - surgery coordination goes to Surgery Coordination;
 *   - scheduling goes to the HVA Hub from every queue (standing instruction 10).
 */
export function expectedDepartment(topic: Topic, lane: string, urgent: boolean, callerRole?: string): number | null {
  const afterHours = AFTER_HOURS_LANES.has(lane);
  if (lane === "pcp") {
    if (topic === "records") return callerRole && PCP_RECORDS_ROUTED.has(callerRole) ? DEPARTMENTS.medicalRecords : null;
    if (topic === "scheduling_new_or_change_or_cancel_or_confirm") return DEPARTMENTS.hvaHub;
    if (callerRole && PCP_PROFESSIONALS.has(callerRole)) return DEPARTMENTS.pcpSupport;
    if (callerRole === "patient" || callerRole === "family_or_personal_representative") {
      return topic === "optical_order_or_glasses_or_contacts" ? DEPARTMENTS.optical : null;
    }
    return null;
  }
  if (topic === "records") return DEPARTMENTS.medicalRecords;
  if (topic === "optical_order_or_glasses_or_contacts") return DEPARTMENTS.optical;
  if (afterHours) {
    return urgent && (topic === "clinical_question_or_symptom" || topic === "medication_or_refill") ? DEPARTMENTS.afterHours : null;
  }
  if (topic === "surgery_date_or_surgery_coordination") return DEPARTMENTS.surgery;
  if (topic === "scheduling_new_or_change_or_cancel_or_confirm") return QUEUE_LANES.has(lane) ? DEPARTMENTS.hvaHub : null;
  return null;
}

/** Lower-case, accents off, letters only. */
export function foldName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "");
}

/** Words the ticketing app and our stand-ins use for "no name". */
const STAND_IN_NAMES = new Set(["unnamed", "unknown", "caller", "patient", "notprovided", "notprovidedbycaller", "na", "none", "unnamedcaller"]);

function realName(s: string | null | undefined): string | null {
  const f = foldName(s);
  return f && !STAND_IN_NAMES.has(f) ? f : null;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * Same name, a spelling of it, or another name. A spelling variant is kept
 * apart from "differs" because the transcript's spelling is speech recognition
 * and the ticket's may be the chart's (RULE ZERO: the record wins).
 */
export function compareName(said: string | null, filed: string | null): FieldVerdict | null {
  const s = realName(said);
  const f = realName(filed);
  if (!s) return f ? "beyond_transcript" : null;
  if (!f) return "missing";
  if (s === f) return "match";
  const sWords = foldWords(said);
  const fWords = foldWords(filed);
  // A compound name confirmed by one of its words ("Rosa" for "Rosa Mae").
  if (sWords.some((w) => fWords.includes(w)) && Math.min(sWords.length, fWords.length) >= 1 && (sWords.length > 1 || fWords.length > 1)) return "match";
  return levenshtein(s, f) <= Math.max(1, Math.floor(Math.max(s.length, f.length) / 4)) ? "variant" : "differs";
}

function foldWords(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !STAND_IN_NAMES.has(w));
}

/** The ticket's date of birth as YYYY-MM-DD, or null when any part is missing or not a number. */
export function ticketDob(t: Pick<TicketRow, "patient_birth_month" | "patient_birth_day" | "patient_birth_year">): string | null {
  const m = Number(t.patient_birth_month);
  const d = Number(t.patient_birth_day);
  const y = Number(t.patient_birth_year);
  if (!Number.isInteger(m) || !Number.isInteger(d) || !Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31 || y < 1) return null;
  const year = String(t.patient_birth_year).trim().length === 2 ? `xx${String(y).padStart(2, "0")}` : String(y).padStart(4, "0");
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function compareDob(said: string | null, t: TicketRow): FieldVerdict | null {
  const filed = ticketDob(t);
  if (!said) return filed ? "beyond_transcript" : null;
  if (!filed) return "missing";
  if (filed.startsWith("xx")) return filed.slice(2) === said.slice(2) ? "match" : "differs";
  return filed === said ? "match" : "differs";
}

function lastTen(s: string | null | undefined): string | null {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export function comparePhone(said: string | null, filed: string | null): FieldVerdict | null {
  const f = lastTen(filed);
  if (!said) return f ? "beyond_transcript" : null;
  if (!f) return "missing";
  return f === said ? "match" : "differs";
}

function foldEmail(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, "").replace(/\bat\b/g, "@").replace(/\bdot\b/g, ".");
}

export function compareEmail(said: string | null, filed: string | null): FieldVerdict | null {
  const f = foldEmail(filed);
  if (!said) return f.includes("@") ? "beyond_transcript" : null;
  if (!f.includes("@")) return "missing";
  return f === foldEmail(said) ? "match" : "differs";
}

/** Office and provider: the ticket either carries a routed id or it does not; names are not compared. */
export function comparePresence(said: string | null, filedId: number | null): FieldVerdict | null {
  const has = filedId !== null && filedId !== undefined;
  if (!said) return has ? "beyond_transcript" : null;
  return has ? "match" : "missing";
}

const NOT_THE_PATIENT = new Set([
  "provider_office_or_facility",
  "health_plan",
  "pharmacy",
  "attorney_or_legal",
  "other_business",
]);

/**
 * Who asked for records. A request from someone other than the patient or
 * their family must not be filed as the patient's own (requestor 'patient' /
 * pathway roa_patient) — that puts a third party's request on the patient's
 * 15-day clock with nobody to sign for it. Only checked on a records ticket.
 */
export function compareRecordsRequester(e: FilingExpectation, t: TicketRow): "correct" | "wrong" | "missing" | null {
  if (e.topic !== "records") return null;
  const onRecordsTicket =
    t.filed_department_id === DEPARTMENTS.medicalRecords ||
    t.department_id === DEPARTMENTS.medicalRecords ||
    Boolean(t.records_requestor_type || t.records_request_pathway);
  if (!onRecordsTicket) return null;
  const type = (t.records_requestor_type ?? "").toLowerCase();
  const pathway = (t.records_request_pathway ?? "").toLowerCase();
  const filedAsPatient = type === "patient" || pathway === "roa_patient";
  if (NOT_THE_PATIENT.has(e.callerRole)) {
    if (!type && !pathway) return "missing";
    return filedAsPatient ? "wrong" : "correct";
  }
  if (e.callerRole === "patient") {
    if (!type && !pathway) return "missing";
    return type && type !== "patient" && !pathway.startsWith("roa_") && pathway !== "pending_authorization" ? "wrong" : "correct";
  }
  return null;
}

function requesterVerdict(e: FilingExpectation, t: TicketRow, lane: string): FieldVerdict | null {
  if (!NOT_THE_PATIENT.has(e.callerRole) && e.callerRole !== "family_or_personal_representative") return null;
  // A structured requester field exists only on a records ticket and on a PCP
  // Support ticket. A PCP request routed elsewhere (a scheduling request to the
  // HVA Hub) carries the requester only in its description: not checked.
  const dept = t.filed_department_id ?? t.department_id;
  let filed: string | null;
  if (dept === DEPARTMENTS.medicalRecords || e.topic === "records") {
    filed = t.records_requestor_name || (lane === "pcp" ? t.pcp_caller_name || t.pcp_caller_organization : null) || null;
  } else if (lane === "pcp" && dept === DEPARTMENTS.pcpSupport) {
    filed = t.pcp_caller_name || t.pcp_caller_organization || null;
  } else {
    return null;
  }
  const said = e.requesterName || e.requesterOrganization;
  if (!said) return filed ? "beyond_transcript" : null;
  return filed ? "match" : "missing";
}

function fieldsFor(e: FilingExpectation, t: TicketRow, lane: string): Partial<Record<CheckedField, FieldVerdict>> {
  const out: Partial<Record<CheckedField, FieldVerdict>> = {};
  const put = (k: CheckedField, v: FieldVerdict | null) => {
    if (v) out[k] = v;
  };
  put("patient_first_name", compareName(e.patientFirstName, t.patient_first_name));
  put("patient_last_name", compareName(e.patientLastName, t.patient_last_name));
  put("patient_dob", compareDob(e.patientDob, t));
  put("callback_number", comparePhone(e.callbackNumber, lane === "pcp" ? t.pcp_caller_callback_number || t.patient_phone : t.patient_phone));
  put("email", compareEmail(e.email, lane === "pcp" ? t.pcp_caller_email || t.patient_email : t.patient_email));
  put("office", comparePresence(e.officeNamed, t.location_id));
  // A provider id is the routing contract on Surgery only. Elsewhere a doctor
  // the caller names is often not ours (an office calling on a doctor's
  // behalf), so a ticket without one is not charged.
  const provider = comparePresence(e.providerNamed, t.provider_id);
  put("provider", lane === "surgery" || provider !== "missing" ? provider : null);
  put("requester", requesterVerdict(e, t, lane));
  // One person charted twice (v179): the caller may say one chart's surname
  // while the ticket carries the other's. With the first name and the date of
  // birth agreeing, another surname is read as a spelling, not a wrong patient.
  if (
    out.patient_last_name === "differs" &&
    (out.patient_first_name === "match" || out.patient_first_name === "variant") &&
    out.patient_dob === "match"
  ) {
    out.patient_last_name = "variant";
  }
  return out;
}

function score(fields: Partial<Record<CheckedField, FieldVerdict>>): number {
  let s = 0;
  for (const v of Object.values(fields)) {
    if (v === "match") s += 2;
    else if (v === "variant") s += 1;
    else if (v === "differs") s -= 3;
    else if (v === "missing") s -= 1;
  }
  return s;
}

/** PCP rulings that file nothing: a caller who hangs up untold (v100) or chooses the live queue (v87). */
function noTicketByRuling(lane: string, runtimeOutcome: string | null): boolean {
  return lane === "pcp" && (runtimeOutcome === "caller_hangup" || runtimeOutcome === "transferred");
}

/**
 * Compare one call. `tickets` are the call's agent-filed tickets (several on a
 * call is possible: a request and its urgent ring-out record, a second patient);
 * the one that best carries what the caller said is the one judged.
 */
export function compareFiling(row: ExpectationRow, tickets: TicketRow[]): FilingComparison {
  const lane = row.agent_used ?? "unknown";
  const base: FilingComparison = {
    callSid: row.call_sid,
    lane,
    verdict: "unreadable",
    ticketNumber: null,
    department: "not_filed",
    expectedDepartment: null,
    filedDepartment: null,
    movedByStaff: false,
    fields: {},
    recordsRequester: null,
    urgencyMissed: false,
    clean: false,
  };
  const e = row.expectation;
  if (!e) return base;
  base.expectedDepartment = expectedDepartment(e.topic, lane, e.urgent, e.callerRole);
  if (tickets.length === 0) {
    base.verdict = e.shouldFile ? (noTicketByRuling(lane, row.runtime_outcome) ? "no_ticket_by_ruling" : "missed_filing") : "correctly_not_filed";
    base.clean = !e.shouldFile || base.verdict === "no_ticket_by_ruling";
    return base;
  }
  const judged = tickets
    .map((t) => ({ t, fields: fieldsFor(e, t, lane) }))
    .sort((a, b) => score(b.fields) - score(a.fields) || String(a.t.created_at ?? "").localeCompare(String(b.t.created_at ?? "")))[0];
  const t = judged.t;
  base.verdict = e.shouldFile ? "filed" : "filed_not_needed";
  base.ticketNumber = t.ticket_number;
  base.fields = judged.fields;
  base.filedDepartment = t.filed_department_id ?? t.department_id;
  base.movedByStaff = t.filed_department_id !== null && t.department_id !== null && t.filed_department_id !== t.department_id;
  // Where it went is a property of the call: a request ticket beside its
  // urgent ring-out record (v93/v95) is routed right when either is where the
  // ruling sends it.
  const inExpected = tickets.find((x) => (x.filed_department_id ?? x.department_id) === base.expectedDepartment);
  base.department = base.expectedDepartment === null ? "no_rule" : inExpected ? "match" : "mismatch";
  if (inExpected) base.filedDepartment = inExpected.filed_department_id ?? inExpected.department_id;
  base.recordsRequester = compareRecordsRequester(e, t);
  base.urgencyMissed = e.urgent && !tickets.some((x) => x.priority === "urgent" || x.priority === "high");
  base.clean =
    base.verdict === "filed" &&
    base.department !== "mismatch" &&
    !Object.values(base.fields).some((v) => v === "differs" || v === "missing") &&
    base.recordsRequester !== "wrong" &&
    base.recordsRequester !== "missing" &&
    !base.urgencyMissed;
  return base;
}

export interface Rate {
  n: number;
  of: number;
  pct: number | null;
}

function rate(n: number, of: number): Rate {
  return { n, of, pct: of > 0 ? Math.round((1000 * n) / of) / 10 : null };
}

export interface FieldSummary {
  supplied: number;
  match: Rate;
  variant: Rate;
  differs: Rate;
  missing: Rate;
  beyondTranscript: number;
}

export interface LaneSummary {
  callsRead: number;
  shouldFile: number;
  filed: number;
  missedFiling: number;
  clean: Rate;
  departmentMismatch: Rate;
}

export interface QualitySummary {
  callsRead: number;
  unreadable: number;
  shouldFile: number;
  filings: {
    filed: number;
    missedFiling: number;
    noTicketByRuling: number;
    filedNotNeeded: number;
    correctlyNotFiled: number;
    /** Of calls that should have filed, the share that did (by-ruling exits excluded from the denominator). */
    filedWhenDue: Rate;
  };
  /** Filed, routed by the rules, and carrying everything the caller gave. */
  clean: Rate;
  department: { checked: number; match: Rate; mismatch: Rate; noRule: number; movedByStaff: Rate };
  fields: Record<CheckedField, FieldSummary>;
  recordsRequester: { checked: number; correct: Rate; wrong: Rate; missing: Rate };
  urgencyMissed: number;
  lanes: Record<string, LaneSummary>;
  /** Call SIDs only, capped per list. */
  defects: {
    missedFiling: string[];
    filedNotNeeded: string[];
    departmentMismatch: string[];
    movedByStaff: string[];
    fieldDiffers: Partial<Record<CheckedField, string[]>>;
    fieldMissing: Partial<Record<CheckedField, string[]>>;
    recordsRequesterWrong: string[];
    urgencyMissed: string[];
  };
}

export const DEFECT_LIST_CAP = 50;

export function summarise(rows: FilingComparison[]): QualitySummary {
  const push = (list: string[], sid: string) => {
    if (list.length < DEFECT_LIST_CAP) list.push(sid);
  };
  const read = rows.filter((r) => r.verdict !== "unreadable");
  const filed = read.filter((r) => r.verdict === "filed");
  const due = read.filter((r) => r.verdict === "filed" || r.verdict === "missed_filing");
  const deptChecked = filed.filter((r) => r.department === "match" || r.department === "mismatch");
  const fields = {} as Record<CheckedField, FieldSummary>;
  const fieldDiffers: Partial<Record<CheckedField, string[]>> = {};
  const fieldMissing: Partial<Record<CheckedField, string[]>> = {};
  for (const f of CHECKED_FIELDS) {
    const verdicts = filed.map((r) => r.fields[f]).filter(Boolean) as FieldVerdict[];
    const supplied = verdicts.filter((v) => v !== "beyond_transcript").length;
    fields[f] = {
      supplied,
      match: rate(verdicts.filter((v) => v === "match").length, supplied),
      variant: rate(verdicts.filter((v) => v === "variant").length, supplied),
      differs: rate(verdicts.filter((v) => v === "differs").length, supplied),
      missing: rate(verdicts.filter((v) => v === "missing").length, supplied),
      beyondTranscript: verdicts.filter((v) => v === "beyond_transcript").length,
    };
    for (const r of filed) {
      if (r.fields[f] === "differs") push((fieldDiffers[f] ??= []), r.callSid);
      if (r.fields[f] === "missing") push((fieldMissing[f] ??= []), r.callSid);
    }
  }
  const req = filed.filter((r) => r.recordsRequester !== null);
  const lanes: Record<string, LaneSummary> = {};
  for (const lane of [...new Set(read.map((r) => r.lane))].sort()) {
    const lr = read.filter((r) => r.lane === lane);
    const lf = lr.filter((r) => r.verdict === "filed");
    const ld = lf.filter((r) => r.department === "match" || r.department === "mismatch");
    lanes[lane] = {
      callsRead: lr.length,
      shouldFile: lr.filter((r) => r.verdict === "filed" || r.verdict === "missed_filing" || r.verdict === "no_ticket_by_ruling").length,
      filed: lf.length,
      missedFiling: lr.filter((r) => r.verdict === "missed_filing").length,
      clean: rate(lf.filter((r) => r.clean).length, lf.length),
      departmentMismatch: rate(ld.filter((r) => r.department === "mismatch").length, ld.length),
    };
  }
  const defects: QualitySummary["defects"] = {
    missedFiling: [],
    filedNotNeeded: [],
    departmentMismatch: [],
    movedByStaff: [],
    fieldDiffers,
    fieldMissing,
    recordsRequesterWrong: [],
    urgencyMissed: [],
  };
  for (const r of read) {
    if (r.verdict === "missed_filing") push(defects.missedFiling, r.callSid);
    if (r.verdict === "filed_not_needed") push(defects.filedNotNeeded, r.callSid);
    if (r.department === "mismatch") push(defects.departmentMismatch, r.callSid);
    if (r.movedByStaff) push(defects.movedByStaff, r.callSid);
    if (r.recordsRequester === "wrong") push(defects.recordsRequesterWrong, r.callSid);
    if (r.urgencyMissed) push(defects.urgencyMissed, r.callSid);
  }
  return {
    callsRead: rows.length,
    unreadable: rows.length - read.length,
    shouldFile: read.filter((r) => r.verdict === "filed" || r.verdict === "missed_filing" || r.verdict === "no_ticket_by_ruling").length,
    filings: {
      filed: filed.length,
      missedFiling: read.filter((r) => r.verdict === "missed_filing").length,
      noTicketByRuling: read.filter((r) => r.verdict === "no_ticket_by_ruling").length,
      filedNotNeeded: read.filter((r) => r.verdict === "filed_not_needed").length,
      correctlyNotFiled: read.filter((r) => r.verdict === "correctly_not_filed").length,
      filedWhenDue: rate(filed.length, due.length),
    },
    clean: rate(filed.filter((r) => r.clean).length, filed.length),
    department: {
      checked: deptChecked.length,
      match: rate(deptChecked.filter((r) => r.department === "match").length, deptChecked.length),
      mismatch: rate(deptChecked.filter((r) => r.department === "mismatch").length, deptChecked.length),
      noRule: filed.filter((r) => r.department === "no_rule").length,
      movedByStaff: rate(filed.filter((r) => r.movedByStaff).length, filed.length),
    },
    fields,
    recordsRequester: {
      checked: req.length,
      correct: rate(req.filter((r) => r.recordsRequester === "correct").length, req.length),
      wrong: rate(req.filter((r) => r.recordsRequester === "wrong").length, req.length),
      missing: rate(req.filter((r) => r.recordsRequester === "missing").length, req.length),
    },
    urgencyMissed: read.filter((r) => r.urgencyMissed).length,
    lanes,
    defects,
  };
}
