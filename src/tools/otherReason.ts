/**
 * "Other - See Description", for whichever department took the call.
 *
 * WHY THIS IS A TABLE AND NOT ONE ID
 *
 * A request_reason belongs to a request_type, and a request_type belongs to
 * exactly one department. So there is no such thing as a single catch-all
 * reason that works everywhere — reason 536 could only ever have been Optical's.
 *
 * Operator, 2026-08-12, on being shown the first version: "can we just make it
 * where 536 Other, instead of going to department one, it goes to the department
 * that took the call?"
 *
 * That is the right requirement and the schema expresses it one way: the same
 * reason NAME in every department, under a "General / Other" type of its own,
 * and the caller picks by department. Every department now has one. A queue that
 * cannot classify a request files it as Other in ITS OWN department, and it
 * reaches the people who answered the phone.
 *
 * WHAT THIS REPLACES
 *
 * Before these rows existed, an unclassifiable request had two routes and both
 * were wrong:
 *
 *   submit-ticket    re-derives the department server-side and defaults to 8.
 *                    VA-50811 was filed by the Optical agent, said in its own
 *                    description "a question about my account that fits no
 *                    optical category", and landed in After Hours Call Service
 *                    with assigned_to_id NULL.
 *   create-ticket    requires a complete triple, so the reason had to be
 *                    borrowed from a procedure the caller never mentioned.
 *
 * Now neither. The department is stated, the reason is true, and the
 * description is just what the caller said.
 *
 * KEEPING THIS HONEST
 *
 * These ids are Support Center rows, and rows can be renamed or deactivated by
 * someone who has never read this file. `otherReasonsMatchDatabase` in the test
 * suite is the guard: it is the query that produced this table, and it fails if
 * the two ever disagree.
 */

export interface OtherReason {
  requestTypeId: number;
  requestType: string;
  requestReasonId: number;
  requestReason: string;
}

const OTHER_REASON_NAME = 'Other - See Description';

/**
 * department id -> its own "Other - See Description".
 *
 * Read from the Support Center on 2026-08-12, after the rows were created. The
 * type ids are not contiguous because they were inserted in one statement and
 * the sequence assigned them in whatever order the rows came back.
 */
const BY_DEPARTMENT: Record<number, { typeId: number; reasonId: number }> = {
  1: { typeId: 66, reasonId: 536 }, // Optical Support
  2: { typeId: 65, reasonId: 535 }, // Surgery Coordination — under Surgery Logistics
  3: { typeId: 72, reasonId: 542 }, // Technicians Support
  4: { typeId: 78, reasonId: 548 }, // Billing
  5: { typeId: 76, reasonId: 546 }, // IT Department
  6: { typeId: 74, reasonId: 544 }, // Facilities
  7: { typeId: 67, reasonId: 537 }, // Marketing
  8: { typeId: 68, reasonId: 538 }, // After Hours Call Service
  9: { typeId: 69, reasonId: 539 }, // HVA Hub
  11: { typeId: 71, reasonId: 541 }, // Research
  12: { typeId: 70, reasonId: 540 }, // CEC Networking
  13: { typeId: 73, reasonId: 543 }, // Azul Payor Portal Support
  15: { typeId: 75, reasonId: 545 }, // OCS Hub
  16: { typeId: 77, reasonId: 547 }, // Medical Records
  17: { typeId: 79, reasonId: 549 }, // Locations
  18: { typeId: 80, reasonId: 550 }, // PCP Support
};

/**
 * The catch-all for this department, or null if it has none.
 *
 * Null is worth handling rather than defaulting: a department not in this table
 * is one created after these rows, and silently filing its calls into another
 * department's Other is exactly the class of bug that produced VA-50811.
 */
export function otherReasonFor(departmentId: number): OtherReason | null {
  const hit = BY_DEPARTMENT[departmentId];
  if (!hit) return null;
  return {
    requestTypeId: hit.typeId,
    requestType: 'General / Other',
    requestReasonId: hit.reasonId,
    requestReason: OTHER_REASON_NAME,
  };
}

/** Every department that has a catch-all. Used by the test that checks the database. */
export function departmentsWithOtherReason(): number[] {
  return Object.keys(BY_DEPARTMENT).map(Number).sort((a, b) => a - b);
}

/** True when this reason id is some department's catch-all. */
export function isOtherReasonId(reasonId: number): boolean {
  return Object.values(BY_DEPARTMENT).some((v) => v.reasonId === reasonId);
}

export { OTHER_REASON_NAME };
