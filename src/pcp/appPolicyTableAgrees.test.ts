/**
 * THE POLICY TABLE EXISTS IN TWO REPOSITORIES AND NOTHING RECONCILED THEM.
 *
 * That is how task #149's second defect survived: `grievance_follow_up`
 * defaulted to `HAND_OFF` here and in the ticketing app, which by 2026-09-21
 * was the auto-transfer the operator withdrew on 2026-09-04, and the app's
 * guard turned every ordinary task filed on it into an HTTP 500 the model
 * retried. Measured: 4 calls, 25 refused POSTs.
 *
 * This file is the MIRROR of `lib/pcp/pcpPolicyTablesAgree.test.ts` in the
 * ticketing app. That one pins THIS repo's defaults and checks the app permits
 * them; this one pins THE APP'S `allowedDispositions` and checks this repo
 * never files something the app will refuse. Both directions matter, because
 * the two failures are different: a default the app forbids is a refused POST,
 * and a disposition this side never sends is capability the app is holding for
 * nobody.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE APP'S TABLE IS PINNED AS A LITERAL, READ FROM
 * `lib/pcp/call-purposes.ts` ON 2026-09-21. It cannot be imported — separate
 * repository, separate deployment — so a literal with its date is the honest
 * form. When this goes red, READ THE APP rather than editing the numbers: a
 * disagreement here is the defect, not the test.
 */
import { describe, it, expect } from 'vitest';
import { PCP_CALL_PURPOSES, PCP_CALL_PURPOSE_SLUGS, type PcpDisposition } from './policy';

/** ticketing-app `lib/pcp/call-purposes.ts`, read 2026-09-21. */
const APP_ALLOWED: Record<string, readonly PcpDisposition[]> = {
  schedule_appointment: ['AUTOMATE', 'CREATE_TASK', 'HAND_OFF'],
  reschedule_appointment: ['AUTOMATE', 'CREATE_TASK', 'HAND_OFF'],
  cancel_appointment: ['AUTOMATE', 'CREATE_TASK', 'HAND_OFF'],
  notify_referral_approval: ['CREATE_TASK'],
  check_patient_scheduled: ['AUTOMATE', 'CREATE_TASK'],
  check_patient_kept_appointment: ['AUTOMATE', 'CREATE_TASK'],
  outside_referral_status: ['CREATE_TASK'],
  accessibility_survey: ['CREATE_TASK'],
  new_patient_survey: ['CREATE_TASK'],
  service_inquiry: ['AUTOMATE', 'CREATE_TASK'],
  disability_accommodation: ['CREATE_TASK'],
  provider_information: ['AUTOMATE', 'CREATE_TASK'],
  plan_participation: ['CREATE_TASK'],
  health_plan_visit_inquiry: ['HAND_OFF', 'CREATE_TASK'],
  grievance_follow_up: ['CREATE_TASK', 'HAND_OFF'],
  peer_to_peer: ['HAND_OFF', 'CREATE_TASK'],
  patient_medical_records_request: ['CREATE_TASK'],
  pharmaceutical_representative: ['CREATE_TASK', 'HAND_OFF'],
  patient_caller: ['CREATE_TASK'],
  unclassified_call: ['CREATE_TASK'],
};

describe('this repo never files a disposition the ticketing app refuses', () => {
  it('covers exactly the same slugs, in both directions', () => {
    // A slug added on one side and not the other is an HTTP 400 at the wire —
    // the mechanism that turned 17 requests into nothing on 2026-09-14,
    // because the app's `callPurpose` is a `z.enum`.
    expect([...PCP_CALL_PURPOSE_SLUGS].sort()).toEqual(Object.keys(APP_ALLOWED).sort());
  });

  it('declares a default the app permits, for every purpose', () => {
    for (const purpose of PCP_CALL_PURPOSES) {
      expect(APP_ALLOWED[purpose.slug], purpose.slug).toBeDefined();
      expect(APP_ALLOWED[purpose.slug], `${purpose.slug} default`)
        .toContain(purpose.defaultDisposition);
    }
  });

  it('declares nothing the app will not take, for every purpose', () => {
    for (const purpose of PCP_CALL_PURPOSES) {
      for (const allowed of purpose.allowedDispositions) {
        expect(APP_ALLOWED[purpose.slug], `${purpose.slug} allows ${allowed}`)
          .toContain(allowed);
      }
    }
  });

  /**
   * THE GRIEVANCE PAIRING GETS ITS OWN ASSERTION, because it is the one this
   * whole reconciliation was written after and a generic loop would let it
   * drift back silently.
   *
   * Operator, 2026-09-21: *"grievance department exists but not in the
   * ticketing sense, it is used as a workspace for processing grievances,
   * those can go to the After Hours Hub and they will know how to work it."*
   *
   * So the app files it as a TASK into After Hours. HAND_OFF stays ALLOWED on
   * both sides, which is load-bearing: `eligibleByAsk` still connects a caller
   * who explicitly asks for a person.
   */
  it('keeps grievance_follow_up a task on both sides, with a handoff still allowed', () => {
    const here = PCP_CALL_PURPOSES.find((p) => p.slug === 'grievance_follow_up')!;
    expect(here.defaultDisposition).toBe('CREATE_TASK');
    expect(here.allowedDispositions).toContain('HAND_OFF');
    expect(APP_ALLOWED.grievance_follow_up).toContain('CREATE_TASK');
    expect(APP_ALLOWED.grievance_follow_up).toContain('HAND_OFF');
  });

  /**
   * THE TWO PURPOSES THE `handoffNotAttemptedReason` WORK IS FOR. Both default
   * to HAND_OFF and both must be able to file a TASK, or the reason has nothing
   * to sanction and 3 of the 7 measured calls stay lost.
   */
  it('lets the two handoff-default purposes file a task at all', () => {
    for (const slug of ['peer_to_peer', 'health_plan_visit_inquiry'] as const) {
      const here = PCP_CALL_PURPOSES.find((p) => p.slug === slug)!;
      expect(here.defaultDisposition, slug).toBe('HAND_OFF');
      expect(here.allowedDispositions, slug).toContain('CREATE_TASK');
      expect(APP_ALLOWED[slug], slug).toContain('CREATE_TASK');
    }
  });
});
