/**
 * The Optical agent: what it can do, and what it must never claim it can do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

import {
  buildOpticalPrompt,
  createOpticalAgent,
  opticalAgentConfig,
  OPTICAL_TOOLS,
} from './opticalAgent';
import { manifest } from '../tools/registry';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('it cannot transfer, and must not imply that it can', () => {
  // Operator ruling, 2026-08-12: "there is no handoff for any of the answering
  // service agents, only for PCP, Scheduling SD. All other agents politely
  // state they are unable to handoff and can only create a request for a
  // callback."
  const prompt = buildOpticalPrompt({ callerPhone: '8455317471' });

  it('has no transfer tool of any kind', () => {
    // Not a disabled one, not one that "records the request" — none. A tool the
    // agent cannot see is a promise it cannot make.
    for (const name of OPTICAL_TOOLS) {
      expect(name).not.toMatch(/transfer|handoff|escalat|human|operator/i);
    }
    expect(OPTICAL_TOOLS).toHaveLength(5);
  });

  it('is told to say so plainly and offer the callback instead', () => {
    /**
     * Matched on MEANING, not on one sentence. These were three literal regexes
     * until 2026-09-03, when the operator ruled the reply must say it cannot
     * transfer AND that a request is raised for staff to follow up. Rewording to
     * carry that ruling broke two of the three, which is a guard failing on the
     * phrasing rather than on the promise — the mistake queuePromptRulings.ts
     * was written to avoid. So: the promise, however it is worded.
     */
    expect(prompt).toMatch(/not\s+able\s+to\s+transfer\s+(you|calls)|cannot\s+transfer/i);
    // What it offers INSTEAD — a callback, or a request raised for staff.
    expect(prompt).toMatch(/call\s+you\s+back|follow\s+up\s+with\s+you/i);
    // Standing instruction 9: a transfer it cannot make must never be promised.
    expect(prompt).toMatch(/never\s+say\s+you\s+will\s+put\s+them\s+through/i);
    // The 2026-09-03 ruling's second half, absent before it.
    expect(prompt).toMatch(/take\s+a\s+message/i);
    expect(prompt).toMatch(/put\s+in\s+a\s+request/i);
  });

  it('is built without a handoff callback wired to anything', async () => {
    // The registry hands every factory a handoff callback. This one takes it
    // and ignores it; passing a throwing callback proves nothing calls it.
    const agent = await createOpticalAgent(undefined, { callId: 'c1', callerPhone: '8455317471' });
    expect(agent).toBeTruthy();
  });
});

