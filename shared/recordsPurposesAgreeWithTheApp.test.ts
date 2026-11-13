/**
 * THE RECORDS-LINE CLASSIFIER EXISTS IN TWO REPOSITORIES, AND BOTH SAID THEY
 * WERE "KEPT IDENTICAL". THEY NEVER WERE.
 *
 * `shared/records-request-intent.ts` here (voice #381) and in the ticketing
 * app (#406) were written the same day, 2026-10-29, and differed from the
 * first commit. The app's copy decides the final taxonomy and whether a
 * records-line ticket opens a case (`looksLikeVoiceRecordsRequest`). This copy
 * decides what the caller is asked and where the voice side files. On
 * 2026-11-11 (v205's notes) the app's copy was found with two purposes this
 * one lacked, `amendment` and `cancellation`: a correction to the records,
 * and withdrawing a records request. Both are Medical Records work the app
 * keeps off the CAP clock. This copy read "I need to correct my medical
 * records" as an access request. The tool asked for a signing link, how and
 * where to send the records and which dates, and stated `roa_patient` on the
 * clock for it.
 *
 * MEASURED 2026-11-13, before v225, over the 1,268 distinct sentences the two
 * repos' own suites put through the classifier (each suite run with a shim
 * that recorded every input, and both copies run on the union):
 *
 *   purpose differs               563   (553 after v225)
 *   keep-in-Medical-Records flips 356   (356 after v225: amendment and
 *                                        cancellation are kept, like records)
 *   amendment / cancellation       10   (0 after v225)
 *
 * v225 moved exactly those 10 sentences, every one to the app's answer, and no
 * other. Also 57 of 57 synthetic correction/cancellation sentences (precedence
 * against access, scheduling, surgery, optical and billing, and refusals beside
 * them) read the same in both copies. The other 553 are NOT this test's subject: each side has rulings
 * the other lacks ("send my prescription to Walgreens" is clinical here and
 * records there, "I need a copy of my MRI" is records here and unknown there).
 * Reconciling those is a decision per sentence, not a port.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE APP'S LIST, PATTERNS AND READINGS ARE PINNED AS LITERALS, read from
 * ticketing-app `shared/records-request-intent.ts` at `3e61ed30` on
 * 2026-11-13. It cannot be imported (separate repository, separate deployment)
 * so a dated literal is the honest form, as in `src/pcp/appPolicyTableAgrees.test.ts`.
 * When this goes red, READ THE APP rather than editing the literal: a
 * disagreement here is the defect, not the test.
 */
import { describe, expect, it } from 'vitest';
import {
  APP_ACTION_BOUNDARY,
  RECORDS_AMENDMENT,
  RECORDS_CANCELLATION,
  RECORDS_LINE_PURPOSES,
  recordsLinePurpose,
  recordsLineRedirect,
  recordsWorkNotAccess,
  type RecordsLinePurpose,
} from './records-request-intent';

/** ticketing-app `export type RecordsLinePurpose`, in its order, read 2026-11-13. */
const APP_PURPOSES = [
  'records', 'amendment', 'cancellation', 'surgery', 'scheduling', 'referral',
  'professional', 'optical', 'clinical', 'billing', 'unknown',
] as const;

/**
 * Where the app's `recordsLineRedirect` sends each purpose (`targets`, read
 * 2026-11-13); null is "stays in Medical Records". `Record<RecordsLinePurpose, …>`,
 * so a purpose added to this copy is a build error here until someone reads the app.
 */
const APP_TARGET: Record<RecordsLinePurpose, string | null> = {
  records: null,
  amendment: null,
  cancellation: null,
  surgery: 'Surgery Coordination',
  referral: 'PCP Support',
  professional: 'PCP Support',
  optical: 'Optical Support',
  clinical: 'Technicians Support',
  billing: 'Billing',
  unknown: 'HVA Hub',
  scheduling: 'HVA Hub',
};

/**
 * The production department each app target name is. This side files by id.
 * Department 3 is 'Technicians Support' in production (the app's #425, which
 * renamed its own target after every clinical redirect 500'd), and this repo
 * calls the same department 'Clinical Tech Support' fleet-wide. The id is
 * what reaches the wire, so the id is what is compared.
 */
const PRODUCTION_DEPARTMENT_ID: Record<string, number> = {
  'Surgery Coordination': 2,
  'PCP Support': 18,
  'Optical Support': 1,
  'Technicians Support': 3,
  Billing: 4,
  'HVA Hub': 9,
};

