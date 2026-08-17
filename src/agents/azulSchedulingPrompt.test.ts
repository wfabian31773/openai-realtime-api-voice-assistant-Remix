/**
 * The scheduling prompt was rewritten on 2026-08-13 to sound like the rest of
 * the fleet, and this file exists because of the risk that carries.
 *
 * The old prompt was ~275 lines and almost every line was paid for by a real
 * call: a caller asked for a date of birth four times in four turns, seven
 * refused handoffs in 34 seconds, "Oct 25" verified as January 25, five callers
 * who ended a call holding nothing. Restyling prose is exactly the change that
 * silently drops one of those and looks fine in review.
 *
 * So this asserts the RULES survived, not the wording. Each case names what it
 * is protecting. Regexes are whitespace-tolerant because a re-wrap must not
 * break them.
 */
import { describe, it, expect } from 'vitest';
// Imported from the prompt module DIRECTLY, never through the agent — the
// agent pulls in toolTimeline, which opens a database connection at import and
// makes this file unloadable. That is the whole reason the prompt was
// extracted.
import { buildAzulSchedulingPrompt } from './azulSchedulingPrompt';

const P = buildAzulSchedulingPrompt();

/** Whitespace-insensitive contains. */
function has(needle: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  return flat(P).includes(flat(needle));
}

describe('the rules that cost a real call', () => {
  const RULES: Array<[string, string]> = [
    ['one question at a time', 'ONE QUESTION AT A TIME'],
    ['the bundled identity ask, 31 of 47 calls', '31 of 47'],
    ['ask twice at most, then change something', 'ASK ONCE, THEN CHANGE SOMETHING'],
    ['a non-answer is not consent', 'A NON-ANSWER IS NOT A YES'],
    ['never replay the identical offer', 'Never replay the\nidentical offer'],
    ['no call ends in nothing', 'NO CALL ENDS IN NOTHING'],
    ['never offer a slot the system did not return', 'NEVER STATE AN APPOINTMENT OPTION THE SYSTEM DID NOT RETURN'],
    ['only "confirmed" means booked', 'booking_status "confirmed"'],
    ['say what the system did', 'SAY WHAT THE SYSTEM DID, NOT WHAT YOU HOPE IT DID'],
    ['never tell a patient to call the office themselves', 'NEVER TELL A PATIENT TO CALL THE OFFICE THEMSELVES'],
    ['months are the most mis-heard part of a date of birth', 'MONTHS ARE THE MOST MIS-HEARD PART'],
    ['a retry must change something', 'A RETRY MUST CHANGE SOMETHING THE CALLER RE-SUPPLIED'],
    ['never re-send a call that failed on its own input', 'NEVER RE-SEND A CALL THAT FAILED ON ITS OWN INPUT'],
    ['never retry a refusal', 'NEVER RETRY A REFUSAL'],
    ['write once', 'WRITE ONCE'],
    ['seven refused handoffs in 34 seconds', 'SEVEN\nrefused handoffs in 34 seconds'],
    ['do not re-ask a verified caller at the transfer', 'do NOT re-ask their name or date of birth'],
    ['never ask for phone digits', 'NEVER ASK FOR PHONE DIGITS'],
    ['no spell-back on the first attempt', 'NO SPELL-BACK'],
    ['the lookup routes, not their memory', 'THE LOOKUP ROUTES, NOT THEIR MEMORY'],
    ['never narrate an internal flag', 'NEVER narrate an internal flag'],
    ['a 401 is not transient', 'A 401 OR "UNAUTHORIZED" IS NOT TRANSIENT'],
    ['transient errors get one retry', 'TRANSIENT ERRORS GET ONE RETRY'],
    ['never ask for a social security number', 'NEVER ask for a Social Security number'],
    ['no booking for new patients', 'DO NOT OFFER OR BOOK AN APPOINTMENT FOR A NEW PATIENT'],
    ['stop registering on a duplicate', 'STOP REGISTERING IMMEDIATELY'],
    ['your mishearing is not their name', 'Your mishearing is not their name'],
    ['spelled names are sacred', 'SPELLED NAMES ARE SACRED'],
    ['the confirmed time and the option must match', 'MUST BE THE SAME SLOT'],
    ['wait a full 5 seconds after the greeting', 'FULL 5 seconds'],
    ['never stack prompts', 'NEVER stack prompts back to back'],
    ['do not repeat the greeting', 'Do NOT repeat or rephrase it'],
  ];

  for (const [what, needle] of RULES) {
    it(`still says: ${what}`, () => {
      expect(has(needle), `MISSING FROM PROMPT: ${needle}`).toBe(true);
    });
  }
});

