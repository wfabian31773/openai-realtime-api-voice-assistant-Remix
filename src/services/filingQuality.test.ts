import { describe, expect, it } from "vitest";
import type { FilingExpectation } from "./filingExpectation";
import {
  compareDob,
  compareEmail,
  compareFiling,
  compareName,
  comparePhone,
  comparePresence,
  compareRecordsRequester,
  DEFECT_LIST_CAP,
  DEPARTMENTS,
  expectedDepartment,
  summarise,
  ticketDob,
  type ExpectationRow,
  type TicketRow,
} from "./filingQuality";

/** Synthetic people only. */
const sid = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;

const expectation = (over: Partial<FilingExpectation> = {}): FilingExpectation => ({
  shouldFile: true,
  noFileReason: null,
  topic: "medication_or_refill",
  urgent: false,
  callerRole: "patient",
  requesterName: null,
  requesterOrganization: null,
  patientFirstName: "Testa",
  patientLastName: "Patientson",
  patientDob: "1958-01-04",
  callbackNumber: "9095550142",
  callbackIsCallerId: true,
  email: null,
  officeNamed: null,
  providerNamed: null,
  medicationNamed: null,
  recordsDelivery: null,
  contactPreference: null,
  requestSummary: "Refill",
  ...over,
});

const ticket = (over: Partial<TicketRow> = {}): TicketRow => ({
  call_sid: sid(1),
  ticket_number: "VA-1",
  filed_department_id: DEPARTMENTS.tech,
  department_id: DEPARTMENTS.tech,
  priority: "medium",
  location_id: null,
  provider_id: null,
  patient_first_name: "Testa",
  patient_last_name: "Patientson",
  patient_birth_month: "1",
  patient_birth_day: "4",
  patient_birth_year: "1958",
  patient_phone: "+19095550142",
  patient_email: null,
  records_requestor_type: null,
  records_request_pathway: null,
  records_requestor_name: null,
  pcp_caller_name: null,
  pcp_caller_organization: null,
  pcp_caller_callback_number: null,
  pcp_caller_email: null,
  merged: false,
  created_at: "2026-11-09T17:01:00Z",
  ...over,
});

const row = (e: FilingExpectation | null, over: Partial<ExpectationRow> = {}): ExpectationRow => ({
  call_sid: sid(1),
  agent_used: "tech",
  call_started_at: "2026-11-09T17:00:00Z",
  runtime_outcome: "agent_ended",
  expectation: e,
  skipped_reason: e ? null : "no_usable_answer",
  ...over,
});

describe("did it file when it should have", () => {
  it("a request with a ticket is filed", () => {
    expect(compareFiling(row(expectation()), [ticket()]).verdict).toBe("filed");
  });
  it("a request with no ticket is a missed filing", () => {
    const c = compareFiling(row(expectation()), []);
    expect(c.verdict).toBe("missed_filing");
    expect(c.clean).toBe(false);
  });
  it("a PCP caller who hung up untold, or chose the queue, files nothing by ruling", () => {
    expect(compareFiling(row(expectation(), { agent_used: "pcp", runtime_outcome: "caller_hangup" }), []).verdict).toBe("no_ticket_by_ruling");
    expect(compareFiling(row(expectation(), { agent_used: "pcp", runtime_outcome: "transferred" }), []).verdict).toBe("no_ticket_by_ruling");
    // The same shape on a queue lane is a real miss.
    expect(compareFiling(row(expectation(), { agent_used: "tech", runtime_outcome: "caller_hangup" }), []).verdict).toBe("missed_filing");
  });
  it("no request and no ticket is right; no request and a ticket is filed-not-needed", () => {
    const none = expectation({ shouldFile: false, noFileReason: "question_answered_on_call" });
    expect(compareFiling(row(none), []).verdict).toBe("correctly_not_filed");
    expect(compareFiling(row(none), [ticket()]).verdict).toBe("filed_not_needed");
  });
  it("a call the reader could not answer is unreadable and judged on nothing", () => {
    const c = compareFiling(row(null), [ticket()]);
    expect(c.verdict).toBe("unreadable");
    expect(c.fields).toEqual({});
  });
});