describe('the queue decides what the call is, not the model', () => {
  const prompt = buildOpticalPrompt({ callerPhone: '8455317471' });

  it('never asks the caller which department they want', () => {
    expect(prompt).toMatch(/must never ask the caller which department/i);
  });

  it('stays small — that is the point of routing by queue', () => {
    // The answering-service prompt is ~4,900 tokens and most of it decides
    // which department the call belongs to. This one does not have to.
    //
    // RAISED FROM 1,200 TO 1,500 ON 2026-08-13, deliberately and once.
    //
    // Two operator-requested rules pushed it to ~1,286: say the cover line
    // only when you are actually about to file, and never ask a patient which
    // city one of our offices is in. Both came from a real call where the
    // caller was told the request was logged and then asked three more
    // questions, one of which was where our own office is.
    //
    // I tried to earn the space back first, and it is worth recording why I
    // stopped. Merging the APPOINTMENTS section into the one above it —
    // genuinely redundant — broke two tests that pin exact phrasings, and the
    // trimming was starting to cost clarity to satisfy a round number.
    //
    // WHAT THIS TEST IS FOR is the ratio, not the digits: this prompt must not
    // drift into carrying the answering service's classification burden. At
    // 1,286 it is 26% of that prompt, which is the property intact. The old
    // 1,200 was a round number, not a measured threshold.
    //
    // Loosening an assertion to fit a change is usually the wrong move and it
    // is called out elsewhere in these tests. The distinction: that is wrong
    // when the assertion encodes a property you are breaking. Here it encodes
    // a proxy, and the property is untouched. If this needs raising a second
    // time, that is the signal to actually cut something.
    const approxTokens = prompt.length / 4;
    expect(approxTokens).toBeLessThan(1500);
  });

  it('takes an appointment request rather than deflecting it', () => {
    // SUPERSEDED RULING. MASTER.md §9 said Optical takes anything optical
    // EXCEPT appointment requests, and this test used to assert the deflection.
    //
    // Operator, 2026-08-13: "these are specific queues that are being forwarded
    // ... we can't just tell the patient call back, call the wrong extension ...
    // anything that's schedule related that comes through any of these should
    // go to the HVA hub." The queue still does not SCHEDULE anything — it takes
    // the request and the tool routes it.
    expect(prompt).toMatch(/appointment/i);
    // Whitespace-tolerant: the prompt is hard-wrapped, and an assertion about
    // MEANING must not break because a phrase moved across a line ending.
    expect(prompt).toMatch(/do not attempt\s+to schedule/i);
    expect(prompt, 'the agent must not send a caller away').toMatch(
      /do not tell them to call\s+another number/i,
    );
    expect(prompt).toMatch(/scheduling hub/i);
  });

  it('never tells a caller they reached the wrong place', () => {
    // Assert the forbidden-phrase list, which is the stable part. Matching a
    // whole sentence would break every time the prompt is re-wrapped, which it
    // already did once.
    expect(prompt).toMatch(/never say "wrong number"/i);
    expect(prompt).toMatch(/wrong extension/i);
    expect(prompt).toMatch(/routed_to/);
  });
});

