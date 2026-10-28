/**
 * THE LOOKUP THAT MUST NOT SAY "NOT FOUND".
 *
 * VA-76221: a spoken-name miss and a chart-name hit are the same person.
 * The helper that decides whether to retry, and the spoken line the tool
 * is allowed to return, live here so a second caller cannot drift.
 */
import { describe, expect, it } from "vitest";
import {
  LOOKUP_UNSURE_SAY,
  chartNameParts,
  hasVisitHistory,
  payloadSaysNotFound,
  spokenFirstNameAgreesWithChart,
} from "./lookupUnsure";

describe("spokenFirstNameAgreesWithChart", () => {
  it("treats the book's own three-character prefix as agreement", () => {
    expect(spokenFirstNameAgreesWithChart("Dana", "Dana")).toBe(true);
    expect(spokenFirstNameAgreesWithChart("Dan", "Danielle")).toBe(true);
    expect(spokenFirstNameAgreesWithChart("Alex", "Dana")).toBe(false);
  });
});

describe("chartNameParts", () => {
  it("splits the display name, and falls back to patientData", () => {
    expect(chartNameParts({ patientName: "Dana Example" })).toEqual({
      first: "Dana",
      last: "Example",
    });
    expect(
      chartNameParts({ patientData: { firstName: "Dana", lastName: "Example" } }),
    ).toEqual({ first: "Dana", last: "Example" });
  });
});

describe("hasVisitHistory / payloadSaysNotFound", () => {
  it("a phone-loaded schedule with a past visit is history", () => {
    expect(
      hasVisitHistory({
        patientFound: true,
        pastAppointments: [{ location: "Example Vision" } as never],
        upcomingAppointments: [],
        totalAppointmentsFound: 1,
      }),
    ).toBe(true);
  });

  it("the spoken fields must not teach the model to say not-found", () => {
    expect(payloadSaysNotFound({ found: false, message: LOOKUP_UNSURE_SAY })).toBe(false);
    expect(payloadSaysNotFound({ found: false, message: "No record found" })).toBe(true);
    expect(
      payloadSaysNotFound({
        found: false,
        message: LOOKUP_UNSURE_SAY,
        fix: "Do NOT tell the caller they are not found",
      }),
    ).toBe(false);
  });
});
