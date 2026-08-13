/**
 * Order is the whole design, so order is what is tested.
 *
 * This queue has more cue overlap than any other: a glaucoma drop refill sent
 * to CVS matches three buckets at once. Every phrase below is taken from, or
 * closely modelled on, a real department 3 description — inventing them would
 * test my idea of how people talk, which is the same idea that produced the cue
 * lists.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTech,
  classifyTechRequest,
  techReasonById,
  TECH_CLASSIFICATIONS,
  TECH_CATCHALL,
} from './techTaxonomy';

describe('the pairs are real', () => {
  it('every reason belongs to one of department 3 own types', () => {
    // Read from the Support Center on 2026-08-13.
    const valid: Record<number, number[]> = {
      6: [207, 208, 209, 210],
      7: [211, 212, 213, 214],
      8: [215, 216, 217, 218],
      33: [153, 154, 155, 156, 157, 158],
      72: [542],
    };
    for (const c of [...TECH_CLASSIFICATIONS, TECH_CATCHALL]) {
      expect(valid[c.requestTypeId], `type ${c.requestTypeId} is not department 3's`).toBeTruthy();
      expect(
        valid[c.requestTypeId],
        `reason ${c.requestReasonId} (${c.requestReason}) does not belong to type ${c.requestTypeId}`,
      ).toContain(c.requestReasonId);
    }
  });

  it('uses no reason twice', () => {
    const ids = TECH_CLASSIFICATIONS.map((c) => c.requestReasonId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a named drug beats the generic word for it', () => {
  // 278 descriptions say "glaucoma"; 1,700 name a glaucoma drug. Keying on the
  // condition would miss six of every seven.
  const byDrug: Array<[string, number]> = [
    ['I need a refill of my Latanoprost', 155],
    ['refill for Lumigan eye drops', 155],
    ['my Combigan is almost gone', 155],
    ['medication refill request for Timolol', 155],
    ['refill request for glaucoma medication', 155],
    ['refill for my Eysuvis after cataract surgery', 156],
    ['I need more prednisolone drops', 156],
    ['refill on the combo drops from my surgery', 156],
  ];
  for (const [text, id] of byDrug) {
    it(`"${text.slice(0, 44)}…" → ${id}`, () => {
      expect(classifyTech(text)?.requestReasonId).toBe(id);
    });
  }

  it('falls to the generic drop refill only when no drug is named', () => {
    expect(classifyTech('I need a refill on my eye drops')?.requestReasonId).toBe(154);
  });

  it('falls to the generic refill only when drops are not mentioned either', () => {
    expect(classifyTech('I need a refill on my medication')?.requestReasonId).toBe(153);
  });
});

describe('naming a pharmacy is not a transfer', () => {
  // 2,263 descriptions mention a pharmacy; 59 are transfers. Cueing on pharmacy
  // names would mis-file roughly 2,200 tickets.
  it('stays a refill when a pharmacy is only the destination', () => {
    expect(classifyTech('refill my Latanoprost and send it to CVS')?.requestReasonId).toBe(155);
    expect(classifyTech('please refill my drops, Walgreens on Foothill')?.requestReasonId).toBe(154);
  });

  it('is a transfer only when the words describe moving it', () => {
    for (const text of [
      'I need to transfer my prescription to a different pharmacy',
      'can you switch my pharmacy to the one on Grand',
      'I changed pharmacies, please send it to the new one',
    ]) {
      expect(classifyTech(text)?.requestReasonId, text).toBe(158);
    }
  });
});

describe('a problem outranks a request', () => {
  it('reports a reaction rather than filing a refill', () => {
    expect(classifyTech('my latanoprost is burning my eyes')?.requestReasonId).toBe(209);
    expect(classifyTech('I think I am allergic to the new drops')?.requestReasonId).toBe(209);
  });

  it('reports an insurance block rather than filing a refill', () => {
    expect(classifyTech('insurance denied my Lumigan')?.requestReasonId).toBe(210);
    expect(classifyTech('my Restasis needs a prior auth')?.requestReasonId).toBe(210);
  });

  it('separates having none left from asking for more', () => {
    expect(classifyTech('I am out of refills on my drops')?.requestReasonId).toBe(213);
    expect(classifyTech('my prescription expired')?.requestReasonId).toBe(213);
  });
});

describe('the calls that are not about medication at all', () => {
  const cases: Array<[string, number]> = [
    ['I need a copy of my medical records', 216],
    ['can you fax my records to my primary care', 216],
    ['I have a DMV form that needs filling out', 217],
    ['I need a referral to a retina specialist', 218],
    ['just have someone call me back please', 215],
    ['how often should I use these drops', 211],
    ['can I take this with my blood pressure medicine', 208],
  ];
  for (const [text, id] of cases) {
    it(`"${text.slice(0, 44)}…" → ${id}`, () => {
      expect(classifyTech(text)?.requestReasonId).toBe(id);
    });
  }
});

describe('nothing is forced into a box it did not earn', () => {
  it('falls to department 3 own catch-all, not to reason 153', () => {
    // 153 currently carries 6,905 tickets. It is the LAST medication reason and
    // it is never the fallback.
    const { classification, isCatchAll } = classifyTechRequest('zzz qqq nothing resembling a request');
    expect(isCatchAll).toBe(true);
    expect(classification.requestReasonId).toBe(542);
    expect(classification.requestTypeId).toBe(72);
  });

  it('never lets an agent name a reason from another department', () => {
    expect(techReasonById(42)).toBeNull(); // Surgery, New Cataract Consult
    expect(techReasonById(20)).toBeNull(); // Optical, Glasses Ready
    expect(techReasonById(153)?.requestReason).toBe('Prescription Refill Request');
  });

  it('classifies nothing from an empty request', () => {
    expect(classifyTech('')).toBeNull();
    expect(classifyTechRequest('   ').isCatchAll).toBe(true);
  });
});