/** One sentence per purpose that the app's copy reads as that purpose (run 2026-11-13). */
const APP_READS: Record<RecordsLinePurpose, string> = {
  records: 'Please send my records to my new doctor',
  amendment: 'I need to correct my medical records',
  cancellation: 'Please cancel my records request',
  surgery: 'I have a question about my surgery',
  scheduling: 'I need to reschedule my appointment',
  referral: 'I need a referral',
  professional: 'This is the health plan calling about eligibility',
  optical: 'my glasses order',
  clinical: 'I need a refill on my eye drops',
  billing: 'a question about my bill',
  unknown: 'hello',
};

describe('the purpose list is the app\'s', () => {
  it('has exactly the app\'s purposes, in the app\'s order', () => {
    // A purpose on one side only is a request one side files somewhere the
    // other has no name for — the amendment/cancellation gap of 2026-11-11.
    expect([...RECORDS_LINE_PURPOSES]).toEqual([...APP_PURPOSES]);
  });

  it('keeps in Medical Records exactly what the app keeps', () => {
    for (const purpose of APP_PURPOSES) {
      const text = APP_READS[purpose];
      expect(recordsLinePurpose(text), text).toBe(purpose);
      const redirect = recordsLineRedirect(text);
      const appTarget = APP_TARGET[purpose];
      if (appTarget === null) {
        expect(redirect, `${purpose} stays in Medical Records in the app`).toBeNull();
      } else {
        expect(redirect?.departmentId, `${purpose} -> ${appTarget}`).toBe(PRODUCTION_DEPARTMENT_ID[appTarget]);
      }
    }
  });

  it('treats as not-access exactly the two purposes the app strips the access fields from', () => {
    // ticketing-app `lib/voice-agent/records-intake.ts`: amendment and
    // cancellation keep the records line but delete requestPathway,
    // capClockApplies and formChannel. Nothing else does.
    expect(APP_PURPOSES.filter(recordsWorkNotAccess)).toEqual(['amendment', 'cancellation']);
  });
});

describe('the amendment and cancellation patterns are the app\'s, verbatim', () => {
  // `.source` of the app's RECORDS_AMENDMENT, RECORDS_CANCELLATION and
  // ACTION_BOUNDARY, printed from its copy on 2026-11-13.
  it('RECORDS_AMENDMENT', () => {
    expect(RECORDS_AMENDMENT.source).toBe(
      String.raw`\b(?:correct|amend)\w*\b[^.!?]{0,50}\b(?:(?:medical|patient|health)\s+)?records?\b`,
    );
    expect(RECORDS_AMENDMENT.flags).toBe('');
  });

  it('RECORDS_CANCELLATION', () => {
    expect(RECORDS_CANCELLATION.source).toBe(
      String.raw`\bcancel\w*\b[^.!?]{0,50}\b(?:(?:my|the|this|our)\s+)?(?:medical\s+)?records?\s+request\b`,
    );
    expect(RECORDS_CANCELLATION.flags).toBe('');
  });

  it('the clause boundary a correction is cut at (the app\'s ACTION_BOUNDARY)', () => {
    expect(APP_ACTION_BOUNDARY.source).toBe(
      String.raw`[.!?;\n]+|\bbut\b|,\s*(?=(?:please|just|only)\b)`
      + String.raw`|(?:,\s*|\band\s+)(?=(?:(?:please|just|only)\s+)?(?:(?:i|we|he|she|they)\s+)?(?:do not|don't|does not|doesn't|no longer (?:need|want)|not requesting|not asking for|no need to|\b(?:need|want|request(?:ing|s|ed)?|would like|asking for|necesit\w*|solicit\w*|quiero)\b|\b(?:get|copy|copies|fax(?:ed|ing)?|send|sent|transfer(?:red|ring)?|email(?:ed)?|mail(?:ed)?|forward|release|obtain|retrieve|provide|inspect|inspection|pick(?:ing)? up|collect(?:ed|ing|ion)?|copia|copias|envi\w*|mand\w*)\b|reschedul\w*|schedul\w*|cancel\w*|confirm\w*|book\w*)\b)`
      + String.raw`|\s+(?=(?:(?:i|we|he|she|they)\s+)?(?:do not|don't|does not|doesn't|no longer (?:need|want)|not requesting|not asking for|no need to)\b)`,
    );
  });
});

