/**
 * The department allowlist that quietly turned real tickets into medication
 * tickets.
 *
 * `getValidatedTicketIds` exists to stop a malformed triple reaching the
 * ticketing API. It did the opposite for ten departments: its allowlist was
 * `[1, 2, 3, 11, 12]`, and anything outside it was replaced with
 * `DEFAULT_TICKET.departmentId` — 3, Technicians Support, the medication
 * queue. Because the type is then derived from the validated department and
 * the reason from the validated type, ONE wrong department silently rewrote
 * the whole ticket to 3 / 8 / 212.
 *
 * Two of the five it did allow (11 Research, 12 CEC Networking) are inactive
 * in the Support Center's own `departments` table. Ten live ones were not
 * there at all. Voice tickets on those since 2026-06-01:
 *
 *   9  HVA Hub          1,741      16 Medical Records   631
 *   8  After Hours        874      18 PCP Support       198
 *   15 OCS Hub            631      17 Locations         125
 *
 * Standing instruction 10 sends schedule-related requests to the HVA Hub from
 * every queue, so department 9 is the routing target of a documented rule.
 *
 * It was not firing at volume — only `syncAgentService` and
 * `ticketOutboxService` call this, and the queue tools go straight to
 * `createTicket` — but it is why those queue tools cannot be routed through
 * the existing outbox, which is what sent me looking.
 *
 * There was no test file for this function at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { getValidatedTicketIds, DEFAULT_TICKET } from './answeringServiceTicketing';

/**
 * Read from the Support Center `departments` table on 2026-09-01.
 * Active: 1 Optical, 2 Surgery, 3 Technicians, 4 Billing, 5 IT, 6 Facilities,
 * 7 Marketing, 8 After Hours, 9 HVA Hub, 15 OCS Hub, 16 Medical Records,
 * 17 Locations, 18 PCP Support. Inactive: 11, 12, 13.
 */
const LIVE_DEPARTMENTS_WITH_VOICE_TRAFFIC = [
  { id: 9, name: 'HVA Hub', ticketsSinceJune: 1741 },
  { id: 8, name: 'After Hours Call Service', ticketsSinceJune: 874 },
  { id: 15, name: 'OCS Hub', ticketsSinceJune: 631 },
  { id: 16, name: 'Medical Records', ticketsSinceJune: 631 },
  { id: 18, name: 'PCP Support', ticketsSinceJune: 198 },
  { id: 17, name: 'Locations', ticketsSinceJune: 125 },
  { id: 4, name: 'Billing', ticketsSinceJune: 66 },
];

describe('getValidatedTicketIds keeps the department it was given', () => {
  for (const dept of LIVE_DEPARTMENTS_WITH_VOICE_TRAFFIC) {
    it(`passes ${dept.name} (${dept.id}) through untouched`, () => {
      // The WHOLE triple, not just the department. Keeping the department and
      // still rewriting the type and reason produces an inconsistent triple,
      // and create-ticket takes the triple or nothing — so that would turn a
      // quiet misroute into a refused ticket. Worse, not better.
      const out = getValidatedTicketIds(dept.id, 62, 536);
      expect(
        out.departmentId,
        `${dept.name} carries ${dept.ticketsSinceJune} voice tickets since June and ` +
          `must not be rewritten to ${DEFAULT_TICKET.departmentId}`,
      ).toBe(dept.id);
      expect(out.requestTypeId, 'the type was rewritten to a Technicians type').toBe(62);
      expect(out.requestReasonId, 'the reason was rewritten to a Technicians reason').toBe(536);
    });
  }

  it('keeps the three queue departments the old list did allow', () => {
    expect(getValidatedTicketIds(1, 9999, 9999).departmentId).toBe(1);
    expect(getValidatedTicketIds(2, 9999, 9999).departmentId).toBe(2);
    expect(getValidatedTicketIds(3, 9999, 9999).departmentId).toBe(3);
  });

  it('still corrects a type that belongs to another department', () => {
    // The behaviour worth keeping: department 1 with a type owned by another
    // department gets department 1's own default type, not a foreign one.
    // This is the guard that keeps a queue off another queue's reasons.
    const out = getValidatedTicketIds(1, 10 /* Cataract Surgery, dept 2 */, 42);
    expect(out.departmentId).toBe(1);
    expect(out.requestTypeId).not.toBe(10);
  });

  it('is loud about a department it genuinely does not know', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = getValidatedTicketIds(4242, 1, 1);
    // Falling back is still right — losing the request is worse than filing it
    // somewhere a human will see it — but it must never be silent again.
    expect(out.departmentId).toBe(DEFAULT_TICKET.departmentId);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/UNKNOWN DEPARTMENT 4242/);
    err.mockRestore();
  });
});
