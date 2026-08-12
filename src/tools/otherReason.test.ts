/**
 * The catch-all table is a copy of sixteen Support Center rows, and a copy
 * drifts. These are the checks that catch it drifting.
 */
import { describe, it, expect } from 'vitest';
import {
  otherReasonFor,
  isOtherReasonId,
  departmentsWithOtherReason,
  OTHER_REASON_NAME,
} from './otherReason';

describe('every queue files Other into its OWN department', () => {
  it('gives each department a distinct reason id', () => {
    // The whole point. One shared id would mean one department, which is what
    // the operator rejected: "instead of going to department one, it goes to
    // the department that took the call."
    const ids = departmentsWithOtherReason().map((d) => otherReasonFor(d)!.requestReasonId);
    expect(new Set(ids).size, 'two departments share a catch-all reason id').toBe(ids.length);
  });

  it('gives each department a distinct type id', () => {
    // A request_type belongs to exactly one department, so a shared type id
    // would silently put one department's Other under another's type.
    const ids = departmentsWithOtherReason().map((d) => otherReasonFor(d)!.requestTypeId);
    expect(new Set(ids).size, 'two departments share a catch-all type id').toBe(ids.length);
  });

  it('covers the two queues that have their own agent', () => {
    expect(otherReasonFor(1)).toMatchObject({ requestTypeId: 66, requestReasonId: 536 });
    expect(otherReasonFor(2)).toMatchObject({ requestTypeId: 65, requestReasonId: 535 });
  });

  it('covers every department the answering service can route to', () => {
    // ANSWERING_SERVICE_DEPARTMENTS plus the queues staff route to by hand. If
    // a department here has no catch-all, its unclassifiable calls have nowhere
    // honest to go and the old borrow-a-reason behaviour comes back.
    for (const dept of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15, 16, 17, 18]) {
      expect(otherReasonFor(dept), `department ${dept} has no catch-all`).toBeTruthy();
    }
  });

  it('names them all the same thing', () => {
    for (const dept of departmentsWithOtherReason()) {
      expect(otherReasonFor(dept)!.requestReason).toBe(OTHER_REASON_NAME);
    }
  });

  it('returns null for a department it does not know, rather than guessing', () => {
    // Silently defaulting to another department's Other is precisely the bug
    // that produced VA-50811 — a real ticket, in the wrong department, that
    // reached nobody.
    expect(otherReasonFor(999)).toBeNull();
    expect(otherReasonFor(10)).toBeNull(); // no department 10 exists
  });

  it('recognises its own ids and nothing else', () => {
    expect(isOtherReasonId(535)).toBe(true);
    expect(isOtherReasonId(536)).toBe(true);
    expect(isOtherReasonId(542)).toBe(true);
    // Real reasons that are NOT catch-alls.
    expect(isOtherReasonId(42)).toBe(false); // New Cataract Consult
    expect(isOtherReasonId(153)).toBe(false); // the medication-refill reason
    expect(isOtherReasonId(529)).toBe(false); // Pre-Op Drops / Prescription
  });
});