describe("where it went", () => {
  it("encodes only recorded rulings", () => {
    expect(expectedDepartment("records", "no-ivr", false)).toBe(DEPARTMENTS.medicalRecords);
    expect(expectedDepartment("records", "tech", false)).toBe(DEPARTMENTS.medicalRecords);
    // PCP records: Medical Records for a patient, family, provider, plan or
    // attorney; a pharmaceutical rep or an unidentified professional stays in
    // PCP Support by design (v16), so no rule.
    expect(expectedDepartment("records", "pcp", false, "provider_office_or_facility")).toBe(DEPARTMENTS.medicalRecords);
    expect(expectedDepartment("records", "pcp", false, "patient")).toBe(DEPARTMENTS.medicalRecords);
    expect(expectedDepartment("records", "pcp", false, "pharmacy")).toBeNull();
    expect(expectedDepartment("records", "pcp", false, "unknown")).toBeNull();
    expect(expectedDepartment("scheduling_new_or_change_or_cancel_or_confirm", "pcp", false, "provider_office_or_facility")).toBe(DEPARTMENTS.hvaHub);
    // A professional's other requests stay in PCP Support.
    expect(expectedDepartment("surgery_date_or_surgery_coordination", "pcp", false, "provider_office_or_facility")).toBe(DEPARTMENTS.pcpSupport);
    expect(expectedDepartment("billing", "pcp", false, "health_plan")).toBe(DEPARTMENTS.pcpSupport);
    // A PATIENT on PCP is routed by topic like a queue call (detectCrossQueue):
    // glasses to Optical; anything else is the router's judgement, no rule.
    expect(expectedDepartment("optical_order_or_glasses_or_contacts", "pcp", false, "patient")).toBe(DEPARTMENTS.optical);
    expect(expectedDepartment("medication_or_refill", "pcp", false, "patient")).toBeNull();
    expect(expectedDepartment("surgery_date_or_surgery_coordination", "pcp", false, "patient")).toBeNull();
    expect(expectedDepartment("optical_order_or_glasses_or_contacts", "no-ivr", false)).toBe(DEPARTMENTS.optical);
    expect(expectedDepartment("optical_order_or_glasses_or_contacts", "tech", false)).toBe(DEPARTMENTS.optical);
    expect(expectedDepartment("scheduling_new_or_change_or_cancel_or_confirm", "tech", false)).toBe(DEPARTMENTS.hvaHub);
    expect(expectedDepartment("scheduling_new_or_change_or_cancel_or_confirm", "no-ivr", false)).toBeNull();
    expect(expectedDepartment("surgery_date_or_surgery_coordination", "optical", false)).toBe(DEPARTMENTS.surgery);
    // After hours a same-day request of any topic goes to After Hours (v89), and
    // the transcript cannot say the call was same-day: no surgery rule there.
    expect(expectedDepartment("surgery_date_or_surgery_coordination", "no-ivr", false)).toBeNull();
    expect(expectedDepartment("clinical_question_or_symptom", "no-ivr", true)).toBe(DEPARTMENTS.afterHours);
    expect(expectedDepartment("clinical_question_or_symptom", "no-ivr", false)).toBeNull();
    expect(expectedDepartment("medication_or_refill", "tech", false)).toBeNull();
    expect(expectedDepartment("billing", "tech", false)).toBeNull();
  });

  it("compares where the AGENT filed it, and says when staff moved it", () => {
    const e = expectation({ topic: "records", callerRole: "patient" });
    const moved = compareFiling(row(e, { agent_used: "no-ivr" }), [ticket({ filed_department_id: DEPARTMENTS.afterHours, department_id: DEPARTMENTS.medicalRecords, records_requestor_type: "patient" })]);
    expect(moved.department).toBe("mismatch");
    expect(moved.movedByStaff).toBe(true);
    expect(moved.clean).toBe(false);
    const right = compareFiling(row(e, { agent_used: "no-ivr" }), [ticket({ filed_department_id: DEPARTMENTS.medicalRecords, department_id: DEPARTMENTS.medicalRecords, records_requestor_type: "patient" })]);
    expect(right.department).toBe("match");
    expect(right.movedByStaff).toBe(false);
  });

  it("no ruling is no_rule, never a mismatch", () => {
    expect(compareFiling(row(expectation({ topic: "billing" })), [ticket()]).department).toBe("no_rule");
  });
});

