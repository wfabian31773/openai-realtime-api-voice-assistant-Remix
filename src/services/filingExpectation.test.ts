import { describe, expect, it, vi } from "vitest";
import {
  contextLine,
  extractFilingExpectation,
  FILING_EXPECTATION_INSTRUCTIONS,
  FILING_EXPECTATION_SCHEMA,
  hasCallerSpeech,
  isoDate,
  normaliseExpectation,
  tenDigits,
} from "./filingExpectation";

/** Synthetic people only. */
const answer = (over: Record<string, unknown> = {}) => ({
  should_file: true,
  no_file_reason: null,
  topic: "records",
  urgent: false,
  caller_role: "provider_office_or_facility",
  requester_name: "Pat Example",
  requester_organization: "Example Rheumatology",
  patient_first_name: "Testa",
  patient_last_name: "Patientson",
  patient_dob: "1958-01-04",
  callback_number: "(909) 555-0142",
  callback_is_caller_id: true,
  email: null,
  office_named: null,
  provider_named: null,
  medication_named: null,
  records_delivery: "fax",
  contact_preference: null,
  request_summary: "Provider office requests a patient's records",
  ...over,
});

const transcript = "AGENT: Thank you for calling.\nCALLER: I need records for a patient.";

describe("the model's answer is checked, not trusted", () => {
  it("keeps a well-formed answer", () => {
    const e = normaliseExpectation(answer())!;
    expect(e.shouldFile).toBe(true);
    expect(e.topic).toBe("records");
    expect(e.callerRole).toBe("provider_office_or_facility");
    expect(e.patientDob).toBe("1958-01-04");
    expect(e.callbackNumber).toBe("9095550142");
    expect(e.recordsDelivery).toBe("fax");
    expect(e.noFileReason).toBeNull();
  });

  it("an answer with no usable topic, role or should_file is not an expectation", () => {
    expect(normaliseExpectation(answer({ topic: "weather" }))).toBeNull();
    expect(normaliseExpectation(answer({ caller_role: "alien" }))).toBeNull();
    expect(normaliseExpectation(answer({ should_file: "yes" }))).toBeNull();
    expect(normaliseExpectation(null)).toBeNull();
    expect(normaliseExpectation("text")).toBeNull();
  });

  it("drops a value outside its enum to null instead of keeping it", () => {
    const e = normaliseExpectation(answer({ records_delivery: "carrier pigeon", contact_preference: "telegram" }))!;
    expect(e.recordsDelivery).toBeNull();
    expect(e.contactPreference).toBeNull();
  });

  it("a non-filing always carries a reason, defaulting to other", () => {
    expect(normaliseExpectation(answer({ should_file: false, no_file_reason: "wrong_number_or_robocall" }))!.noFileReason).toBe("wrong_number_or_robocall");
    expect(normaliseExpectation(answer({ should_file: false, no_file_reason: null }))!.noFileReason).toBe("other");
  });

  it("placeholder words are not values", () => {
    const e = normaliseExpectation(answer({ patient_first_name: "unknown", requester_name: "N/A", office_named: "  " }))!;
    expect(e.patientFirstName).toBeNull();
    expect(e.requesterName).toBeNull();
    expect(e.officeNamed).toBeNull();
  });

  it("an email without an @ is not an email", () => {
    expect(normaliseExpectation(answer({ email: "example at mail" }))!.email).toBeNull();
    expect(normaliseExpectation(answer({ email: "pat@example.com" }))!.email).toBe("pat@example.com");
  });
});

describe("dates and numbers", () => {
  it("a date of birth must be a real calendar date", () => {
    expect(isoDate("1958-01-04")).toBe("1958-01-04");
    expect(isoDate("1958-02-30")).toBeNull();
    expect(isoDate("01/04/1958")).toBeNull();
    expect(isoDate("1800-01-01")).toBeNull();
  });

  it("a callback number is ten US digits", () => {
    expect(tenDigits("1-909-555-0142")).toBe("9095550142");
    expect(tenDigits("909 555 0142")).toBe("9095550142");
    expect(tenDigits("555-0142")).toBeNull();
    expect(tenDigits("anonymous")).toBeNull();
  });
});

describe("reading a call", () => {
  it("a transcript with no caller line is not read at all", async () => {
    const ask = vi.fn();
    expect(await extractFilingExpectation({ transcript: "AGENT: Hello?\nAGENT: Are you there?", lane: "tech", callStartedAt: null }, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(hasCallerSpeech("AGENT: hi\nCALLER: hello")).toBe(true);
    expect(hasCallerSpeech("AGENT: hi\nCALLER:   ")).toBe(false);
  });

  it("hands the model the transcript and a context line, and checks what comes back", async () => {
    const ask = vi.fn().mockResolvedValue(answer());
    const e = await extractFilingExpectation({ transcript, lane: "no-ivr", callStartedAt: new Date("2026-11-07T21:40:08Z") }, ask);
    expect(e?.topic).toBe("records");
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ transcript, lane: "no-ivr" }));
  });

  it("a failure is thrown to the worker, not swallowed into a finding", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(extractFilingExpectation({ transcript, lane: "tech", callStartedAt: null }, ask)).rejects.toThrow("boom");
  });

  it("the context line names the line and the time, nothing about the caller", () => {
    const line = contextLine({ transcript: "CALLER: my name is Testa Patientson", lane: "surgery", callStartedAt: new Date("2026-11-09T17:00:00Z") });
    expect(line).toMatch(/^Line: surgery\. Call started \(Pacific\): Monday/);
    expect(line).not.toMatch(/Testa|Patientson/);
  });
});

describe("the question asked", () => {
  it("is a strict schema: every property required, nothing extra", () => {
    expect(FILING_EXPECTATION_SCHEMA.additionalProperties).toBe(false);
    expect([...FILING_EXPECTATION_SCHEMA.required].sort()).toEqual(Object.keys(FILING_EXPECTATION_SCHEMA.properties).sort());
  });

  it("tells the model the transcript is the only source, and the caller's words the only evidence", () => {
    expect(FILING_EXPECTATION_INSTRUCTIONS).toMatch(/ONLY what the transcript says/);
    expect(FILING_EXPECTATION_INSTRUCTIONS).toMatch(/only when the CALLER said it, or clearly confirmed it/);
    expect(FILING_EXPECTATION_INSTRUCTIONS).toMatch(/Never use something only the AGENT said/);
    expect(FILING_EXPECTATION_INSTRUCTIONS).toMatch(/that person's name, not the caller's/);
  });
});