/**
 * The app's copy run on each sentence, 2026-11-13. The first twelve are the
 * app's own test sentences (its `records-request-intent.test.ts`, the three
 * amendment/cancellation describes); the rest are synthetic precedence cases
 * written for v225, each read by the app's copy rather than by hand. Some of the
 * app's answers are questionable ("I need my records corrected" is records,
 * "Please cancel my records request for my surgery" is surgery), and they are
 * pinned anyway: this side follows the app, and a better reading belongs in
 * the app first.
 */
const APP_READING: ReadonlyArray<readonly [string, RecordsLinePurpose]> = [
  // The app's own tests.
  ['I need to correct my medical records', 'amendment'],
  ['Please cancel my records request', 'cancellation'],
  ['Please cancel my records request; please fax my chart', 'records'],
  ['Please correct my medical records and send me the corrected copy', 'amendment'],
  ['I need a correction to my records, please fax it to my doctor', 'amendment'],
  ['Can you email me after you amend my records', 'amendment'],
  ['Please mail me confirmation once you correct my medical record', 'amendment'],
  ['Please correct the records you emailed me', 'amendment'],
  ['I need to amend the medical records sent last week', 'amendment'],
  ['Please cancel my records request, do not send anything', 'cancellation'],
  ['Cancel my medical records request and email me a confirmation', 'cancellation'],
  ['Please correct the spelling in my medical records. Separately, please send my OCT images to my new doctor', 'records'],
  // A separate copy request beside a correction is still access.
  ['I need to correct my medical records and get a copy of my chart', 'records'],
  ['Please correct my records and fax my chart to Dr Lee', 'records'],
  ['Correct my records and I need a copy of my records', 'records'],
  // A correction outranks every other team's purpose.
  ['I want to correct my records from my surgery', 'amendment'],
  ['I need to correct my records and reschedule my appointment', 'amendment'],
  ['I need to correct my records, and my glasses are broken', 'amendment'],
  ['I need to correct my billing records', 'amendment'],
  ['Please correct my records and send me a copy of my bill', 'amendment'],
  ['Please amend my records, my allergy list is wrong', 'amendment'],
  ['The patient wants to amend her health records', 'amendment'],
  ['We need to correct the patient record from her last visit', 'amendment'],
  ['I need to correct my records so you can fax my chart', 'amendment'],
  ['Please correct my medical records sent to Dr Smith', 'amendment'],
  ['I need to correct my records but do not send anything', 'amendment'],
  // A refused correction is not one, and refusing something else beside a
  // correction or a cancellation does not refuse it. This copy used to drop
  // the whole clause ("…, don't fax my chart" read as unknown).
  ['I do not need to correct my records, I need a copy of my chart', 'records'],
  ['Please correct my records, don\'t fax my chart', 'amendment'],
  ['Please cancel my records request, don\'t send my chart', 'cancellation'],
  ['I don\'t need copies, I need to cancel my records request', 'cancellation'],
  ['I no longer need to correct my records', 'unknown'],
  ['I no longer want to cancel my records request', 'unknown'],
  ['I do not want to cancel my records request, please fax my chart', 'records'],
  // A cancellation is read last, after every other team's purpose.
  ['I want to cancel the records request I made last week', 'cancellation'],
  ['Can you cancel this records request', 'cancellation'],
  ['Please cancel our medical records request for the patient', 'cancellation'],
  ['I need to cancel my records request because I already got them', 'cancellation'],
  ['Cancel my records request and fax my chart to Dr Lee instead', 'records'],
  ['Please cancel my records request for my surgery', 'surgery'],
  ['Please cancel my records request and reschedule my appointment', 'scheduling'],
  ['Cancel my records request, I have a billing question', 'billing'],
  ['Cancel my records request, I need my glasses fixed', 'optical'],
  ['I called to cancel my appointment', 'scheduling'],
  // The app's vocabulary stops here; so does this side's.
  ['I need my records corrected', 'records'],
  ['I want to withdraw my records request', 'records'],
  ['I want to correct my notes', 'unknown'],
  ['Corrija mis registros por favor', 'unknown'],
];

describe('reads a correction and a cancellation as the app does', () => {
  it.each(APP_READING)('%s -> %s', (text, purpose) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
  });

  it('never redirects a correction or a cancellation', () => {
    for (const [text, purpose] of APP_READING) {
      if (recordsWorkNotAccess(purpose)) expect(recordsLineRedirect(text), text).toBeNull();
    }
  });
});
