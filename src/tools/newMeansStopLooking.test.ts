/**
 * "NEW" HARD-SUPPRESSES `lookup_patient` — the operator's ruling, 2026-09-19.
 *
 *   Wayne: "new should hard suppress lookup patient."
 *
 * RULE ZERO 2a has said the same since it was written ("NEW means STOP
 * LOOKING") and until this build only the prompt obeyed it: #293 appended the
 * question, gated nothing, and put the gate to him.
 *
 * DRIVEN THROUGH `runTool`, the entry point the model actually calls, with an
 * invented caller and an invented number. A test on `readPatientStatus` alone
 * would prove the reader reads and NOT that anything consults it — which is
 * CLAUDE.md failure mode 10, and how #291's office carry sat dead behind five
 * green tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const { lookupSpy } = vi.hoisted(() => ({ lookupSpy: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: lookupSpy },
}));
vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => false,
  lookupLocation: async () => null,
}));

const { runTool } = await import('./registry');
await import('./sharedPatientTools');
const { resetGateAttempts } = await import('./gateAttempts');
const {
  notePatientStatus,
  patientStatusFor,
  readPatientStatus,
  resetPatientStatuses,
} = await import('./spokenPatientStatus');
const { rememberVerifiedIdentity, resetVerifiedIdentities } = await import('./verifiedIdentity');

const SID = 'CA0000000000000000000000000000ab01';
const OTHER = 'CA0000000000000000000000000000ab02';

const EMPTY = {
  patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0,
};

type Out = Record<string, unknown>;
const lookup = (args: Record<string, unknown>) => runTool('lookup_patient', args) as Promise<Out>;

/** The ask exactly as `NEW_OR_EXISTING_ASK` instructs the model to say it. */
const ASK = 'AGENT: Are you a new patient or an existing patient?';

beforeEach(() => {
  lookupSpy.mockReset();
  lookupSpy.mockResolvedValue(EMPTY as never);
  resetGateAttempts();
  resetPatientStatuses();
  resetVerifiedIdentities();
});