describe('the urgent screen', () => {
  it('keeps all three triggers added after 2026-07-28', () => {
    expect(has('AN ACTIVE EYE PROBLEM IS A SYMPTOM')).toBe(true);
    expect(has('THE WORD "URGENT" FROM THE CALLER IS ITSELF THE TRIGGER')).toBe(true);
    expect(has('ANYTHING TOUCHING SURGERY GOES TO THE SURGICAL TEAM')).toBe(true);
  });

  it('names the handoff reasons the server expects', () => {
    for (const reason of [
      'urgent_symptom',
      'surgery_or_post_op_issue',
      'patient_identity_uncertain',
      'insurance_or_authorization_issue',
      'api_failure',
      'no_acceptable_availability',
      'booking_status_unknown',
      'patient_requested_human',
    ]) {
      expect(has(reason), `handoff reason missing: ${reason}`).toBe(true);
    }
  });

  it('still requires a callback when an urgent transfer does not connect', () => {
    expect(has('An urgent caller is the last person who can be left with nothing')).toBe(true);
  });
});

describe('the cover lines — the caller cannot tell silence from a dropped call', () => {
  it('carries one for every slow chain', () => {
    for (const line of [
      'one moment while I pull up your record',
      'Let me check our openings for you',
      "this part can take up to half a minute",
      'while I get you set up in our system',
      'One moment while I take care of that',
    ]) {
      expect(has(line), `cover line missing: ${line}`).toBe(true);
    }
  });

  it('says never call a tool cold', () => {
    expect(has('Never, ever call a tool cold')).toBe(true);
  });
});

describe('reschedule is one step, and the prompt no longer contradicts itself', () => {
  /**
   * THE BUG THIS ENCODES. The old prompt said, under "What you cannot do":
   *   "You cannot reschedule — cancel + book through the allowed flow"
   * while four sections earlier it said:
   *   "NEVER cancel their appointment and then look for a new time"
   *
   * Both shipped, in the same prompt, with sage_reschedule registered as a real
   * tool. The stale line told the model to do the exact thing the reschedule
   * section forbids, and its failure mode is the one that flow calls SERIOUS.
   */
  it('does not claim the agent cannot reschedule', () => {
    expect(P).not.toMatch(/you cannot reschedule/i);
    expect(P).not.toMatch(/cancel \+ book/i);
  });

  it('forbids cancel-then-book explicitly', () => {
    expect(has('NEVER cancel and\nthen go looking for a new time')).toBe(true);
    expect(has('sage_reschedule does both halves\nas one operation')).toBe(true);
  });

  it('keeps all four reschedule statuses, including the serious one', () => {
    for (const status of ['confirmed', 'failed', 'cancelled_not_rebooked', 'unknown']) {
      expect(has(status), `reschedule status missing: ${status}`).toBe(true);
    }
    expect(has('they currently have NO appointment')).toBe(true);
  });
});

describe('the tools it is allowed to name', () => {
  it('names every tool the flows depend on', () => {
    for (const tool of [
      'sage_decision',
      'sage_availability',
      'sage_book',
      'sage_reschedule',
      'sage_confirm_appointment',
      'sage_patient_context',
      'sage_new_patient_intake',
      'sage_handoff',
      'sage_practice',
      'sage_info',
      'sage_insurance_check',
      'verify_patient_identity',
      'get_patient_appointments',
      'cancel_appointment',
      'transfer_to_office',
      'terminate_call',
    ]) {
      expect(has(tool), `tool missing from prompt: ${tool}`).toBe(true);
    }
  });

  it('keeps all seven appointment type names exactly', () => {
    for (const type of [
      'Consult',
      'Follow Up',
      'Refraction Only',
      'Dilated Exam',
      'Ref+DFE',
      'GLE',
      'FFG Free From Glasses',
    ]) {
      expect(P).toContain(type);
    }
  });
});