describe("the fields the caller gave", () => {
  it("names: same, a spelling of it, another name, or missing", () => {
    expect(compareName("Testa", "TESTA")).toBe("match");
    expect(compareName("José", "Jose")).toBe("match");
    expect(compareName("Rosa", "Rosa Mae")).toBe("match");
    expect(compareName("Espinoza", "Espinosa")).toBe("variant");
    expect(compareName("Testa", "Margaret")).toBe("differs");
    expect(compareName("Testa", "Unnamed")).toBe("missing");
    expect(compareName("Testa", null)).toBe("missing");
    expect(compareName(null, "Testa")).toBe("beyond_transcript");
    expect(compareName(null, "Unnamed Caller")).toBeNull();
    expect(compareName(null, null)).toBeNull();
  });

  it("date of birth: exact, a two-digit year read by its digits, or missing", () => {
    expect(ticketDob({ patient_birth_month: "1", patient_birth_day: "4", patient_birth_year: "1958" })).toBe("1958-01-04");
    expect(ticketDob({ patient_birth_month: "Unknown", patient_birth_day: null, patient_birth_year: null })).toBeNull();
    expect(compareDob("1958-01-04", ticket())).toBe("match");
    expect(compareDob("1958-01-05", ticket())).toBe("differs");
    expect(compareDob("1958-01-04", ticket({ patient_birth_year: "58" }))).toBe("match");
    expect(compareDob("1958-01-04", ticket({ patient_birth_month: null }))).toBe("missing");
    expect(compareDob(null, ticket())).toBe("beyond_transcript");
  });

  it("callback number by its last ten digits", () => {
    expect(comparePhone("9095550142", "+1 (909) 555-0142")).toBe("match");
    expect(comparePhone("9095550142", "+19095550199")).toBe("differs");
    expect(comparePhone("9095550142", "anonymous")).toBe("missing");
    expect(comparePhone(null, "+19095550142")).toBe("beyond_transcript");
  });

  it("email, case and spacing aside", () => {
    expect(compareEmail("Pat@Example.com", "pat@example.com")).toBe("match");
    expect(compareEmail("pat@example.com", "other@example.com")).toBe("differs");
    expect(compareEmail("pat@example.com", null)).toBe("missing");
  });

  it("office and provider: a routed id or not, names never compared", () => {
    expect(comparePresence("Covina", 12)).toBe("match");
    expect(comparePresence("Covina", null)).toBe("missing");
    expect(comparePresence(null, 12)).toBe("beyond_transcript");
    expect(comparePresence(null, null)).toBeNull();
  });

  it("a field from the record that the caller never said is beyond the transcript, never an error", () => {
    const c = compareFiling(row(expectation({ patientDob: null })), [ticket()]);
    expect(c.fields.patient_dob).toBe("beyond_transcript");
    expect(c.clean).toBe(true);
  });

  it("a field the caller gave and the ticket lacks makes the filing not clean", () => {
    const c = compareFiling(row(expectation({ officeNamed: "Covina" })), [ticket({ location_id: null })]);
    expect(c.fields.office).toBe("missing");
    expect(c.clean).toBe(false);
  });

  it("PCP's callback and requester live in the PCP columns", () => {
    const e = expectation({ topic: "provider_or_office_business", callerRole: "provider_office_or_facility", requesterName: "Pat Example" });
    const c = compareFiling(row(e, { agent_used: "pcp" }), [ticket({ filed_department_id: 18, department_id: 18, patient_phone: null, pcp_caller_callback_number: "9095550142", pcp_caller_name: "Pat Example" })]);
    expect(c.fields.callback_number).toBe("match");
    expect(c.fields.requester).toBe("match");
    expect(c.department).toBe("match");
  });
});

describe("who asked for records (ticket #73052's defect)", () => {
  const provider = expectation({ topic: "records", callerRole: "provider_office_or_facility", requesterName: "Pat Example", requesterOrganization: "Example Rheumatology" });
  it("a provider's request filed as the patient's own is wrong", () => {
    expect(compareRecordsRequester(provider, ticket({ department_id: 16, records_requestor_type: "patient", records_request_pathway: "roa_patient" }))).toBe("wrong");
  });
  it("filed with no requester at all is missing", () => {
    expect(compareRecordsRequester(provider, ticket({ filed_department_id: 16, department_id: 16 }))).toBe("missing");
  });
  it("filed as a provider is correct", () => {
    expect(compareRecordsRequester(provider, ticket({ department_id: 16, records_requestor_type: "provider", records_request_pathway: "third_party_treatment" }))).toBe("correct");
  });
  it("a patient's own request filed as theirs is correct, filed as a provider's is wrong", () => {
    const patient = expectation({ topic: "records", callerRole: "patient" });
    expect(compareRecordsRequester(patient, ticket({ department_id: 16, records_requestor_type: "patient", records_request_pathway: "pending_authorization" }))).toBe("correct");
    expect(compareRecordsRequester(patient, ticket({ department_id: 16, records_requestor_type: "provider", records_request_pathway: "third_party_treatment" }))).toBe("wrong");
  });
  it("only a records ticket is checked", () => {
    expect(compareRecordsRequester(provider, ticket({ filed_department_id: 8, department_id: 8 }))).toBeNull();
    expect(compareRecordsRequester(expectation(), ticket({ department_id: 16 }))).toBeNull();
  });
  it("the whole #73052 shape: after hours, filed in After Hours with a stand-in name, moved, cased as the patient's", () => {
    const e = expectation({ ...provider, patientFirstName: null, patientLastName: null, patientDob: null, callbackNumber: "9095550142" });
    const c = compareFiling(row(e, { agent_used: "no-ivr", runtime_outcome: "caller_hangup" }), [
      ticket({ filed_department_id: 8, department_id: 16, patient_first_name: "Unnamed", patient_last_name: "Caller", patient_birth_month: null, patient_birth_day: null, patient_birth_year: null, records_requestor_type: "patient", records_request_pathway: "roa_patient" }),
    ]);
    expect(c.department).toBe("mismatch");
    expect(c.movedByStaff).toBe(true);
    expect(c.recordsRequester).toBe("wrong");
    expect(c.fields.requester).toBe("missing");
    expect(c.clean).toBe(false);
  });
});

