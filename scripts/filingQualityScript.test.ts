import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./filing-quality";

/** Synthetic people only. */
const sid = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;
const expectation = {
  shouldFile: true, noFileReason: null, topic: "records", urgent: false, callerRole: "provider_office_or_facility",
  requesterName: "Pat Example", requesterOrganization: "Example Rheumatology", patientFirstName: "Testa", patientLastName: "Patientson",
  patientDob: "1958-01-04", callbackNumber: "9095550142", callbackIsCallerId: true, email: null, officeNamed: null, providerNamed: null,
  medicationNamed: null, recordsDelivery: "fax", contactPreference: null, requestSummary: "Provider requests records",
};

describe("scripts/filing-quality.ts", () => {
  it("matches the two exports on call SID and prints counts and SIDs, never what was said", () => {
    const dir = mkdtempSync(join(tmpdir(), "fq-"));
    const exp = join(dir, "exp.json");
    const tix = join(dir, "tix.json");
    writeFileSync(exp, JSON.stringify([
      // The export tool may hand the jsonb column back as text.
      { call_sid: sid(1), agent_used: "no-ivr", call_started_at: "2026-11-07T21:40:00Z", runtime_outcome: "caller_hangup", expectation: JSON.stringify(expectation), skipped_reason: null },
      { call_sid: sid(2), agent_used: "records", call_started_at: "2026-11-07T22:00:00Z", runtime_outcome: "agent_ended", expectation, skipped_reason: null },
    ]));
    writeFileSync(tix, JSON.stringify([
      {
        call_sid: sid(1), ticket_number: "VA-1", filed_department_id: 8, department_id: 16, priority: "medium", location_id: null, provider_id: null,
        patient_first_name: "Unnamed", patient_last_name: "Caller", patient_birth_month: null, patient_birth_day: null, patient_birth_year: null,
        patient_phone: "+19095550142", patient_email: null, records_requestor_type: "patient", records_request_pathway: "roa_patient",
        records_requestor_name: null, pcp_caller_name: null, pcp_caller_organization: null, pcp_caller_callback_number: null, pcp_caller_email: null,
        merged: false, created_at: "2026-11-07T21:41:30Z",
      },
      // A ticket for a call outside the expectation window is not matched.
      { call_sid: sid(9), ticket_number: "VA-9", filed_department_id: 3, department_id: 3 },
    ]));
    const out = run(exp, tix, { from: "2026-11-07T00:00:00Z", to: "2026-11-08T00:00:00Z" });
    expect(out.callsRead).toBe(2);
    expect(out.filings.filed).toBe(1);
    expect(out.filings.missedFiling).toBe(1);
    expect(out.defects.missedFiling).toEqual([sid(2)]);
    expect(out.defects.recordsRequesterWrong).toEqual([sid(1)]);
    expect(out.defects.departmentMismatch).toEqual([sid(1)]);
    expect(out.promptVersion).toMatch(/^fq-/);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/Testa|Patientson|Pat Example|Rheumatology|9095550142|1958|Unnamed/);
  });

  it("a call owns the ticket its write-back names, a withdrawn ticket is no filing, and a silent call is not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "fq-"));
    const exp = join(dir, "exp.json");
    const tix = join(dir, "tix.json");
    const refill = { ...expectation, topic: "medication_or_refill", callerRole: "patient", requesterName: null, requesterOrganization: null, recordsDelivery: null };
    writeFileSync(exp, JSON.stringify([
      // Call 1 filed VA-1; the patient's callback (call 2) was folded onto it
      // and the app re-stamped VA-1's call_sid with call 2's.
      { call_sid: sid(1), agent_used: "tech", call_started_at: "2026-11-07T18:00:00Z", runtime_outcome: "agent_ended", ticket_number: "VA-1", expectation: refill, skipped_reason: null },
      // A PCP caller who hung up untold: the ticket was withdrawn (v100).
      { call_sid: sid(3), agent_used: "pcp", call_started_at: "2026-11-07T19:00:00Z", runtime_outcome: "caller_hangup", ticket_number: "PCP-3", expectation: refill, skipped_reason: null },
      // Never heard.
      { call_sid: sid(4), agent_used: "tech", call_started_at: "2026-11-07T20:00:00Z", runtime_outcome: "caller_hangup", ticket_number: null, expectation: null, skipped_reason: "no_caller_line" },
    ]));
    writeFileSync(tix, JSON.stringify([
      { call_sid: sid(2), ticket_number: "VA-1", filed_department_id: 3, department_id: 3, patient_first_name: "Testa", patient_last_name: "Patientson",
        patient_birth_month: "1", patient_birth_day: "4", patient_birth_year: "1958", patient_phone: "+19095550142", created_at: "2026-11-07T18:01:00Z" },
      { call_sid: sid(3), ticket_number: "PCP-3", filed_department_id: 18, department_id: 18, withdrawn: true, created_at: "2026-11-07T19:01:00Z" },
    ]));
    const out = run(exp, tix);
    expect(out.callsRead).toBe(2);
    expect(out.filings.filed).toBe(1);
    expect(out.filings.missedFiling).toBe(0);
    expect(out.filings.noTicketByRuling).toBe(1);
  });

  it("documents both export queries in its header", () => {
    const src = readFileSync(join(__dirname, "filing-quality.ts"), "utf8");
    expect(src).toContain("FROM filing_expectations f");
    expect(src).toContain("LEFT JOIN call_logs c ON c.call_sid = f.call_sid");
    expect(src).toContain("t.created_by_id IS NULL AND t.agent_used IS NOT NULL");
    expect(src).toContain("e.event_type = 'department_transferred'");
  });
});
