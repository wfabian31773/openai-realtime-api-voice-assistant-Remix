/**
 * A CALLBACK NUMBER NOBODY VOUCHED FOR MUST SAY SO ON THE TICKET.
 *
 * Traced 2026-09-24 from a referral coordinator's emailed complaint. Her
 * office's calls all filed. On 2026-09-17 a staffer rang the number on one of
 * them and resolved it:
 *
 *   "Processed callback but line is unavailable. Closing the ticket as little
 *    to no information provided."
 *
 * The number was her ANI — an out-of-state area code on a Southern California referral
 * office, i.e. a trunk identifier, not a desk. `asked_callback` is FALSE on
 * all eight of that office's calls: nobody ever asked her for a number,
 * because `pcpAgent` seeds `callbackNumber` from caller ID and the intake then
 * skips a field that already reads answered.
 *
 * WHAT THIS DOES NOT DO, deliberately: add a question. v37 measured 18 of 25
 * PCP calls ENDING on a pre-filing question with 10 leaving NO ticket of any
 * provenance, and the teardown sweep did not catch them. Whether to confirm
 * the number, and on which side of the filing, is the operator's call. This
 * makes the provenance visible, which is useful on its own and is what makes
 * either answer measurable.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('the seed marks the number as caller ID only', () => {
  it('sets the flag in the same update that seeds the number', () => {
    const src = source('src/agents/pcpAgent.ts');
    // Anchored past the ANI guard's own regex: its `{10,15}` quantifier contains
    // a closing brace, so slicing to the FIRST `}` after the `if` cuts the
    // window off before the object literal and the assertion passes on an
    // empty haystack. Slice to the update call, then to the end of its object.
    const seed = src.slice(src.indexOf('if (metadata.callerPhone &&'));
    const update = seed.slice(seed.indexOf('pcpDirector.update('));
    const block = update.slice(0, update.indexOf('});'));
    expect(block).toContain('callbackNumber: metadata.callerPhone');
    expect(block).toContain('callbackFromCallerIdOnly: true');
  });

  it('the state carries the flag', () => {
    expect(source('src/pcp/director.ts')).toContain('callbackFromCallerIdOnly?: boolean');
  });
});

describe('a number the caller states is not caller ID', () => {
  it('record_pcp_intake clears the flag when a number arrives, in the same update', () => {
    const src = source('src/agents/pcpAgent.ts');
    expect(src).toContain(
      'facts.callbackNumber ? { ...facts, callbackFromCallerIdOnly: false } : facts',
    );
  });

  it('does not clear it on an intake that carries no number', () => {
    // The ternary is the whole guard: an intake recording only a caller name
    // must leave an ANI-seeded number still labelled unverified.
    const src = source('src/agents/pcpAgent.ts');
    expect(src).not.toContain('pcpDirector.update(callId, { ...facts, callbackFromCallerIdOnly: false })');
  });
});

describe('the ticket a staffer opens says which it is', () => {
  const src = source('src/agents/pcpAgent.ts');

  it('labels an unverified number and tells the staffer what to do about it', () => {
    expect(src).toContain('UNVERIFIED — this is the inbound caller ID, not a number the caller gave;');
    expect(src).toContain('ask them for a direct line');
  });

  it('labels a stated number as given by the caller', () => {
    expect(src).toContain("' Given by the caller.'");
  });

  it('keeps the line that says whose number it is — that part was always right', () => {
    expect(src).toContain('reaches the requesting office, not the patient.');
  });

  it('branches on the flag rather than printing one label for both', () => {
    const line = src.slice(src.indexOf('reaches the requesting office, not the patient.') - 400);
    expect(line.slice(0, 900)).toContain('state.callbackFromCallerIdOnly');
  });
});