describe("several tickets on one call", () => {
  it("judges the one that carries what the caller said, not the urgent ring-out record", () => {
    const e = expectation({ topic: "clinical_question_or_symptom", urgent: true });
    const ringOut = ticket({ ticket_number: "VA-2", patient_first_name: "Unnamed", patient_last_name: "Caller", patient_birth_month: null, priority: "urgent", created_at: "2026-11-09T17:00:30Z" });
    const request = ticket({ ticket_number: "VA-3", priority: "medium", created_at: "2026-11-09T17:01:00Z" });
    const c = compareFiling(row(e, { agent_used: "no-ivr" }), [ringOut, request]);
    expect(c.ticketNumber).toBe("VA-3");
    expect(c.urgencyMissed).toBe(false);
  });
  it("an urgent symptom with no high or urgent ticket is urgency missed", () => {
    const c = compareFiling(row(expectation({ urgent: true })), [ticket({ priority: "medium" })]);
    expect(c.urgencyMissed).toBe(true);
    expect(c.clean).toBe(false);
  });
});

describe("the summary", () => {
  const rows = [
    compareFiling(row(expectation(), { call_sid: sid(1) }), [ticket({ call_sid: sid(1) })]),
    compareFiling(row(expectation({ officeNamed: "Covina" }), { call_sid: sid(2) }), [ticket({ call_sid: sid(2) })]),
    compareFiling(row(expectation(), { call_sid: sid(3) }), []),
    compareFiling(row(expectation({ shouldFile: false, noFileReason: "no_request" }), { call_sid: sid(4) }), []),
    compareFiling(row(null, { call_sid: sid(5) }), []),
    compareFiling(row(expectation({ patientFirstName: "Testa" }), { call_sid: sid(6) }), [ticket({ call_sid: sid(6), patient_first_name: "Margaret" })]),
  ];
  const s = summarise(rows);

  it("every rate carries its denominator", () => {
    expect(s.callsRead).toBe(6);
    expect(s.unreadable).toBe(1);
    expect(s.filings.filed).toBe(3);
    expect(s.filings.missedFiling).toBe(1);
    expect(s.filings.correctlyNotFiled).toBe(1);
    expect(s.filings.filedWhenDue).toEqual({ n: 3, of: 4, pct: 75 });
    expect(s.clean).toEqual({ n: 1, of: 3, pct: 33.3 });
    expect(s.fields.patient_first_name.supplied).toBe(3);
    expect(s.fields.patient_first_name.differs).toEqual({ n: 1, of: 3, pct: 33.3 });
    expect(s.fields.office.missing).toEqual({ n: 1, of: 1, pct: 100 });
  });

  it("defects are call SIDs and nothing else", () => {
    expect(s.defects.missedFiling).toEqual([sid(3)]);
    expect(s.defects.fieldDiffers.patient_first_name).toEqual([sid(6)]);
    expect(s.defects.fieldMissing.office).toEqual([sid(2)]);
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/Testa|Patientson|Margaret|9095550142|Covina|1958/);
  });

  it("a defect list is capped", () => {
    const many = Array.from({ length: DEFECT_LIST_CAP + 10 }, (_, i) => compareFiling(row(expectation(), { call_sid: sid(100 + i) }), []));
    expect(summarise(many).defects.missedFiling).toHaveLength(DEFECT_LIST_CAP);
  });

  it("splits by lane", () => {
    expect(s.lanes.tech.callsRead).toBe(5);
    expect(s.lanes.tech.missedFiling).toBe(1);
  });
});

