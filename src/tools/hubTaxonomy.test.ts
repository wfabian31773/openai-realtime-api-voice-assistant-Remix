/**
 * Department 9 is where the operator's cross-queue ruling sends every
 * schedule-related call in the practice, so what it does with them matters more
 * than its current 18 tickets a day suggests.
 *
 * The cases below are real ticket text from the 90 days to 2026-08-13, or close
 * paraphrases. The most important ones are the collisions: an insurance
 * obstacle mentioned alongside an appointment, a specialist named inside an
 * ordinary booking request.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHub,
  classifyHubRequest,
  hubReasonById,
  HUB_CATCHALL,
  HUB_CLASSIFICATIONS,
  HUB_REASON_IDS,
} from './hubTaxonomy';
import { SCHEDULING } from './queueRouting';

const reason = (t: string) => classifyHub(t)?.requestReasonId;

describe('the specialist signal is not lost in the generic bucket', () => {
  // 152 has been used ONCE in 90 days while the unclassified pile is full of
  // these. A cornea consult is a different scheduling problem from a routine
  // exam: different provider list, different slot length, often a referral to
  // chase first.
  const cases: string[] = [
    'Cornea Specialist Consultation Request',
    'Request to schedule earlier appointment with glaucoma specialist',
    'New patient appointment request with pediatric optometrist',
    'Patient called regarding her schedule for oculoplastics',
    'Pt needs to set-up a Cataract consult for his cataract to be evaluated',
    'I was referred to a retina specialist',
  ];
  for (const text of cases) {
    it(`"${text.slice(0, 44)}…"`, () => {
      expect(reason(text), text).toBe(152);
    });
  }

  it('still files an ordinary exam as a new appointment', () => {
    expect(reason('Request to schedule a new eye exam appointment')).toBe(146);
    expect(reason('Request to schedule regular check-up')).toBe(146);
  });
});

describe('an insurance obstacle is not an appointment request', () => {
  it('prior authorization', () => {
    expect(reason('Pre-authorization request for retina specialist')).toBe(180);
    expect(reason('Checking approval status of retina shot')).toBe(180);
  });

  it('outranks the specialist and appointment cues in the same sentence', () => {
    // "Pre-authorization request for retina specialist" names a specialist AND
    // an obstacle. The obstacle is the reason the patient rang.
    const r = classifyHub('Pre-authorization request for retina specialist');
    expect(r?.requestTypeId).toBe(37);
  });

  it('verification, benefits and coverage are separate', () => {
    expect(reason('I need to verify my insurance before the visit')).toBe(178);
    expect(reason('what are my benefits for this')).toBe(179);
    expect(reason('do you accept Blue Shield')).toBe(181);
  });
});

describe('the interpreter split needs both halves', () => {
  it('an in-office interpreter booking', () => {
    // Real ticket: "is scheduled for September 14... and is requesting an
    // interpreter".
    expect(reason('Patient is scheduled for September 14 and is requesting an interpreter')).toBe(293);
  });

  it('a telephonic one', () => {
    expect(reason('she needs a phone interpreter for the call')).toBe(294);
    expect(reason('interpreter over the phone please')).toBe(294);
  });

  it('does NOT read "over the phone" alone as an interpreter request', () => {
    // The whole reason alsoRequires exists. Without it this is a 294.
    expect(reason('can we just do this over the phone')).not.toBe(294);
  });

  it('handles the accented spelling', () => {
    expect(reason('necesita un intérprete')).toBe(293);
    expect(reason('necesita un interprete')).toBe(293);
  });
});

describe('it shares the scheduling table rather than copying it', () => {
  it('carries every reason from queueRouting\'s SCHEDULING', () => {
    // If these ever diverge, a caller redirected here from another queue gets a
    // different reason than one who dialled this line directly with the same
    // words. The table is exported precisely so that cannot happen.
    for (const s of SCHEDULING) {
      expect(HUB_REASON_IDS, `reason ${s.reasonId} missing`).toContain(s.reasonId);
    }
  });

  it('classifies the Spanish that department 8 is full of', () => {
    expect(reason('Solicitud de cita para examen de la vista')).toBe(146);
    expect(reason('Solicitud de reprogramación de cita')).toBe(147);
    expect(reason('Cancelación de la cita programada para hoy')).toBe(148);
  });
});

describe('type 40 is dead and nothing files into it', () => {
  it('never uses a Scheduling Request reason', () => {
    // 189-192 carry the same four concepts as type 32 and have nine tickets in
    // 90 days against type 32's 735.
    for (const c of HUB_CLASSIFICATIONS) {
      expect(c.requestTypeId).not.toBe(40);
      expect([189, 190, 191, 192]).not.toContain(c.requestReasonId);
    }
  });
});

describe('it never refuses', () => {
  it('falls to department 9\'s own catch-all', () => {
    const r = classifyHubRequest('something nobody has a category for');
    expect(r.isCatchAll).toBe(true);
    expect(r.classification.requestReasonId).toBe(539);
    expect(r.classification.requestTypeId).toBe(69);
  });

  it('never reaches for 153, which is department 3\'s', () => {
    // 224 department 9 tickets carry reason 153 today, put there by the
    // hardcoded fallback in config/answeringServiceTicketing.ts. Nothing in
    // this taxonomy can produce it.
    expect(HUB_REASON_IDS.has(153)).toBe(false);
    expect(hubReasonById(153)).toBeNull();
  });

  it('treats empty and whitespace as unclassifiable rather than throwing', () => {
    expect(classifyHub('')).toBeNull();
    expect(classifyHub('   ')).toBeNull();
    expect(classifyHubRequest('').isCatchAll).toBe(true);
  });
});

describe('the table itself', () => {
  it('has no duplicate reason ids', () => {
    const ids = HUB_CLASSIFICATIONS.map((c) => c.requestReasonId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a pair up by id, and refuses one it does not own', () => {
    expect(hubReasonById(152)?.requestReason).toBe('Specialist Referral Appointment');
    expect(hubReasonById(539)).toBe(HUB_CATCHALL);
    expect(hubReasonById(500)).toBeNull(); // a department 16 reason
  });
});
