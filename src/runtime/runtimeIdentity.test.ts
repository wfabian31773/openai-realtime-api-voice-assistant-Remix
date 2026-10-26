/**
 * THE RECORD REACHES THE CALL ROW — v51. The identity a call row carries is
 * the one the tools established, read through the accessor that already
 * refuses a candidate. Synthetic caller.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { identityForRow } from "./runtimeIdentity";
import { rememberVerifiedIdentity, resetVerifiedIdentities } from "../tools/verifiedIdentity";

const SID = "CA000000000000000000000000000000e1";

beforeEach(() => resetVerifiedIdentities());

describe("identityForRow", () => {
  it("a CERTAIN match becomes the row's identity", () => {
    rememberVerifiedIdentity(SID, { firstName: "Zelda", lastName: "Quixote", dateOfBirth: "1958-01-04", certain: true });
    expect(identityForRow(SID)).toEqual({ patientFound: true, patientName: "Zelda Quixote", patientDob: "1958-01-04" });
  });

  it("a certain match with no date of birth carries the name and no date", () => {
    rememberVerifiedIdentity(SID, { firstName: "Zelda", lastName: "Quixote", certain: true });
    expect(identityForRow(SID)).toEqual({ patientFound: true, patientName: "Zelda Quixote" });
  });

  it("an UNCERTAIN match — a phone candidate — produces nothing: a candidate is not an identity", () => {
    rememberVerifiedIdentity(SID, { firstName: "Zelda", lastName: "Quixote", dateOfBirth: "1958-01-04", certain: false });
    expect(identityForRow(SID)).toEqual({});
  });

  it("no entry, or a sentinel SID, produces nothing", () => {
    expect(identityForRow(SID)).toEqual({});
    rememberVerifiedIdentity("unknown", { firstName: "Zelda", lastName: "Quixote", certain: true });
    expect(identityForRow("unknown")).toEqual({});
    expect(identityForRow(undefined)).toEqual({});
  });
});
