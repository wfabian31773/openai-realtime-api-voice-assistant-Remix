/**
 * The taxonomy's order is its whole design, so the order is what is tested.
 *
 * Every phrase below is taken from, or closely modelled on, a real Surgery
 * Coordination ticket description in the Support Center. Inventing the test
 * phrases would test my idea of how people talk, which is the same idea that
 * produced the cue lists — and a test written from the understanding that
 * produced a bug inherits its blind spot. That happened on the Optical build.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySurgery,
  classifySurgeryLogistics,
  surgeryClassificationByReasonId,
  SURGERY_CLASSIFICATIONS,
  SURGERY_REASON_IDS,
} from './surgeryTaxonomy';

describe('the pairs are real', () => {
  it('every reason belongs to its own type', () => {
    // Reason ids and type ids read from the Support Center on 2026-08-12.
    const validPairs: Record<number, number[]> = {
      10: [42, 43, 44, 45, 46, 47],
      11: [48, 49, 50, 51, 52],
      12: [53, 54, 55, 56],
      13: [57, 58, 59, 60],
    };
    for (const c of SURGERY_CLASSIFICATIONS) {
      expect(
        validPairs[c.requestTypeId],
        `type ${c.requestTypeId} is not one of Surgery Coordination's four`,
      ).toBeTruthy();
      expect(
        validPairs[c.requestTypeId],
        `reason ${c.requestReasonId} (${c.requestReason}) does not belong to type ${c.requestTypeId}`,
      ).toContain(c.requestReasonId);
    }
  });

  it('covers all 19 and repeats none', () => {
    expect(SURGERY_CLASSIFICATIONS).toHaveLength(19);
    expect(SURGERY_REASON_IDS.size).toBe(19);
  });

  it('cannot express reason 153, the medication-refill reason', () => {
    // 1,443 surgery tickets carried it until 2026-06-22.
    expect(SURGERY_REASON_IDS.has(153)).toBe(false);
    expect(surgeryClassificationByReasonId(153)).toBeNull();
  });
});

describe('order — the specific cue must beat the generic one', () => {
  const cases: Array<[string, number, string]> = [
    // The collision that motivated the ordering, in both directions.
    ['I had my right eye done in June, I want to get the second eye scheduled', 47, 'second eye before scheduling'],
    ['I need to schedule my surgery', 43, 'plain scheduling'],
    // Post-op means different reasons on different procedures.
    ['I have a question about my vision since my LASIK', 51, 'post-refractive, not post-op'],
    ['I need to move my post-op appointment', 46, 'cataract post-op'],
    // Cataract consult is LAST and narrow — it is the reason 1,710 tickets
    // wrongly carry, so it must only fire when someone actually asks for one.
    ['my doctor told me I have cataracts and I need an evaluation', 42, 'a real consult request'],
    // Emergencies outrank everything.
    ['I have a curtain over my left eye since this morning', 53, 'detachment first'],
    ['there is a shower of floaters and flashes in my right eye', 53, 'detachment first'],
    // The distinctive procedure words.
    ['I want to ask about the lens options, the multifocal one', 44, 'IOL'],
    ['I need to come in for my A-scan', 45, 'pre-op measurements'],
    ['I have a stye on my eyelid that keeps coming back', 60, 'chalazion'],
    ['my eyelid is drooping and I was told about ptosis repair', 57, 'ptosis'],
    ['I am interested in LASIK', 48, 'lasik consult'],
  ];

  for (const [text, reasonId, why] of cases) {
    it(`${why}: "${text.slice(0, 48)}…" → ${reasonId}`, () => {
      const hit = classifySurgery(text);
      expect(hit, 'expected a classification').toBeTruthy();
      expect(hit!.requestReasonId).toBe(reasonId);
    });
  }
});

describe('null is the answer for the calls the taxonomy has no box for', () => {
  // These are the real majority of this queue. Verbatim and near-verbatim from
  // production descriptions, 2026-07 and 2026-08.
  const unclassifiable: Array<[string, string]> = [
    ['I have not received my three eye drop prescriptions. My surgery is 8/3.', 'drops_rx'],
    ['Following up on the pre-op document that my primary care needs to sign.', 'clearance'],
    ['Please cancel my Aug 10 2026 surgery appointment.', 'reschedule'],
    ['Can you verify what time I should be there, I have to arrange transportation with access.', 'arrival'],
    ['Patient wanted to reach out in regard to surgery and surgery deposit.', 'financial'],
    ['He said he has been waiting for a callback for 2 months and still has not heard.', 'status'],
  ];

  for (const [text, bucket] of unclassifiable) {
    it(`"${text.slice(0, 44)}…" is not forced into a box`, () => {
      expect(
        classifySurgery(text),
        'this got a category it has no business having — that is the 1,710-ticket defect',
      ).toBeNull();
    });

    it(`"${text.slice(0, 44)}…" is recognised as ${bucket}`, () => {
      const b = classifySurgeryLogistics(text);
      expect(b, 'no logistics bucket matched').toBeTruthy();
      expect(b!.key).toBe(bucket);
    });
  }

  it('a reschedule of a POST-OP appointment keeps the post-op reason', () => {
    // Logistics is checked only after classifySurgery returns null, never
    // instead of it. This is the case that proves the ordering between the two.
    const hit = classifySurgery('I need to move my post-op appointment to the morning');
    expect(hit?.requestReasonId).toBe(46);
  });

  it('empty input classifies as nothing rather than as something', () => {
    expect(classifySurgery('')).toBeNull();
    expect(classifySurgery('   ')).toBeNull();
    expect(classifySurgeryLogistics('')).toBeNull();
  });
});

describe('an explicitly named reason cannot be invented', () => {
  it('accepts one of Surgery\'s own', () => {
    expect(surgeryClassificationByReasonId(43)?.requestReason).toBe('Surgery Scheduling');
  });

  it('rejects a reason from another department', () => {
    expect(surgeryClassificationByReasonId(20)).toBeNull(); // Optical, Glasses Ready
    expect(surgeryClassificationByReasonId(212)).toBeNull(); // Tech, Callback Request
  });
});

describe('the urgent flag', () => {
  it('is on retinal detachment and on nothing else', () => {
    const urgent = SURGERY_CLASSIFICATIONS.filter((c) => c.urgent);
    expect(urgent).toHaveLength(1);
    expect(urgent[0].requestReasonId).toBe(53);
  });
});