describe('the gate: a caller who said NEW is not looked up', () => {
  it('does not dispatch, and says so in the channel only the model reads', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });

    expect(lookupSpy).not.toHaveBeenCalled();
    expect(out.found).toBe(false);
    expect(out.suppressed).toBe('caller_said_new');
    // v43: an instruction to the model in the channel the model SPEAKS is how
    // the surgery agent read its own emergency rule out loud. Nothing to say.
    expect(out.message).toBeUndefined();
    expect(String(out.fix)).toMatch(/NEW patient/);
    expect(String(out.fix)).toMatch(/never tell them we have no record/i);
  });

  it('the refusal carries the way back, so the suppression is not a dead end', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(String(out.fix)).toMatch(/patient_status "existing"/);
  });

  it('is countable from SQL — the key survives into the recorded event', async () => {
    /**
     * Asserted BEHAVIOURALLY, through `recordToolEvent`, because the allow-list
     * is local to `summarizeResult` and because that is what the question
     * actually is: not "is the string in an array" but "does the outcome reach
     * `tool_timeline`". v48 exists because `found` and `candidate_count` did
     * not, so a query for the ambiguous branch answered 0 on every lane and
     * that zero was the instrument rather than the fleet.
     */
    const { recordToolEvent, getAzulTimeline } = await import('../services/toolTimeline');
    const callId = 'timeline-suppressed-probe';
    recordToolEvent(
      callId,
      'lookup_patient',
      { queue: 'optical' },
      JSON.stringify({ success: true, found: false, suppressed: 'caller_said_new' }),
      4,
      { agentSlug: 'optical' },
    );
    const event = getAzulTimeline(callId)![0] as { outcome?: Record<string, unknown> };
    expect(event.outcome?.suppressed).toBe('caller_said_new');
  });

  it('a caller who said EXISTING is looked up exactly as before', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: Existing.']);
    const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('a caller who was never asked is looked up exactly as before', async () => {
    const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('suppression is per call — one caller saying new does not gate the next', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    const out = await lookup({ queue: 'optical', call_sid: OTHER, caller_phone: '555-555-0102' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('a sentinel call_sid is not a call: it neither stores nor suppresses', async () => {
    notePatientStatus('unknown', [ASK, 'CALLER: New.']);
    expect(patientStatusFor('unknown')).toBeUndefined();
    const out = await lookup({ queue: 'optical', call_sid: 'unknown', caller_phone: '555-555-0103' });
    expect(out.suppressed).toBeUndefined();
  });
});

describe('RULE 1 OUTRANKS THE ANSWER — the operator-named failure mode', () => {
  it('an established identity is never suppressed, whatever the caller said', async () => {
    // The ordinary sequence: the model looks up the injected caller phone
    // before this question is ever asked, so a caller the person base vouches
    // for is already locked in by the time they could answer "new".
    rememberVerifiedIdentity(SID, {
      firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', certain: true,
    } as never);
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });
});

describe('the override, and why it needs its own store', () => {
  it('patient_status existing lifts the suppression and the lookup runs', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    const out = await lookup({
      queue: 'optical', call_sid: SID, caller_phone: '555-555-0101', patient_status: 'existing',
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('SURVIVES the next caller turn — the bug the two stores exist to prevent', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    await lookup({
      queue: 'optical', call_sid: SID, caller_phone: '555-555-0101', patient_status: 'existing',
    });
    // The first version wrote the override into the same map the bridge
    // recomputes from the transcript, whose latest window still says "new" —
    // so the escape hatch closed again one caller turn after the model used it.
    notePatientStatus(SID, [ASK, 'CALLER: New.', 'AGENT: And your last name?', 'CALLER: Quixote.']);
    lookupSpy.mockClear();
    const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('patient_status new suppresses on its own, with no transcript at all', async () => {
    const out = await lookup({
      queue: 'optical', call_sid: SID, caller_phone: '555-555-0101', patient_status: 'new',
    });
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(out.suppressed).toBe('caller_said_new');
  });
});

describe('the window rule — measured, not assumed', () => {
  /**
   * TWO MUTATIONS SURVIVE HERE BY EQUIVALENCE, and they are recorded rather
   * than papered over, because the next reader will try the same two.
   *
   * The window is defended TWICE and either guard alone is sufficient:
   * `close()` resets `turns` at every agent line, and the push is also gated on
   * `open`. So removing one changes no behaviour and kills no test; removing
   * BOTH is caught, by "a caller line OUTSIDE the window is not swept into it".
   * That is the property being tested, and it is tested — what the single
   * mutations reveal is redundancy in the implementation, not a hole in the
   * suite. Neither guard is being removed: the cost is two lines and the thing
   * they protect is a suppression that refuses to look for a real record.
   *
   * A THIRD survives for a different and also deliberate reason — the sentinel
   * guard on `notePatientStatus`. `patientStatusFor` carries its own copy, so
   * relaxing the write is invisible through the public API. That is exactly
   * what `spokenDob.ts` says its matching pair is for ("so the guard survives
   * someone later relaxing the write"), and it means the write guard cannot be
   * observed by any test that goes through the reader. Left as is, stated here.
   */
  /**
   * Over the four runtime queue lanes, 2026-09-15..18, 1,238 substantive calls
   * with a caller line: "new" appears anywhere in 53 of them and only 3 of
   * those contain "new patient". A windowless reader would be wrong on ~94% of
   * its own firings, and each one refuses to look for a real record.
   */
  it('"I need new glasses" outside the ask is not an answer', () => {
    expect(readPatientStatus(['AGENT: How can I help?', 'CALLER: I need new glasses.'])).toBeUndefined();
  });

  it('"I need new glasses" INSIDE the ask is still not an answer', () => {
    expect(readPatientStatus([ASK, 'CALLER: I need new glasses.'])).toBeUndefined();
  });

  it('a MENTION does not open a window, and the sentence bound is what stops it', () => {
    // This read "new" until `fold` was fixed to keep `.?!` — the window regex
    // bounds itself with [^.?!] and the fold had turned every period into a
    // space, so the bound was inert and matched across two sentences.
    expect(
      readPatientStatus([
        'AGENT: I have a new prescription. Or is it an existing order?',
        'CALLER: New.',
      ]),
    ).toBeUndefined();
  });

  it('a negated new reads as EXISTING, which is the direction that matters', () => {
    expect(readPatientStatus([ASK, 'CALLER: No, not a new patient.'])).toBe('existing');
    expect(readPatientStatus([ASK, "CALLER: I'm not new, I was there last year."])).toBe('existing');
  });

  it('a caller line OUTSIDE the window is not swept into it', () => {
    /**
     * Added because a mutation survived: making every caller line count
     * regardless of the window failed nothing, since the cases above all have
     * their stray "new" BEFORE any window opens and an unopened window is never
     * read. This is the case that discriminates — a real one, a patient who
     * mentions a past visit early and then answers the question — and it must
     * read the ANSWER, not the earlier sentence.
     */
    expect(
      readPatientStatus([
        'AGENT: How can I help?',
        'CALLER: I had an appointment last week and I need to change it.',
        ASK,
        'CALLER: New.',
      ]),
    ).toBe('new');
  });

  it('and the window closes at the next agent line, not at the next window', () => {
    // The mirror of the above: an answer given INSIDE a window is not overruled
    // by what the caller says after the agent has moved on.
    expect(
      readPatientStatus([
        ASK,
        'CALLER: New.',
        'AGENT: And what can we do for you?',
        'CALLER: I had an appointment last week and I need to change it.',
      ]),
    ).toBe('new');
  });

  it('the LATEST window wins, so a corrected answer lands', () => {
    expect(
      readPatientStatus([
        ASK, 'CALLER: New.',
        'AGENT: Sorry — new or existing?', 'CALLER: Existing, I came in last year.',
      ]),
    ).toBe('existing');
  });

  it('silence in a later window is not a correction', () => {
    expect(
      readPatientStatus([
        ASK, 'CALLER: New.',
        'AGENT: And your name?', 'CALLER: It is on the card.',
      ]),
    ).toBe('new');
  });

  it('the answers callers actually give to this question', () => {
    expect(readPatientStatus([ASK, "CALLER: I'm a new patient."])).toBe('new');
    expect(readPatientStatus([ASK, 'CALLER: New.'])).toBe('new');
    expect(readPatientStatus([ASK, "CALLER: I've never been a patient."])).toBe('new');
    expect(readPatientStatus([ASK, "CALLER: I've been seen there before."])).toBe('existing');
    expect(readPatientStatus([ASK, 'CALLER: Existing patient.'])).toBe('existing');
    // "First time calling." and "I've never been there." used to read `new`
    // here. Codex round 3 is why they no longer do — see that block below.
  });

  it('a reading that finds nothing overwrites nothing', () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    notePatientStatus(SID, ['AGENT: Anything else?', 'CALLER: No thank you.']);
    expect(patientStatusFor(SID)).toBe('new');
  });
});

describe('THE WIRING — the bridge is what posts the record', () => {
  /**
   * Failure mode 10, and this module is the shape it keeps taking: every test
   * above drives `notePatientStatus` by hand, so all nineteen would stay green
   * with the bridge never calling it — and then the gate would be dead on every
   * real call while the suite reported it working. #291's office carry sat dead
   * behind five green tests exactly this way.
   *
   * Read from the SOURCE, the device `ticketRequirements.test.ts` uses for the
   * sweep's wiring: the alternative is standing up a whole media-stream session
   * to observe one call, and the thing being pinned is that the call site
   * EXISTS beside the date-of-birth one, in the handler that owns the record.
   */
  it('mediaStreamBridge posts the transcript to the status reader', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/runtime/mediaStreamBridge.ts', 'utf8');
    expect(src).toContain('import { notePatientStatus }');
    expect(src).toMatch(/notePatientStatus\(this\.deps\.context\.callSid, this\.transcriptLog\.lines\)/);
  });

  it('it posts the WHOLE record, beside the date-of-birth reader', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/runtime/mediaStreamBridge.ts', 'utf8');
    const dob = src.indexOf('noteSpokenDob(this.deps.context.callSid');
    const status = src.indexOf('notePatientStatus(this.deps.context.callSid');
    expect(dob).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(dob);
    // Same caller turn, so a correction lands on the same post the date does.
    expect(src.slice(dob, status)).not.toMatch(/\n\s*\},/);
  });

  it('the four queue prompts tell the model to pass what it heard', async () => {
    const { NEW_OR_EXISTING_ASK } = await import('../runtime/newOrExistingAsk');
    expect(NEW_OR_EXISTING_ASK).toMatch(/patient_status/);
    // The window only opens on this exact alternation, so the prompt must keep
    // instructing it. A reworded ask opens no window and suppresses nothing.
    const { readPatientStatus } = await import('./spokenPatientStatus');
    const asked = NEW_OR_EXISTING_ASK.match(/"([^"]*new patient[^"]*)"/)?.[1];
    expect(asked, 'the prompt no longer quotes the question').toBeTruthy();
    expect(readPatientStatus([`AGENT: ${asked}`, 'CALLER: New.'])).toBe('new');
  });
});

describe("Codex's three P1s on this PR — all reproduced, all fixed", () => {
  /**
   * All three were on a door this PR's own change opened, so all three were
   * taken regardless of base rate. Each was reproduced against the real reader
   * BEFORE being fixed, and each assertion below failed on `b483d7c`.
   */

  const EN = 'AGENT: Are you a new patient or an existing patient?';
  const ES = 'AGENT: ¿Es usted paciente nuevo o paciente existente?';

  describe('P1-A — a negated existing claim is NEW, not existing', () => {
    /**
     * `EXISTING_CUES` carries a broad `(been|was) (a )?patient`, so "I've never
     * been a patient" matched it and read as EXISTING. The lookup then ran and
     * produced the very "no record found" this gate exists to suppress.
     */
    it('"I\'ve never been a patient" is new', () => {
      expect(readPatientStatus([EN, "CALLER: I've never been a patient."])).toBe('new');
    });

    it('"I have not been a patient here" is new', () => {
      expect(readPatientStatus([EN, 'CALLER: I have not been a patient here.'])).toBe('new');
    });

    it('"I\'m not an existing patient" is new', () => {
      expect(readPatientStatus([EN, "CALLER: I'm not an existing patient."])).toBe('new');
    });

    it('and the MIRROR still holds — a negated NEW is existing', () => {
      // The specific negation runs first, so this is the case that could have
      // been broken by fixing the one above. Both directions, both pinned.
      expect(readPatientStatus([EN, 'CALLER: Not a new patient.'])).toBe('existing');
      expect(readPatientStatus([EN, "CALLER: I'm not new."])).toBe('existing');
    });

    it('a plain existing claim is untouched', () => {
      expect(readPatientStatus([EN, "CALLER: I've been a patient there for years."])).toBe('existing');
    });
  });

  describe('P1-B — only a PATIENT-status question opens a window', () => {
    /**
     * The window matched any same-sentence new/existing alternation, so an
     * optical or tech agent asking about a PRESCRIPTION opened one. A caller
     * answering the offered choice with a bare "New." then read as a new
     * PATIENT and had their lookup suppressed — the wrong direction, and the
     * object test cannot catch it because the noun is in the agent's question
     * while the caller said one word.
     */
    it('a prescription alternation opens NO window — the noun is between the pair', () => {
      expect(
        readPatientStatus([
          'AGENT: Do you need a new prescription or refill an existing one?',
          'CALLER: New.',
        ]),
      ).toBeUndefined();
    });

    it('nor does one whose shared noun follows the pair', () => {
      // This is the case a bare-alternation rule alone would have admitted.
      expect(
        readPatientStatus(['AGENT: Would you like a new or existing frame?', 'CALLER: New.']),
      ).toBeUndefined();
    });

    it('the question the prompt actually instructs still opens one, both forms', () => {
      expect(readPatientStatus([EN, 'CALLER: New.'])).toBe('new');
      expect(
        readPatientStatus(['AGENT: Are you a new or existing patient?', 'CALLER: New.']),
      ).toBe('new');
    });

    it('and the BARE RE-ASK still opens one, which is what reversibility needs', () => {
      /**
       * Narrowing the window for P1-B took this away and broke the correction
       * path — the property v59 leans on. It is admitted again, but only when
       * the alternation ENDS the clause, so the noun that made P1-B dangerous
       * cannot be there.
       */
      expect(
        readPatientStatus([
          EN, 'CALLER: New.',
          'AGENT: Sorry — new or existing?', 'CALLER: Existing, I came in last year.',
        ]),
      ).toBe('existing');
    });
  });

  describe('P1-C — Spanish, because it is 10.8% of these callers', () => {
    /**
     * Every lane tells the model to translate its questions and continue in the
     * caller's language, so a Spanish exchange opened no window and the gate did
     * not exist for that caller. Measured over the four runtime queue lanes,
     * 2026-09-12..18, 1,843 substantive calls: 199 caller sides carry a Spanish
     * cue (tech 60, surgery 71, optical 68).
     *
     * EVERY OTHER LANGUAGE IS STILL UNCOVERED and that is deliberate — no window
     * opens, nothing is suppressed, the call behaves as it does today. The
     * fail-safe direction, and the same call `dobParts.ts` makes about Turkish.
     */
    it('the Spanish question opens a window and a Spanish answer is read', () => {
      expect(readPatientStatus([ES, 'CALLER: Nuevo.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Soy nueva.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Existente.'])).toBe('existing');
      expect(readPatientStatus([ES, 'CALLER: Ya soy paciente.'])).toBe('existing');
    });

    it('a Spanish denial of PATIENT history is new', () => {
      // "Es mi primera vez" and "Nunca he venido" used to read `new` here.
      // Round 3 deleted both — a first time CALLING and a place are not
      // patient history. The denial that IS about patient history survives.
      expect(readPatientStatus([ES, 'CALLER: Nunca he sido paciente.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: No soy paciente existente.'])).toBe('new');
    });

    it('the Spanish object form is not an answer — the adjective follows the noun', () => {
      // "lentes nuevos", not "nuevos lentes". Translating the English pattern
      // word for word would have matched nothing and read this as "new".
      expect(readPatientStatus([ES, 'CALLER: Necesito lentes nuevos.'])).toBeUndefined();
    });

    it('accents survive the fold, or Spanish would be unreadable', () => {
      /**
       * THE ACCENT HAS TO CARRY THE MEANING or this assertion cannot see the
       * fold, and the first version could not: it hinged on "existente", which
       * has no accent, so removing the fold changed nothing and the mutation
       * SURVIVED. These two turn on an accented word — "había" and "número" —
       * which without decomposing first become "hab a" and "n mero", matching
       * no cue at all.
       */
      expect(readPatientStatus([ES, 'CALLER: Ya había venido antes.'])).toBe('existing');
      // And the object form, where losing the accent would read as an ANSWER.
      expect(readPatientStatus([ES, 'CALLER: Necesito un número nuevo.'])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: Sí, soy paciente existente.'])).toBe('existing');
    });

    it('an unsupported language opens no window, and suppresses nothing', () => {
      expect(
        readPatientStatus(['AGENT: Yeni hasta mısınız yoksa mevcut hasta mı?', 'CALLER: Yeni.']),
      ).toBeUndefined();
    });
  });

  describe('the gate itself still behaves, end to end, in both languages', () => {
    it('a Spanish "nuevo" suppresses the lookup through runTool', async () => {
      notePatientStatus(SID, [ES, 'CALLER: Nuevo.']);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).not.toHaveBeenCalled();
      expect(out.suppressed).toBe('caller_said_new');
    });

    it('a caller who never was a patient suppresses it too', async () => {
      notePatientStatus(SID, [EN, "CALLER: I've never been a patient."]);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).not.toHaveBeenCalled();
      expect(out.suppressed).toBe('caller_said_new');
    });

    it('a prescription question does NOT suppress it', async () => {
      notePatientStatus(SID, [
        'AGENT: Do you need a new prescription or refill an existing one?',
        'CALLER: New.',
      ]);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });
  });
});

describe("Codex round 2 — three more P1s, all the same wrong direction", () => {
  /**
   * Every one of the five cases below returned `new` for a caller who is an
   * EXISTING patient, so every one suppressed a real record's lookup. That is
   * the only direction on this gate that costs anybody anything, and it is why
   * all three were taken without weighing a base rate.
   */
  const EN = 'AGENT: Are you a new patient or an existing patient?';
  const ES = 'AGENT: ¿Es usted paciente nuevo o paciente existente?';

  describe('R2-A — a bare pair with a noun BEFORE it is not a re-ask', () => {
    /**
     * Round 1 admitted the bare re-ask clause-finally, which closed the noun
     * AFTER the pair and left the noun BEFORE it wide open.
     */
    it('"Is the prescription new or existing?" opens no window', () => {
      expect(
        readPatientStatus(['AGENT: Is the prescription new or existing?', 'CALLER: New.']),
      ).toBeUndefined();
    });

    it('nor does it when the question is longer', () => {
      expect(
        readPatientStatus(['AGENT: Do you need the prescription new or existing?', 'CALLER: New.']),
      ).toBeUndefined();
    });

    it('a bare pair cannot START a status conversation, only continue one', () => {
      // Guard 1: no qualified window has opened, so this is not a re-ask.
      expect(
        readPatientStatus(['AGENT: Sorry — new or existing?', 'CALLER: New.']),
      ).toBeUndefined();
    });

    it('guard 1 earns its place: an EXPLICIT new answer with no prior context', () => {
      /**
       * Added because the mutation removing guard 1 survived on the cases above
       * — guard 2 covered every one of them. This is the case guard 2 CANNOT
       * cover, because the answer is an explicit cue rather than a bare word:
       * without the prior-context requirement this opens a window and
       * suppresses a caller nobody ever asked about their patient status.
       */
      // REWRITTEN for Codex round 3: this case used to turn on "I'm new here",
      // which was an explicit NEW_CUES entry. Round 3 deleted that cue, so the
      // case stopped discriminating guard 1 — guard 2 covered it too, and the
      // mutation would have survived again. An explicit DENIAL is still read
      // regardless of window kind, so it is the case guard 2 cannot cover.
      expect(
        readPatientStatus([
          'AGENT: Is the frame new or existing?',
          "CALLER: I'm not an existing patient.",
        ]),
      ).toBeUndefined();
    });

    it('and a bare WORD does not answer a re-ask window', () => {
      // Guard 2, independent of guard 1: even after a qualified window, the
      // bare "New." an unrelated alternation draws is not an answer.
      expect(
        readPatientStatus([
          EN, 'CALLER: Existing.',
          'AGENT: Is the prescription new or existing?', 'CALLER: New.',
        ]),
      ).toBe('existing');
    });

    it('while a real correction in a re-ask window still lands', () => {
      expect(
        readPatientStatus([
          EN, 'CALLER: New.',
          'AGENT: Sorry — new or existing?', 'CALLER: Existing, I came in last year.',
        ]),
      ).toBe('existing');
    });
  });

  describe('R2-B — a Spanish negated-new answer is EXISTING', () => {
    /**
     * `no soy paciente` had been written as a bare prefix in the
     * negated-EXISTING list, so it matched "no soy paciente NUEVO" and returned
     * "new" — the exact inversion the English cues were careful about, in the
     * other language.
     */
    it('"No soy paciente nuevo; soy paciente existente" is existing', () => {
      expect(
        readPatientStatus([ES, 'CALLER: No soy paciente nuevo; soy paciente existente.']),
      ).toBe('existing');
    });

    it('"No soy nuevo" is existing', () => {
      expect(readPatientStatus([ES, 'CALLER: No soy nuevo.'])).toBe('existing');
    });

    it('a negated-new answer that ALSO contains a new cue is still existing', () => {
      /**
       * Added because demoting NEGATED_NEW one layer survived every other case:
       * the layers above it all happen to agree on them. This is a turn where
       * they DISAGREE — "not my first time" carries a negated-new claim AND the
       * `first time` new cue — and it is an entirely ordinary way to answer the
       * question, so the ordering has to be load-bearing rather than incidental.
       */
      expect(
        readPatientStatus([EN, "CALLER: I'm not new, this is not my first time."]),
      ).toBe('existing');
    });

    it('but a bare "No soy paciente" is still NEW', () => {
      // The prefix is only an existing claim when "nuevo" follows it.
      expect(readPatientStatus([ES, 'CALLER: No soy paciente.'])).toBe('new');
    });
  });

  describe('R2-C — an explicit claim beats a qualifying clause', () => {
    /**
     * The broad `never been` cue outranked the caller's own direct answer, so a
     * patient saying "Existing, but I've never been to THIS office" was
     * classified new. The governance rule decides it: the negation does not
     * govern "existing" there, so the claim stands.
     */
    it('"Existing, but I\'ve never been to this office" is existing', () => {
      expect(
        readPatientStatus([EN, "CALLER: Existing, but I've never been to this office."]),
      ).toBe('existing');
    });

    it('the Spanish shape too', () => {
      expect(
        readPatientStatus([
          ES,
          'CALLER: Soy paciente existente, pero nunca he ido a esta oficina.',
        ]),
      ).toBe('existing');
    });

    it('and the negation STILL wins when it governs the claim', () => {
      // The case a whole-turn "explicit beats negation" rule would break. Both
      // sentences contain "existing" and a negator; only one is an existing
      // claim.
      expect(readPatientStatus([EN, "CALLER: I'm not an existing patient."])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: No soy paciente existente.'])).toBe('new');
    });

    it('a genuine never-been-a-patient is still new', () => {
      expect(readPatientStatus([EN, "CALLER: I've never been a patient."])).toBe('new');
      expect(readPatientStatus([EN, "CALLER: I have never been seen there."])).toBe('new');
    });
  });

  describe('through runTool — the gate follows the reader', () => {
    it('the qualified Spanish existing caller is looked up', async () => {
      notePatientStatus(SID, [ES, 'CALLER: No soy paciente nuevo; soy paciente existente.']);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('the qualified-then-unrelated-alternation caller is looked up', async () => {
      notePatientStatus(SID, [
        EN, 'CALLER: Existing.',
        'AGENT: Is the prescription new or existing?', 'CALLER: New.',
      ]);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });
  });
});

describe('Codex round 3 — three more P1s, and the reader is SMALLER, not patched', () => {
  /**
   * NINE P1s across three rounds, every one the same shape: a broad PROSE cue
   * answered `new`, and a negation or a qualifier in front of it made that
   * answer false. Rounds 1 and 2 were fixed structurally. Round 3 arrived with
   * three more of the identical shape, which is where another entry on a list
   * stops being a fix — the recommendation published on this PR and in the v59
   * marker row BEFORE round 3 landed, applied here rather than argued again.
   *
   * ALL SIX REPRODUCED CASES RETURNED `new` FOR AN EXISTING OR UNKNOWN CALLER,
   * so every one suppressed a lookup that should have run. That is the only
   * direction on this gate that costs anybody anything, so no base rate was
   * weighed — and all three are doors this PR's own change opened.
   *
   * THE INVARIANT THAT REPLACES THE PATCHES: `new` is only ever returned by a
   * DENIAL OF PATIENT HISTORY, an ungoverned "new patient", or a SENTENCE that
   * IS the answer. No prose infers `new`. Prose may only infer `existing`,
   * whose failure costs one tool call.
   */
  const EN = 'AGENT: Are you a new patient or an existing patient?';
  const ES = 'AGENT: ¿Es usted paciente nuevo o paciente existente?';

  describe('R3-A — the place-based and first-time cues are DELETED, not guarded', () => {
    /**
     * "No, this isn't my first time" matched `first time`; "I've never been
     * here, but I'm already a patient downtown" matched `never been here`.
     * Both returned `new`.
     *
     * Deleted rather than negation-guarded, because each cue is ambiguous AT
     * SOURCE and not merely negatable: a first time CALLING is not a first
     * time as a patient, and `si_locations` holds 105 offices, so "never been
     * here" is a PLACE and not the practice.
     */
    it("a negated first-time claim is not a new patient", () => {
      expect(readPatientStatus([EN, "CALLER: No, this isn't my first time."])).toBeUndefined();
    });

    it('a caller who has never been to THIS office but is a patient elsewhere is EXISTING', () => {
      expect(
        readPatientStatus([EN, "CALLER: I've never been here, but I'm already a patient downtown."]),
      ).toBe('existing');
    });

    it('and the same shape with no existing cue in it goes UNCLASSIFIED, never new', () => {
      // The fail-safe direction: the lookup runs, misses, and v50 bounds the
      // asks. Nothing is refused.
      expect(
        readPatientStatus([EN, "CALLER: I've never been here, I go to your Covina office."]),
      ).toBeUndefined();
    });

    it('the accepted coverage cost, stated rather than hidden', () => {
      expect(readPatientStatus([EN, 'CALLER: First time calling.'])).toBeUndefined();
      expect(readPatientStatus([EN, "CALLER: I've never been there."])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: Es mi primera vez.'])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: Nunca he venido.'])).toBeUndefined();
    });

    it('a denial of PATIENT history still answers new, in both languages', () => {
      expect(readPatientStatus([EN, "CALLER: I've never been a patient."])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: I have never been seen there.'])).toBe('new');
      expect(readPatientStatus([EN, "CALLER: I'm not an existing patient."])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Nunca he sido paciente.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: No soy paciente.'])).toBe('new');
    });

    it('and a denial does not read as the existing CLAIM buried inside it', () => {
      // Round 1's P1-A, and the reason the denial phrases are stripped out of
      // the text the existing prose reads: `been a patient` matches inside
      // "I've never been a patient".
      expect(readPatientStatus([EN, "CALLER: I've never been a patient here."])).toBe('new');
      // While a genuine existing claim in the same shape still lands.
      expect(readPatientStatus([EN, "CALLER: I've been a patient there for years."])).toBe('existing');
    });
  });

  describe('R3-B — a HEDGED negation is still a negation', () => {
    /**
     * `not\s+(an?\s+)?new` permitted only an article, so "I'm not really a new
     * patient" missed the negation AND missed the identical narrowing in
     * `ungoverned`, leaving `new patient` standing for the explicit layer to
     * read as `new`. Hedged negation is ordinary speech.
     */
    it('"I\'m not really a new patient" is existing', () => {
      expect(readPatientStatus([EN, "CALLER: I'm not really a new patient."])).toBe('existing');
    });

    it('"I\'m not exactly a new patient" is existing', () => {
      expect(readPatientStatus([EN, "CALLER: I'm not exactly a new patient."])).toBe('existing');
    });

    it('and the mirror: a hedged negation of EXISTING is new', () => {
      expect(readPatientStatus([EN, "CALLER: I'm not really an existing patient."])).toBe('new');
    });

    it('the Spanish hedge too', () => {
      expect(readPatientStatus([ES, 'CALLER: No soy realmente paciente nuevo.'])).toBe('existing');
    });

    it('an unhedged claim is untouched — the hedge is optional, not required', () => {
      expect(readPatientStatus([EN, 'CALLER: Not a new patient.'])).toBe('existing');
      expect(readPatientStatus([EN, "CALLER: I'm a new patient."])).toBe('new');
    });
  });

  describe('R3-C — re-ask eligibility EXPIRES with the status exchange', () => {
    /**
     * `seenQualified` lasted the whole call, so any clause-final new/existing
     * pair minutes later became a status window. Now a bare pair is a re-ask
     * only while the status conversation is still the most recent thing that
     * happened: one caller line OUTSIDE any window ends it. No timer, no magic
     * number — the caller moving on is the signal.
     */
    it('a glasses alternation later in the call does not overwrite the answer', () => {
      expect(
        readPatientStatus([
          EN, 'CALLER: Existing.',
          'AGENT: What can we help with?', 'CALLER: I need to pick up my order.',
          'AGENT: Are the glasses new or existing?', "CALLER: I'm new to progressives.",
        ]),
      ).toBe('existing');
    });

    it('but an IMMEDIATE re-ask still lands, which is what reversibility needs', () => {
      expect(
        readPatientStatus([
          EN, 'CALLER: New.',
          'AGENT: Sorry — new or existing?', 'CALLER: Existing, I came in last year.',
        ]),
      ).toBe('existing');
    });

    it('THE EXPIRY EARNS ITS PLACE: a later pair answered with an EXPLICIT cue', () => {
      /**
       * Added because the mutation removing the expiry SURVIVED the case above
       * — "I'm new to progressives" reads nothing at all now that the prose
       * cue is gone, so guard 2 covered it and the expiry did no work anybody
       * could see. This is the case guard 2 CANNOT cover: an explicit denial is
       * read whatever the window KIND, so without the expiry the later pair
       * opens a re-ask window and overwrites a real existing answer with `new`.
       *
       * The same shape as round 2's "guard 1 earns its place", one round on.
       */
      expect(
        readPatientStatus([
          EN, 'CALLER: Existing.',
          'AGENT: What can we help with?', 'CALLER: I need to pick up my order.',
          'AGENT: Are the glasses new or existing?', "CALLER: I'm not an existing patient.",
        ]),
      ).toBe('existing');
    });

    it('a re-ask still survives an agent line that opens no window', () => {
      // No caller turn in between, so the exchange has not been left.
      expect(
        readPatientStatus([
          EN, 'CALLER: New.',
          'AGENT: One moment.',
          'AGENT: Sorry — new or existing?', 'CALLER: Existing, I came in last year.',
        ]),
      ).toBe('existing');
    });
  });

  describe('THE INVARIANT — no prose may answer NEW', () => {
    it('every "new" prose shape a caller might say goes unclassified or existing', () => {
      for (const said of [
        "I'm new to progressives.",
        "I'm new in town.",
        'I need a new doctor.',
        'This is a new insurance card.',
        "I'm new to this plan.",
        'I have a new phone number.',
        'Necesito un seguro nuevo.',
      ]) {
        expect(readPatientStatus([EN, `CALLER: ${said}`])).not.toBe('new');
      }
    });

    it('and the three routes that DO answer new still do', () => {
      // 1. a denial of patient history, 2. an explicit new-patient claim,
      // 3. a SENTENCE that is the answer.
      expect(readPatientStatus([EN, 'CALLER: I have not been a patient here.'])).toBe('new');
      expect(readPatientStatus([EN, "CALLER: I'm a new patient."])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: Uh, new.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New patient.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Nuevo.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Soy nueva.'])).toBe('new');
    });

    it('the answer is a SENTENCE, which is what replaced both noun lists', () => {
      // "New." leading a longer turn still reads; "new" buried in a clause
      // does not — so no list has to enumerate `glasses`.
      expect(readPatientStatus([EN, "CALLER: New. I've never been there before."])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: I need new glasses.'])).toBeUndefined();
      expect(readPatientStatus([EN, "CALLER: I'm new here."])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: Necesito lentes nuevos.'])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: Necesito un número nuevo.'])).toBeUndefined();
    });
  });

  describe('AMBIGUITY MUST NOT SUPPRESS — the layer order is load-bearing', () => {
    /**
     * Added because the mutation moving the existing prose BELOW the denial
     * list survived every case in the file: `withoutDenials` already separates
     * the two for the strippable phrases, so the ORDER only matters for a
     * denial that is not one of them — `not an existing patient`, and its
     * Spanish shape.
     *
     * A turn carrying BOTH a direct denial and an existing claim is a caller
     * contradicting themselves, and the cost asymmetry decides it: reading
     * `existing` wastes one tool call, reading `new` loses the record of
     * somebody who has one. Ambiguity resolves toward LOOKING THEM UP.
     */
    it('a denial beside an existing claim resolves toward looking them up', () => {
      expect(
        readPatientStatus([EN, "CALLER: I'm not an existing patient. I saw Dr. Ruiz last year."]),
      ).toBe('existing');
    });

    it('the Spanish shape too', () => {
      expect(
        readPatientStatus([ES, 'CALLER: No soy paciente existente. Ya soy paciente de la clinica.']),
      ).toBe('existing');
    });

    it('while the denial ALONE is still new', () => {
      expect(readPatientStatus([EN, "CALLER: I'm not an existing patient."])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: No soy paciente existente.'])).toBe('new');
    });
  });

  describe('through runTool — the gate follows the smaller reader', () => {
    it('a hedged-negation caller is looked up', async () => {
      notePatientStatus(SID, [EN, "CALLER: I'm not really a new patient."]);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('a first-time-calling caller is looked up rather than suppressed', async () => {
      notePatientStatus(SID, [EN, 'CALLER: First time calling.']);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('and a caller who denies ever being a patient still suppresses it', async () => {
      notePatientStatus(SID, [EN, "CALLER: I've never been a patient."]);
      const out = await lookup({ queue: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).not.toHaveBeenCalled();
      expect(out.suppressed).toBe('caller_said_new');
    });
  });
});