describe("review of #440: correct filings are not charged", () => {
  it("a PCP patient's glasses request in Optical matches; a refill in Tech is no rule", () => {
    const glasses = compareFiling(row(expectation({ topic: "optical_order_or_glasses_or_contacts" }), { agent_used: "pcp" }), [ticket({ filed_department_id: DEPARTMENTS.optical, department_id: DEPARTMENTS.optical })]);
    expect(glasses.department).toBe("match");
    const refill = compareFiling(row(expectation(), { agent_used: "pcp" }), [ticket({ filed_department_id: DEPARTMENTS.tech, department_id: DEPARTMENTS.tech })]);
    expect(refill.department).toBe("no_rule");
  });

  it("a PCP professional's records request carries its requester on the records ticket", () => {
    const e = expectation({ topic: "records", callerRole: "provider_office_or_facility", requesterName: "Pat Example", requesterOrganization: "Example Clinic" });
    const c = compareFiling(row(e, { agent_used: "pcp" }), [ticket({
      filed_department_id: DEPARTMENTS.medicalRecords, department_id: DEPARTMENTS.medicalRecords,
      records_requestor_type: "provider", records_request_pathway: "third_party_treatment", records_requestor_name: "Example Clinic",
    })]);
    expect(c.fields.requester).toBe("match");
    expect(c.recordsRequester).toBe("correct");
    expect(c.clean).toBe(true);
  });

  it("a PCP scheduling request in the HVA Hub is not checked for a requester column it cannot have", () => {
    const e = expectation({ topic: "scheduling_new_or_change_or_cancel_or_confirm", callerRole: "provider_office_or_facility", requesterName: "Pat Example" });
    const c = compareFiling(row(e, { agent_used: "pcp" }), [ticket({ filed_department_id: DEPARTMENTS.hvaHub, department_id: DEPARTMENTS.hvaHub })]);
    expect(c.fields.requester).toBeUndefined();
    expect(c.department).toBe("match");
  });

  it("a doctor the caller names is charged as missing on Surgery only", () => {
    const e = expectation({ providerNamed: "Dr. Example" });
    expect(compareFiling(row(e, { agent_used: "pcp" }), [ticket({ filed_department_id: 18, department_id: 18 })]).fields.provider).toBeUndefined();
    expect(compareFiling(row(e, { agent_used: "tech" }), [ticket()]).fields.provider).toBeUndefined();
    expect(compareFiling(row(e, { agent_used: "surgery" }), [ticket({ filed_department_id: 2, department_id: 2 })]).fields.provider).toBe("missing");
    expect(compareFiling(row(e, { agent_used: "tech" }), [ticket({ provider_id: 7 })]).fields.provider).toBe("match");
  });

  it("an after-hours surgery-day request filed in After Hours is not a mismatch", () => {
    const e = expectation({ topic: "surgery_date_or_surgery_coordination" });
    const c = compareFiling(row(e, { agent_used: "no-ivr" }), [ticket({ filed_department_id: DEPARTMENTS.afterHours, department_id: DEPARTMENTS.afterHours })]);
    expect(c.department).toBe("no_rule");
  });

  it("an urgent symptom whose ring-out record is in After Hours matches, beside a request ticket elsewhere", () => {
    const e = expectation({ topic: "clinical_question_or_symptom", urgent: true });
    const request = ticket({ ticket_number: "VA-1", filed_department_id: DEPARTMENTS.tech, department_id: DEPARTMENTS.tech, priority: "medium" });
    const record = ticket({ ticket_number: "VA-2", filed_department_id: DEPARTMENTS.afterHours, department_id: DEPARTMENTS.afterHours, priority: "urgent", patient_first_name: "Unnamed", patient_last_name: "Caller", created_at: "2026-11-09T17:05:00Z" });
    const c = compareFiling(row(e, { agent_used: "no-ivr" }), [request, record]);
    expect(c.department).toBe("match");
    expect(c.filedDepartment).toBe(DEPARTMENTS.afterHours);
    expect(c.urgencyMissed).toBe(false);
  });

  it("one person charted twice: another surname with the first name and date of birth agreeing is a spelling", () => {
    const c = compareFiling(row(expectation({ patientLastName: "Maidenname" })), [ticket({ patient_last_name: "Marriedname" })]);
    expect(c.fields.patient_last_name).toBe("variant");
    expect(c.clean).toBe(true);
    const wrongPerson = compareFiling(row(expectation({ patientLastName: "Maidenname", patientDob: "1960-02-02" })), [ticket({ patient_last_name: "Marriedname" })]);
    expect(wrongPerson.fields.patient_last_name).toBe("differs");
  });
});