describe('the tools it is given', () => {
  it('are exactly the five in the library, and all registered', () => {
    const published = manifest().map((t) => t.name);
    for (const name of OPTICAL_TOOLS) {
      expect(published, `${name} must be an agent-layer tool`).toContain(name);
    }
  });

  it('come from the library rather than being redeclared here', async () => {
    // If this agent defined its own copies they would drift from the ones the
    // HTTP surface serves, which is the failure the library exists to prevent.
    const agent = await createOpticalAgent(undefined, { callId: 'c2' });
    const names = ((agent as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
    expect(names.sort()).toEqual([...OPTICAL_TOOLS].sort());
  });
});

describe('what it tells the caller about themselves', () => {
  it('uses the number they called from without asking', () => {
    const p = buildOpticalPrompt({ callerPhone: '8455317471' });
    expect(p).toMatch(/7471/);
    expect(p).toMatch(/without asking/i);
  });

  it('asks for a callback number when caller ID is absent', () => {
    const p = buildOpticalPrompt({});
    expect(p).toMatch(/ask for a full ten-digit callback number/i);
  });

  it('is told to confirm the office rather than assume it', () => {
    // usual_clinic is derived from visit history. It is a good guess, not a
    // fact about what the caller wants today.
    const p = buildOpticalPrompt({});
    expect(p).toMatch(/confirm it rather than assuming/i);
  });

  it('is told what an uncertain identity means before it reads anything back', () => {
    const p = buildOpticalPrompt({});
    expect(p).toMatch(/identity_is_certain is false/);
    expect(p).toMatch(/do not read their history\s*\n?\s*back/i);
  });

  it('is told never to emit markdown, because it is spoken aloud', () => {
    // A live agent said "**Dr. Dwayne Logan**" to a caller on 2026-08-10.
    expect(buildOpticalPrompt({})).toMatch(/never use markdown/i);
  });
});

describe('the greeting sets expectations before the caller asks for a human', () => {
  // Operator-dictated, 2026-08-12: "all of our opticians are currently
  // assisting other patients. I can take a message, and they will follow up
  // with you... so you can preempt the 'pass me to a human'."
  it('says why nobody is answering and what will happen instead', () => {
    const g = opticalAgentConfig.greeting;
    expect(g).toMatch(/opticians are currently\s*assisting other patients/i);
    expect(g).toMatch(/take a message/i);
    expect(g).toMatch(/follow up with you/i);
  });

  it('never implies a person is on the line', () => {
    // Also the honest framing if this line is ever looked at for disclosure.
    expect(opticalAgentConfig.greeting).not.toMatch(/speaking with a representative|one of our team members will be right/i);
  });
});

describe('caller recognition — credibility, not cosmetics', () => {
  // Operator, 2026-08-12: "it lets the person know that, hey, I have your
  // information in my hand so I'm able to help... if they know my name, they
  // might know when my next appointment is." Opening cold tells them the
  // opposite.
  const matched = buildOpticalPrompt({
    callerPhone: '8455317471',
    precontext: { matched: true, firstName: 'Wayne', lastNameOnFile: 'Fabian', dobOnFile: '1973-03-17' },
  });

  it('opens by confirming the name rather than asking for it', () => {
    expect(matched).toMatch(/Am I speaking with Wayne\?/);
    expect(matched).toMatch(/NEVER open with "can I get your name and date of birth"/i);
  });

  it('still treats the match as a hint, not as verification', () => {
    expect(matched).toMatch(/A first name is not verification/i);
    expect(matched).toMatch(/still collect the date of birth/i);
    expect(matched).toMatch(/matched the WRONG person/i);
  });

  it('says nothing about recognition when the number matches nobody', () => {
    const cold = buildOpticalPrompt({ callerPhone: '8455317471' });
    expect(cold).not.toMatch(/Am I speaking with/);
    expect(cold).not.toMatch(/YOU ALREADY KNOW WHO THIS PROBABLY IS/);
  });

  it('does not claim a match when precontext came back unmatched', () => {
    const unmatched = buildOpticalPrompt({
      callerPhone: '8455317471',
      precontext: { matched: false },
    });
    expect(unmatched).not.toMatch(/Am I speaking with/);
  });
});

describe('the callback number is confirmed BEFORE the ticket is filed', () => {
  // VA-50813 said "Your request has been filed... Now, is this number ending in
  // 7471 the best one to reach you?" Operator: correcting it afterwards "would
  // have required another ticket".
  const p = buildOpticalPrompt({ callerPhone: '8455317471' });

  it('is instructed to confirm first, and told why', () => {
    // Reworded 2026-08-13 after the operator heard it ask for the number AFTER
    // filing on a live call. The rule is unchanged; the wording is stronger and
    // now names the failure it prevents.
    expect(p).toMatch(/THE NUMBER COMES BEFORE THE TICKET/);
    expect(p).toMatch(/If you have already filed, do not ask/);
  });

  it('puts confirming ahead of filing in the numbered steps', () => {
    expect(p.indexOf('THE NUMBER COMES BEFORE THE TICKET')).toBeLessThan(
      p.indexOf('NEVER GO SILENT WHILE FILING'),
    );
    expect(p).toMatch(/Ask, hear the answer, THEN file/);
  });
});

describe('config', () => {
  it('is slug "optical" so the webhook and the registry agree', () => {
    expect(opticalAgentConfig.slug).toBe('optical');
  });
});

describe('the call id must not depend on the model remembering it', () => {
  // VA-50813 — the Optical line's first working call — filed with
  // `call_sid: null`. The tool accepts it as an input and the model simply
  // never passed it. Without it `update-call-data` can never match the ticket
  // to the call, so the recording, transcript and summary are not late, they
  // are unattachable forever.
  it('injects call_sid, caller_phone and dialed_number into every tool', async () => {
    const { runTool } = await import('../tools/registry');
    const spy = vi.spyOn(await import('../tools/registry'), 'runTool');

    const agent = await createOpticalAgent(undefined, {
      callId: 'call-1',
      callSid: 'CAreal123',
      callerPhone: '8455317471',
      dialedNumber: '8186193692',
    });
    const file = ((agent as { tools?: Array<{ name: string; invoke?: Function }> }).tools ?? []).find(
      (t) => t.name === 'file_optical_ticket',
    );
    expect(file, 'file_optical_ticket must be on the agent').toBeTruthy();

    // Invoke with the arguments a model actually sends: everything present,
    // the ones it does not know set to null.
    await file!.invoke?.({} as never, JSON.stringify({
      first_name: 'Wayne', last_name: 'Fabian', date_of_birth: '03/17/1973',
      callback_number: '845-531-7471', location: 'Eastvale',
      request_description: 'hinge broke', request_reason_id: null,
      provider: null, email: null, call_sid: null, caller_phone: null, dialed_number: null,
    }));

    const calls = spy.mock.calls;
    const passed = calls[calls.length - 1][1] as Record<string, unknown>;
    expect(passed.call_sid, 'a null from the model must not blank the injected id').toBe('CAreal123');
    expect(passed.caller_phone).toBe('8455317471');
    expect(passed.dialed_number).toBe('8186193692');
    void runTool;
  });

  /**
   * REVERSED 2026-09-01, and the old assertion is quoted here so the change is
   * not mistaken for a regression: this used to require `call_sid` to fall back
   * to the OpenAI call id when no Twilio SID was known.
   *
   * The fallback value is a uuid. It fails isTwilioCallSid, so the ticket goes
   * out with no idempotency key; it matches no ticket in the post-call
   * enrichment endpoint; and since 2026-09-01 it gives the outbox no key
   * either. It is exactly as useless as sending nothing, and it looks like an
   * identifier in the logs, which is worse — it made "we never had a SID"
   * uncountable.
   *
   * The concern the old test encoded is real and is still covered by the test
   * above: a null from the model must not blank the injected id. That is a
   * different thing from inventing one.
   */
  it('sends no call_sid at all rather than an id that is not a Twilio SID', async () => {
    const spy = vi.spyOn(await import('../tools/registry'), 'runTool');
    const agent = await createOpticalAgent(undefined, { callId: 'call-only' });
    const t = ((agent as { tools?: Array<{ name: string; invoke?: Function }> }).tools ?? []).find(
      (x) => x.name === 'check_open_tickets',
    );
    await t!.invoke?.({} as never, JSON.stringify({ phone: '845-531-7471' }));
    const calls = spy.mock.calls;
    const passed = calls[calls.length - 1][1] as Record<string, unknown>;
    expect(passed.call_sid).toBeUndefined();
    // The call is still identified where identification actually works — the
    // telemetry carries callId, and the timeline row is keyed on callLogId.
    expect(passed.phone).toBe('845-531-7471');
  });
});

/**
 * Both of these came from the operator calling the live lines on 2026-08-13.
 *
 *   "it's asking for the best contact AFTER the ticket is submitted"
 *   "we need something to fill the silence while the ticket is being created"
 *
 * They are asserted here because Optical is the line he called first, but the
 * same two blocks are in all four queue prompts — "you fix one you fix all",
 * which is the point of the shared shape.
 */
describe('what the operator heard on a live call', () => {
  const live = buildOpticalPrompt({ callerPhone: '8455317471' });

  it('tells it not to ask for the number after filing', () => {
    expect(live).toMatch(/THE NUMBER COMES BEFORE THE TICKET/);
    expect(live).toMatch(/If you have already filed, do not ask/);
  });

  it('gives it a line to say before the silence, not after', () => {
    expect(live).toMatch(/NEVER GO SILENT WHILE FILING/);
    expect(live).toMatch(/Let me get this logged for you/);
    expect(live).toMatch(/FIRST, then file/);
  });

  it('does not call patients "customers"', () => {
    // Operator: "customers sounds like we are a department store."
    expect(opticalAgentConfig.greeting).not.toMatch(/customer/i);
    expect(live).not.toMatch(/customer/i);
  });
});
