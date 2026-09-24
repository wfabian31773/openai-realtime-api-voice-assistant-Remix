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

const { runTool, getTool } = await import('./registry');
await import('./sharedPatientTools');
const { resetGateAttempts } = await import('./gateAttempts');
const {
  notePatientStatus,
  noteStatusOverride,
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
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });

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
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
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
      { queue: 'optical', lane: 'optical' },
      JSON.stringify({ success: true, found: false, suppressed: 'caller_said_new' }),
      4,
      { agentSlug: 'optical' },
    );
    const event = getAzulTimeline(callId)![0] as { outcome?: Record<string, unknown> };
    expect(event.outcome?.suppressed).toBe('caller_said_new');
  });

  it('a caller who said EXISTING is looked up exactly as before', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: Existing.']);
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('a caller who was never asked is looked up exactly as before', async () => {
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('suppression is per call — one caller saying new does not gate the next', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: OTHER, caller_phone: '555-555-0102' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('a sentinel call_sid is not a call: it neither stores nor suppresses', async () => {
    notePatientStatus('unknown', [ASK, 'CALLER: New.']);
    expect(patientStatusFor('unknown')).toBeUndefined();
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: 'unknown', caller_phone: '555-555-0103' });
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
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });
});

describe('the override, and why it needs its own store', () => {
  it('patient_status existing lifts the suppression and the lookup runs', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    const out = await lookup({
      queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101', patient_status: 'existing',
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  it('SURVIVES the next caller turn — the bug the two stores exist to prevent', async () => {
    notePatientStatus(SID, [ASK, 'CALLER: New.']);
    await lookup({
      queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101', patient_status: 'existing',
    });
    // The first version wrote the override into the same map the bridge
    // recomputes from the transcript, whose latest window still says "new" —
    // so the escape hatch closed again one caller turn after the model used it.
    notePatientStatus(SID, [ASK, 'CALLER: New.', 'AGENT: And your last name?', 'CALLER: Quixote.']);
    lookupSpy.mockClear();
    const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
  });

  /**
   * WITHDRAWN AT ROUND 6, and rewritten rather than deleted because the claim it
   * used to make is the defect.
   *
   * This asserted that `patient_status: 'new'` suppressed the lookup on its own,
   * with no transcript behind it — which is a suppression on the MODEL's word.
   * Codex round 6 found what that costs: on records, where a proxy is the caller
   * on 42% of calls, a `new` describing the CALLER suppressed the lookup for the
   * PATIENT whose chart they rang about (P1-A), and once stored it beat every
   * later transcript read for the rest of the call (P1-D). `existing` is now the
   * only override there is. The round-6 block has the full argument.
   */
  it('patient_status new suppresses NOTHING — only the transcript can', async () => {
    const out = await lookup({
      queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101', patient_status: 'new',
    });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(out.suppressed).toBeUndefined();
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
    expect(readPatientStatus([ASK, "CALLER: I've been seen there before."])).toBe('existing');
    // "I've never been a patient." used to read `new` here. Codex round 4 is why
    // it no longer does — the denial route is deleted; see that block below.
    expect(readPatientStatus([ASK, 'CALLER: Existing patient.'])).toBe('existing');
    // "First time calling." and "I've never been there." used to read `new`
    // here. Codex round 3 is why they no longer do — see that block below.
  });

  it('a later turn that says nothing does not lose the answer', () => {
    /**
     * REWRITTEN for Codex round 4. The old version posted a SHORTER record on
     * the second call, which the bridge never does — it always posts
     * `transcriptLog.lines` in full — so it asserted a call pattern that cannot
     * happen, and it would now pass only because of the bug round 4 found. The
     * whole record still carries the answering window, so the answer survives;
     * what does NOT survive is a window whose text has CHANGED (the R4-B block).
     */
    const record = [ASK, 'CALLER: New.'];
    notePatientStatus(SID, record);
    notePatientStatus(SID, [...record, 'AGENT: Anything else?', 'CALLER: No thank you.']);
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
    it('a denial of patient history is UNCLASSIFIED — round 4 deleted that route', () => {
      // These read `new` from round 1 until round 4, which found the family
      // admitted a location qualifier ("…at this office"). Unclassified now:
      // nothing suppressed, the lookup runs, v50 bounds the asks.
      expect(readPatientStatus([EN, "CALLER: I've never been a patient."])).toBeUndefined();
      expect(readPatientStatus([EN, 'CALLER: I have not been a patient here.'])).toBeUndefined();
      expect(readPatientStatus([EN, "CALLER: I'm not an existing patient."])).toBeUndefined();
    });

    it("and round 1's POINT survives: a denial never reads as an existing CLAIM", () => {
      // This is what `withoutDenials` is still for. `(been|was) (a )?patient`
      // matches inside "I've never been a patient", and reading that as
      // `existing` is the defect round 1 filed.
      expect(readPatientStatus([EN, "CALLER: I've never been a patient."])).not.toBe('existing');
      expect(readPatientStatus([EN, 'CALLER: I have never been seen there.'])).not.toBe('existing');
    });

    it('and the MIRROR still holds — a negated NEW is existing', () => {
      // The specific negation runs first, so this is the case that could have
      // been broken by fixing the one above. Both directions, both pinned.
      expect(readPatientStatus([EN, 'CALLER: Not a new patient.'])).toBe('existing');
      expect(readPatientStatus([EN, "CALLER: I'm not new."])).toBe('existing');
    });

    it('a plain existing claim is untouched — the cheap direction keeps its prose', () => {
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

    it('a Spanish denial is UNCLASSIFIED too, and never reads as existing', () => {
      // Round 3 deleted the place and first-time cues; round 4 deleted the
      // patient-history denial itself. Both directions pinned.
      expect(readPatientStatus([ES, 'CALLER: Nunca he sido paciente.'])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: No soy paciente existente.'])).toBeUndefined();
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
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).not.toHaveBeenCalled();
      expect(out.suppressed).toBe('caller_said_new');
    });

    it('a caller who never was a patient is now LOOKED UP, not suppressed', async () => {
      // Round 4: the denial route is gone, so this call behaves as it did before
      // the gate existed. The accepted cost, asserted through runTool.
      notePatientStatus(SID, [EN, "CALLER: I've never been a patient."]);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('a prescription question does NOT suppress it', async () => {
      notePatientStatus(SID, [
        'AGENT: Do you need a new prescription or refill an existing one?',
        'CALLER: New.',
      ]);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
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

    it('guard 1 earns its place: a window must not open on an unrelated pair', () => {
      /**
       * Added because the mutation removing guard 1 survived on the cases above
       * — guard 2 covered every one of them. This is the case guard 2 CANNOT
       * cover, because the answer is an explicit cue rather than a bare word:
       * without the prior-context requirement this opens a window and
       * suppresses a caller nobody ever asked about their patient status.
       */
      /**
       * REWRITTEN TWICE, and the second time is the honest part. Round 3 keyed
       * this on an explicit DENIAL, and round 4 deleted that route — so guard 1
       * no longer has any EXPENSIVE-direction job at all: with one `new` route,
       * qualified-only, guard 2 already makes a re-ask window unable to produce
       * `new` under any answer.
       *
       * What guard 1 still does is stop an unrelated alternation setting a status
       * at all. That is the cheap direction, it is worth two lines, and saying so
       * beats a test that looks like it proves more than it does.
       */
      expect(
        readPatientStatus(['AGENT: Is the frame new or existing?', 'CALLER: Existing.']),
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

    it('and a bare "No soy paciente" is unclassified, never existing', () => {
      // Round 4 deleted the denial route; what still matters is that the prefix
      // does not read as an existing CLAIM.
      expect(readPatientStatus([ES, 'CALLER: No soy paciente.'])).toBeUndefined();
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

    it('a governed existing claim is not an existing claim', () => {
      // The case a whole-turn "explicit beats negation" rule would break. Both
      // sentences contain "existing" and a negator; only one is an existing
      // claim.
      expect(readPatientStatus([EN, "CALLER: I'm not an existing patient."])).not.toBe('existing');
      expect(readPatientStatus([ES, 'CALLER: No soy paciente existente.'])).not.toBe('existing');
    });

    it('a genuine never-been-a-patient is unclassified after round 4', () => {
      expect(readPatientStatus([EN, "CALLER: I've never been a patient."])).toBeUndefined();
      expect(readPatientStatus([EN, 'CALLER: I have never been seen there.'])).toBeUndefined();
    });
  });

  describe('through runTool — the gate follows the reader', () => {
    it('the qualified Spanish existing caller is looked up', async () => {
      notePatientStatus(SID, [ES, 'CALLER: No soy paciente nuevo; soy paciente existente.']);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('the qualified-then-unrelated-alternation caller is looked up', async () => {
      notePatientStatus(SID, [
        EN, 'CALLER: Existing.',
        'AGENT: Is the prescription new or existing?', 'CALLER: New.',
      ]);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
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

    it('the denial route answered new until round 4 deleted it', () => {
      for (const said of [
        "I've never been a patient.",
        'I have never been seen there.',
        "I'm not an existing patient.",
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: Nunca he sido paciente.'])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: No soy paciente.'])).toBeUndefined();
    });

    it('and a denial does not read as the existing CLAIM buried inside it', () => {
      // Round 1's P1-A, and the reason the denial phrases are stripped out of
      // the text the existing prose reads: `been a patient` matches inside
      // "I've never been a patient".
      expect(readPatientStatus([EN, "CALLER: I've never been a patient here."])).toBeUndefined();
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

    it('and the mirror: a hedged negation of EXISTING is not an existing claim', () => {
      // Read `new` until round 4 deleted the denial route; the hedge still has
      // to stop it reading `existing`, which is what this pins.
      expect(readPatientStatus([EN, "CALLER: I'm not really an existing patient."])).not.toBe('existing');
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

    it('and the ONE route that answers new still does', () => {
      // Round 4 left exactly one: a SENTENCE that is the answer.
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
      // "New. I've never been there before." read `new` from round 3 until
      // round 5, which refuses ANY turn carrying a negation — see that block.
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

    it('while the denial ALONE is unclassified, and still not existing', () => {
      expect(readPatientStatus([EN, "CALLER: I'm not an existing patient."])).toBeUndefined();
      expect(readPatientStatus([ES, 'CALLER: No soy paciente existente.'])).toBeUndefined();
    });
  });

  describe('through runTool — the gate follows the smaller reader', () => {
    it('a hedged-negation caller is looked up', async () => {
      notePatientStatus(SID, [EN, "CALLER: I'm not really a new patient."]);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('a first-time-calling caller is looked up rather than suppressed', async () => {
      notePatientStatus(SID, [EN, 'CALLER: First time calling.']);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('and the ANSWER SENTENCE is what suppresses it, through runTool', async () => {
      notePatientStatus(SID, [EN, "CALLER: I'm a new patient."]);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).not.toHaveBeenCalled();
      expect(out.suppressed).toBe('caller_said_new');
    });
  });
});

describe('Codex round 4 — `new` now comes from ONE route', () => {
  /**
   * TWELVE P1s in one reader across four rounds, and round 4 found one in TWO
   * of the three routes round 3 left. Both the same shape yet again, and both
   * in the expensive direction.
   *
   * So the route that has NEVER produced a finding in four rounds is now the
   * only one: a SENTENCE THAT IS THE ANSWER, in a qualified window. That is a
   * deletion rather than another guard, and it closes both findings by
   * construction — there is no prose left for a qualifier or a subordinate
   * clause to defeat.
   */
  const EN = 'AGENT: Are you a new patient or an existing patient?';
  const ES = 'AGENT: ¿Es usted paciente nuevo o paciente existente?';

  describe('R4-A — a denial with a LOCATION qualifier', () => {
    /**
     * Round 3 deleted the place-based cues by NAME (`never been here`) and left
     * the qualifier that can follow the ones it kept. `si_locations` holds 105
     * offices, so a patient of another one says these and means the opposite.
     */
    it('an office-qualified denial does not suppress the lookup', () => {
      for (const said of [
        "I've never been seen at this office.",
        'I am not a patient at this location.',
        "I've never been a patient at your Covina office.",
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).not.toBe('new');
    });
  });

  describe('R4-B — a CONTAINS read cannot see a negation in the clause around it', () => {
    it('an uncertain or clause-negated new claim does not suppress the lookup', () => {
      for (const said of [
        "I don't think I'm a new patient.",
        "I don't believe I'm a new patient.",
        "I'm not sure if I'm a new patient.",
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).not.toBe('new');
    });

    it('while the caller who simply says it is still read', () => {
      expect(readPatientStatus([EN, "CALLER: I'm a new patient."])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New patient.'])).toBe('new');
    });
  });

  describe('R4-C — a transcript revision clears the stored verdict', () => {
    /**
     * `CallTranscriptLog.callerCompleted` REPLACES a caller line in place when
     * Grok re-emits the same item, so "New." can become "I need new glasses."
     * The read went to undefined and the store kept `new`, suppressing an
     * existing caller on words no longer in the transcript — and this module's
     * own docstring claimed the opposite was already true.
     *
     * DELETING IS SAFE BECAUSE THE LOG NEVER DROPS A LINE: `transcriptLog.ts`
     * only pushes or replaces in place, with no cap and no eviction, so an
     * answer given in an earlier window is still found on every later post.
     */
    it('a revision that removes the answer removes the suppression', () => {
      notePatientStatus(SID, [EN, 'CALLER: New.']);
      expect(patientStatusFor(SID)).toBe('new');
      notePatientStatus(SID, [EN, 'CALLER: I need new glasses.']);
      expect(patientStatusFor(SID)).toBeUndefined();
    });

    it('and the lookup runs again afterwards, through runTool', async () => {
      notePatientStatus(SID, [EN, 'CALLER: New.']);
      notePatientStatus(SID, [EN, 'CALLER: I need new glasses.']);
      const out = await lookup({ queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101' });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(out.suppressed).toBeUndefined();
    });

    it('an EARLIER window survives a later turn that says nothing', () => {
      // The whole record is re-read, so this is not a revision — it is growth.
      const record = [EN, 'CALLER: New.', 'AGENT: And your name?', 'CALLER: It is on the card.'];
      notePatientStatus(SID, record);
      expect(patientStatusFor(SID)).toBe('new');
    });

    it('and the model\'s OVERRIDE is not touched by any of it', async () => {
      notePatientStatus(SID, [EN, 'CALLER: New.']);
      await lookup({
        queue: 'optical', lane: 'optical', call_sid: SID, caller_phone: '555-555-0101', patient_status: 'existing',
      });
      notePatientStatus(SID, [EN, 'CALLER: New.']);
      expect(patientStatusFor(SID)).toBe('existing');
    });
  });

  describe('THE INVARIANT — one route, and prose can only answer existing', () => {
    it('no prose answers new, in either language', () => {
      for (const said of [
        "I've never been a patient.",
        "I'm not an existing patient.",
        "I've never been seen at this office.",
        "I don't think I'm a new patient.",
        'First time calling.',
        "I'm new to progressives.",
        'I need a new doctor.',
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).not.toBe('new');
      for (const said of ['Nunca he sido paciente.', 'No soy paciente existente.']) {
        expect(readPatientStatus([ES, `CALLER: ${said}`])).not.toBe('new');
      }
    });

    it('and the answer sentence is the only thing that does', () => {
      expect(readPatientStatus([EN, 'CALLER: New.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: Uh, new.'])).toBe('new');
      expect(readPatientStatus([EN, "CALLER: I'm a new patient."])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Nuevo.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Soy nueva.'])).toBe('new');
    });

    it('prose still answers EXISTING, which is the cheap direction', () => {
      expect(readPatientStatus([EN, "CALLER: I've been a patient there for years."])).toBe('existing');
      expect(readPatientStatus([EN, 'CALLER: Not a new patient.'])).toBe('existing');
      expect(readPatientStatus([EN, 'CALLER: Existing.'])).toBe('existing');
      expect(readPatientStatus([ES, 'CALLER: Ya soy paciente.'])).toBe('existing');
    });
  });
});

describe('Codex round 5 — the answer must be DECLARATIVE and uncontradicted', () => {
  /**
   * Round 4 left one route to `new`: a sentence that IS the answer. Round 5
   * found it defeated two ways, both inside that route rather than in prose.
   *
   * Two mechanical rules, neither a cue list — which matters, because a list of
   * rejection phrases is exactly what the twelve earlier P1s came out of.
   */
  const EN = 'AGENT: Are you a new patient or an existing patient?';
  const ES = 'AGENT: ¿Es usted paciente nuevo o paciente existente?';

  describe('R5-A — an echoed option is a question, not an answer', () => {
    /**
     * The old splitter discarded the terminator, so "New? I don't think so."
     * handed the reader the segment `new` and the caller who QUESTIONED the
     * option was read as answering it.
     */
    it('an interrogative echo does not suppress the lookup', () => {
      expect(readPatientStatus([EN, "CALLER: New? I don't think so."])).not.toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New?'])).not.toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New patient?'])).not.toBe('new');
    });

    it('while the declarative answer still reads', () => {
      expect(readPatientStatus([EN, 'CALLER: New.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New patient.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Nuevo.'])).toBe('new');
    });
  });

  describe('R5-B — the answer plus a rejection is not a clean answer', () => {
    /**
     * REWRITTEN AT ROUND 6, not loosened. Round 5 called this rule "any
     * negation in the turn" and implemented it as a closed negator list tested
     * per TURN; round 6 found both halves wrong (R6-B, R6-C) and replaced the
     * rule with "the answer must be the whole of what they said in the window".
     * Every case below still refuses, for the better reason — the rejection is a
     * second substantive segment — so the assertions stand and the NAME was the
     * only thing making a claim the code no longer makes.
     */
    it('the answer plus a rejection is not a clean answer', () => {
      for (const said of [
        "New. I don't think so.",
        'New, no, sorry.',
        "New. I'm not sure actually.",
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).not.toBe('new');
    });

    it('THE ACCEPTED COST, stated rather than hidden', () => {
      // Supported from round 3 until round 5. Unclassified now: nothing is
      // suppressed, the lookup runs, LOOKUP_MISS_LIMIT bounds the asks.
      expect(readPatientStatus([EN, "CALLER: New. I've never been there before."])).toBeUndefined();
    });

    it('and a clean answer with harmless filler still reads', () => {
      expect(readPatientStatus([EN, 'CALLER: Uh, new.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: Yes, new patient.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Soy nueva.'])).toBe('new');
    });
  });

  describe('the cheap direction is deliberately untouched', () => {
    it('an interrogative or negated turn may still read EXISTING', () => {
      // A wrong `existing` costs one lookup, so `EXPLICIT_EXISTING` keeps its
      // contains read and neither round-5 rule is applied to it.
      expect(readPatientStatus([EN, 'CALLER: Existing?'])).toBe('existing');
      expect(readPatientStatus([EN, 'CALLER: Not a new patient.'])).toBe('existing');
    });
  });
});

describe('Codex round 6 — the answer is the WHOLE of what they said, and `new` is not an override', () => {
  /**
   * Four P1s, all reproduced against the real reader before anything changed,
   * all in the expensive direction — a caller who did NOT claim to be new whose
   * record we then refuse to look for. Two of them are inside round 5's own
   * guard; two are on the model's override, which no longer accepts `new` at
   * all. That single narrowing closes both, and is smaller than the lane
   * plumbing either finding suggested.
   */
  const EN = 'AGENT: Are you a new patient or an existing patient?';
  const ES = 'AGENT: ¿Es usted paciente nuevo o paciente existente?';

  describe('R6-B — the negator list was short, so it is GONE from this route', () => {
    /**
     * `NEG` carries no modals, so every one of these read `new`. Adding `can't`
     * and `cannot` would be the thirteenth entry on a list that can always be
     * one short — the shape of all twelve earlier P1s — so the list is removed
     * from the `new` path instead: a rejection is a second substantive segment
     * and that is all the reader has to notice.
     *
     * These are BEHAVIOURAL, deliberately: they name no list, so they keep
     * biting however the rule is written.
     */
    it('a rejection the old list could not see still refuses', () => {
      for (const said of [
        "New. That can't be right.",
        'New. I cannot be.',
        "New. That couldn't be right.",
        'New. Nope.',
        'New. Nah.',
        'New. Wrong.',
        'New. Neither.',
        'New. Scratch that.',
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).not.toBe('new');
    });

    it('and every alternative the old list DID carry still refuses', () => {
      // Not a claim about the list — a claim that removing it cost nothing.
      for (const said of [
        'New. Not really.',
        'New. Never mind.',
        'New. No.',
        "New. It isn't.",
        "New. I don't think so.",
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).not.toBe('new');
    });
  });

  describe('R6-C — the window is not a turn', () => {
    /**
     * A window holds every caller turn until the next agent line, and round 5
     * tested its negation per turn — so the same words that correctly read
     * nothing in ONE turn read `new` when the caller paused between them. My own
     * docstring said "whole-turn" while the unit being read was the window.
     */
    it('a rejection in a LATER caller turn of the same window refuses', () => {
      expect(readPatientStatus([EN, 'CALLER: New.', "CALLER: I don't think so."])).not.toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New.', "CALLER: That can't be right."])).not.toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New.', 'CALLER: Sorry, existing.'])).not.toBe('new');
    });

    it('and the same words in one turn refuse too — the two agree now', () => {
      expect(readPatientStatus([EN, "CALLER: New. I don't think so."])).not.toBe('new');
    });

    it('a NEW WINDOW is still read on its own, not against the old one', () => {
      // The agent asking again closes the window; the latest one wins, which is
      // the reversibility this gate leans on.
      const record = [
        EN, 'CALLER: New.', "CALLER: I don't think so.",
        EN, 'CALLER: New.',
      ];
      expect(readPatientStatus(record)).toBe('new');
    });
  });

  describe('exactly one substantive segment — the rule, and what it costs', () => {
    it('THE ACCEPTED COST: an answer with anything added goes unclassified', () => {
      // Safe direction on every one: nothing suppressed, the lookup runs,
      // LOOKUP_MISS_LIMIT bounds the asks, the ticket files. Whether to buy this
      // coverage back is the operator's dial and cannot be measured until the
      // question is asked in production.
      for (const said of [
        'New. This is my first visit.',
        'New. I need an appointment.',
        'New. My wife is a patient here.',
      ]) expect(readPatientStatus([EN, `CALLER: ${said}`])).toBeUndefined();
    });

    it('pure filler does not count as a second thing', () => {
      expect(readPatientStatus([EN, 'CALLER: New. Thanks.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: Hello? New.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: Hello?', 'CALLER: New.'])).toBe('new');
      expect(readPatientStatus([ES, 'CALLER: Hola. Nuevo.'])).toBe('new');
    });

    it('and the ANSWER may sit in an earlier turn than the filler', () => {
      /**
       * THE CASE THAT CATCHES A LAST-TURN READ, added because a mutation found
       * the gap: every other case here puts the answer in the final caller turn,
       * so a reader that looked only at that turn passed all of them. Here the
       * answer is in the FIRST turn and the last is filler, which only a read of
       * the whole window gets right.
       */
      expect(readPatientStatus([EN, 'CALLER: New.', 'CALLER: Thank you.'])).toBe('new');
      expect(readPatientStatus([EN, 'CALLER: New patient.', 'CALLER: Okay.'])).toBe('new');
    });

    it('NO NEGATOR IS FILLER — the one property that list must keep', () => {
      // FILLER_ONLY expands acceptance, so a negator smuggled into it would make
      // "New." / "No." read as a clean answer. Every alternative of NEG, alone in
      // its own segment, must refuse.
      for (const negator of [
        'not', 'never', 'no', "isn't", "aren't", "wasn't", "ain't", "don't", 'dont',
      ]) {
        expect(readPatientStatus([EN, 'CALLER: New.', `CALLER: ${negator}.`])).not.toBe('new');
      }
    });

    it('the clean answers all still read, in both languages', () => {
      for (const said of ['New.', 'New', 'Uh, new.', "I'm a new patient.", 'New patient.']) {
        expect(readPatientStatus([EN, `CALLER: ${said}`])).toBe('new');
      }
      for (const said of ['Nuevo.', 'Soy paciente nuevo.', 'Soy nueva.']) {
        expect(readPatientStatus([ES, `CALLER: ${said}`])).toBe('new');
      }
    });
  });

  describe('R6-A + R6-D — `existing` is the only override there is', () => {
    /**
     * R6-A: `patient_status` was offered to every lane, so a RECORDS agent —
     * whose caller is a proxy on 42% of calls (2026-09-10..18, 87 of 206) —
     * could send `new` describing the CALLER and suppress the lookup for the
     * PATIENT whose chart they rang about. Round 5 took the QUESTION off that
     * lane and left this door open beside it.
     *
     * R6-D: a stored `new` then beat every later transcript read for the rest of
     * the call, so a caller correcting themselves could not get out — the escape
     * hatch this store exists to BE, locked from the inside.
     *
     * Both close by narrowing: the store holds a timestamp, `existing` is the
     * only value, and a `new` the model asserts changes nothing anywhere.
     */
    it('a model-asserted `new` suppresses NOTHING, on any lane', async () => {
      const out = await lookup({
        queue: 'optical', lane: 'optical',
        call_sid: SID,
        caller_phone: '555-555-0101',
        patient_status: 'new',
      });
      expect(out.suppressed).toBeUndefined();
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(patientStatusFor(SID)).toBeUndefined();
    });

    it('and it cannot outlive a transcript that says existing', () => {
      // The pre-round-6 store would answer `new` here for the whole TTL.
      noteStatusOverride(SID, 'new' as 'existing');
      notePatientStatus(SID, [EN, 'CALLER: Existing.']);
      expect(patientStatusFor(SID)).toBe('existing');
    });

    it('while the `existing` override stays sticky — the cheap direction', () => {
      // Sticky is right here and indefensible the other way round: a needless
      // lookup costs one tool call, a needless suppression costs a record.
      noteStatusOverride(SID, 'existing');
      notePatientStatus(SID, [EN, 'CALLER: New.']);
      expect(patientStatusFor(SID)).toBe('existing');
    });

    it('the schema offers the model one value and says not to report `new`', () => {
      const def = getTool('lookup_patient')!;
      const field = def.input_schema.properties.patient_status as Record<string, unknown>;
      expect(field.enum).toEqual(['existing']);
      expect(String(field.description)).toMatch(/never send this to report that somebody is new/i);
    });
  });
});

describe('Codex round 7 — only a lane that ASKS may read the answer', () => {
  /**
   * Round 5 took the question off records. Round 6 took `new` off the override.
   * The transcript READER still read every lane, which is the door this closes —
   * and the `askAs` that could nudge a records model into asking the question is
   * gone with it, because `realtimeAdapter` sends the whole `input_schema` to the
   * model (`parameters: { ...def.input_schema }`).
   *
   * The failure it prevents is a CATEGORY error, not a mis-read: on records the
   * caller is a proxy on 42% of calls (2026-09-10..18, 87 of 206), so their
   * "New." describes THEMSELVES while the gate would read it as the patient
   * whose chart they rang about — and suppress that patient's lookup.
   */
  const EN = 'AGENT: Are you a new patient or an existing patient?';
  const WINDOW = [EN, 'CALLER: New.'];

  it('the three asking lanes suppress, exactly as before', async () => {
    for (const lane of ['optical', 'surgery', 'tech']) {
      resetPatientStatuses(); resetGateAttempts(); lookupSpy.mockClear();
      notePatientStatus(SID, WINDOW);
      const out = await lookup({ queue: 'optical', lane, call_sid: SID, caller_phone: '555-555-0101' });
      expect(out.suppressed, lane).toBe('caller_said_new');
      expect(lookupSpy, lane).not.toHaveBeenCalled();
    }
  });

  it('RECORDS does not, even with a full qualified window on the call', async () => {
    notePatientStatus(SID, WINDOW);
    // The reader still finds it — this is the LANE refusing to act on it, not the
    // window failing to open.
    expect(patientStatusFor(SID)).toBe('new');
    const out = await lookup({ lane: 'records', call_sid: SID, caller_phone: '555-555-0101' });
    expect(out.suppressed).toBeUndefined();
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });

  it('and NO lane does not either — the HTTP surface, pcp, no-ivr, answering-service', async () => {
    /**
     * The absent-lane default fails in the CHEAP direction: the lookup runs, and
     * a miss on a genuinely new patient is expected (RULE ZERO 2a). It does mean
     * a lane that forgets to inject its name has an inert gate, which is what the
     * source pins below exist for.
     */
    notePatientStatus(SID, WINDOW);
    const out = await lookup({ call_sid: SID, caller_phone: '555-555-0101' });
    expect(out.suppressed).toBeUndefined();
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });

  it('every asking agent injects its own lane — read from the SOURCE', async () => {
    // Failure mode 10: the three assertions above prove the gate reads a lane,
    // not that any agent supplies one. A lane that stops injecting it has an
    // inert gate and no helper test can see that.
    const { readFileSync } = await import('node:fs');
    for (const [file, lane] of [
      ['src/agents/opticalAgent.ts', 'optical'],
      ['src/agents/surgeryAgent.ts', 'surgery'],
      ['src/agents/techAgent.ts', 'tech'],
    ] as const) {
      expect(readFileSync(file, 'utf8'), file).toContain(`lane: '${lane}',`);
    }
  });

  it('and the lane table is ONE table, shared with the runtime that asks', async () => {
    const { LANES_THAT_ASK } = await import('../runtime/newOrExistingAsk');
    expect([...LANES_THAT_ASK].sort()).toEqual(['optical', 'surgery', 'tech']);
    expect(LANES_THAT_ASK.has('records')).toBe(false);
  });

  it('the question no longer reaches the model, and the house rule still holds', async () => {
    /**
     * Codex was right that `askAs` reached the model — `parameters` spread the
     * whole `input_schema` — and WRONG about where to fix it: every field in this
     * file carries an `askAs` by house convention (`sharedPatientTools.test.ts`:
     * "a tool asking for something hands the agent the sentence to say"), so
     * deleting this one traded a leak for a hole in that contract. The full suite
     * caught exactly that. `stripInternalKeys` fixes the TRANSPORT instead, for
     * every tool and field at once.
     */
    const field = getTool('lookup_patient')!.input_schema.properties.patient_status as
      Record<string, unknown>;
    expect(field.askAs).toBe('Are you a new patient or an existing patient?');

    // THE HELPER ONLY. That the ADAPTER calls it is asserted on the BUILT tool in
    // `realtimeAdapter.test.ts` — a mutation reverting the call site survived this
    // assertion, which is failure mode 10 inside the round that cited it.
    const { stripInternalKeys } = await import('./realtimeAdapter');
    const sent = stripInternalKeys(getTool('lookup_patient')!.input_schema);
    for (const props of Object.values(sent.properties as Record<string, unknown>)) {
      expect((props as Record<string, unknown>).askAs).toBeUndefined();
    }
  });
});
