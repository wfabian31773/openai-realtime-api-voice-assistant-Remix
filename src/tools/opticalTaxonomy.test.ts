/**
 * Optical classification, against the categories Optical actually has.
 *
 * The number this exists to move, measured on 90 days of real tickets
 * (1,744, 97% of them filed by a voice agent):
 *
 *   736 (42%)  no request type at all
 *   953        request_reason_id 153, "Prescription Refill Request", which
 *              belongs to request type 33 "Medication Refill" in department 3,
 *              Technicians Support — not to Optical at all
 *   ~55 (3%)   a classification that is both present and legitimately Optical's
 */
import { describe, it, expect } from 'vitest';
import {
  classifyOptical,
  classificationByReasonId,
  OPTICAL_CLASSIFICATIONS,
  OPTICAL_REASON_IDS,
  OPTICAL_DEPARTMENT_ID,
} from './opticalTaxonomy';

describe('the taxonomy matches the one in the Support Center', () => {
  it('is department 1 and nothing else', () => {
    expect(OPTICAL_DEPARTMENT_ID).toBe(1);
  });

  it('carries all 18 pairs, and only types Optical owns', () => {
    expect(OPTICAL_CLASSIFICATIONS).toHaveLength(18);
    // Frame Selection, Lens Issues, Contact Lenses, Product Pickup.
    const types = [...new Set(OPTICAL_CLASSIFICATIONS.map((c) => c.requestTypeId))].sort();
    expect(types).toEqual([1, 2, 3, 5]);
  });

  it('cannot express reason 153, whatever anyone asks for', () => {
    // The single most common wrong value on this queue. It is a Technicians
    // Support medication-refill reason and it is not in this set.
    expect(OPTICAL_REASON_IDS.has(153)).toBe(false);
    expect(classificationByReasonId(153)).toBeNull();
  });

  it('never pairs a reason with a type it does not belong to', () => {
    // Every pair below was read out of request_types / request_reasons. This
    // asserts the file has not drifted into inventing combinations.
    const validPairs = new Set([
      '1:1', '1:2', '1:3', '1:4', '1:5',
      '2:6', '2:7', '2:8', '2:9', '2:10',
      '3:11', '3:12', '3:13', '3:14', '3:15',
      '5:20', '5:21', '5:22',
    ]);
    for (const c of OPTICAL_CLASSIFICATIONS) {
      expect(validPairs, `${c.requestType} / ${c.requestReason}`).toContain(
        `${c.requestTypeId}:${c.requestReasonId}`,
      );
    }
  });
});

describe('what callers actually say', () => {
  const cases: Array<[string, string]> = [
    // Taken from the shape of real answering-service transcripts.
    ['I need to pick up my glasses if they\'re ready', 'Glasses Ready - Pickup'],
    ['my glasses broke at the hinge', 'Frame Repair Needed'],
    ['these are too loose, they keep slipping', 'Frame Adjustment'],
    ['I need to order more contacts, I\'m running out of contacts', 'Contact Lens Order'],
    ['the new prescription is wrong, everything is blurry', 'Wrong Prescription'],
    ['there\'s a scratch on the left lens', 'Scratched Lenses'],
    ['I\'m having trouble getting used to the progressive lenses', 'Progressive Lens Adaptation'],
    ['my daughter needs kids glasses', 'Kids Frames'],
    ['I have a new prescription and need to pick out frames', 'New Rx - Frame Selection'],
    ['my contacts hurt and my eyes are red', 'Contact Lens Irritation'],
  ];

  for (const [said, expected] of cases) {
    it(`"${said}" -> ${expected}`, () => {
      expect(classifyOptical(said)?.requestReason).toBe(expected);
    });
  }

  it('prefers the specific over the generic', () => {
    // Both "glasses ready" and "glasses" are present. Pickup must win, or every
    // pickup call lands in Frame Selection — which is exactly what 830 tickets
    // in the live data did.
    const c = classifyOptical('hi, are my new glasses ready to pick up?');
    expect(c?.requestType).toBe('Product Pickup');
  });
});

describe('refusing to classify is a real answer', () => {
  it('returns null rather than forcing a fit', () => {
    expect(classifyOptical('I want to talk to someone about my bill')).toBeNull();
    expect(classifyOptical('')).toBeNull();
    expect(classifyOptical('   ')).toBeNull();
  });

  it('returns null for a reason id from another department', () => {
    expect(classificationByReasonId(212)).toBeNull(); // Patient Assistance, dept 3
    expect(classificationByReasonId(42)).toBeNull(); // Cataract consult, surgery
  });
});