describe('language policy', () => {
  it('will not refuse a requested language or cite policy at a caller', () => {
    expect(has('AN EXPLICIT REQUEST ALWAYS WINS')).toBe(true);
    expect(has('never cite policy at a caller')).toBe(true);
    expect(has('NEVER claim you can only speak English while speaking Spanish')).toBe(true);
  });

  it('still requires English-canonical say scripts to be translated, not skipped', () => {
    expect(has('Never\nskip a \'say\' because it arrived in English')).toBe(true);
  });
});

describe('the dynamic tail still attaches', () => {
  it('offers the caller their own number rather than making them read digits', () => {
    const withPhone = buildAzulSchedulingPrompt({ callerPhone: '+17605551234' });
    expect(withPhone).toContain('# Call context');
    expect(withPhone).toContain('1234');
  });

  it('does not state the time context twice', () => {
    // buildDynamicTail used to re-add it; the house style puts it at the top.
    const withPhone = buildAzulSchedulingPrompt({ callerPhone: '+17605551234' });
    // Count the distinctive opening of the block, not words inside it — the
    // context string itself contains several date-ish phrases, so a looser
    // regex reports 3 hits for a single occurrence and this test would have
    // failed for a reason that had nothing to do with duplication.
    const hits = withPhone.match(/Current Pacific Coast Time:/g) || [];
    expect(hits).toHaveLength(1);
  });

  it('carries the caller-ID recognition block only on a match', () => {
    const anon = buildAzulSchedulingPrompt({ callerPhone: '+17605551234' });
    expect(anon).not.toContain('CALLER-ID PRE-CONTEXT');

    const known = buildAzulSchedulingPrompt({
      callerPhone: '+17605551234',
      precontext: { matched: true, firstName: 'Wayne', lastNameOnFile: 'Fabian' } as never,
    });
    expect(known).toContain('CALLER-ID PRE-CONTEXT');
    expect(known).toContain('Wayne');
    // A first name is a hint, never proof.
    expect(known).toContain('STRONG hint, not verification');
  });
});

describe('it reads like the rest of the fleet', () => {
  it('opens the way the queue agents do', () => {
    expect(P.startsWith('You answer the scheduling line at Azul Vision.')).toBe(true);
  });

  it('dropped the specification vocabulary the operator objected to', () => {
    // "this line is completely broken, sounds nothing like the other lines you
    // created" was about PCP; scheduling had the same shape.
    expect(P).not.toContain('THE CONTRACT — Eye Care decides');
    expect(P).not.toContain('v2 seatbelt');
    expect(P).not.toContain('# Your role');
  });

  it('says patients, never customers', () => {
    expect(P.toLowerCase()).not.toContain('customer');
  });
});

describe('it must not write the caller\'s half of the conversation', () => {
  /**
   * CA66344af6, 2026-08-17. The agent asked for a date of birth and then, with
   * no caller turn in between, thanked him for confirming it:
   *
   *   agent   "— just to confirm your identity, may I have your date of birth?"
   *   agent   "Thank you for confirming that. Now we can move forward."   (+1,223ms)
   *   caller  "Who told you to say thank you for confirming?"
   *
   * This prompt ALREADY said "one question at a time" and "STOP TALKING" —
   * and the model did it anyway. A general rule it can read past is not a
   * rule; the specific behaviour had to be named, with the words it hides
   * behind.
   */
  const p = buildAzulSchedulingPrompt({} as never);

  it('names the behaviour, not just "be concise"', () => {
    expect(p).toMatch(/NEVER THANK SOMEONE FOR AN ANSWER THEY HAVE NOT GIVEN/);
    expect(p).toMatch(/Do not write the caller's\s+half of the conversation/i);
  });

  it('names the words it hides behind', () => {
    for (const word of ['Thanks', 'Great', 'Got it', 'Perfect', 'Understood']) {
      expect(p, `"${word}" must be named as a reply, not an opener`).toContain(word);
    }
  });

  it('says where the turn ends', () => {
    expect(p).toMatch(/Your turn ends the moment the question mark lands/i);
    expect(p).toMatch(/not after a follow-up\s*sentence/i);
  });
});
