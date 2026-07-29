import { describe, it, expect } from 'vitest';
import { runAzulRubric, RUBRIC_VERSION, type RubricInput } from './azulRubric';

/**
 * The grader's own grader.
 *
 * A rubric that misfires is worse than no rubric: the regression watch files
 * tickets on it, and the first few false HIGHs teach everyone to ignore the
 * next real one. So every dimension gets both directions — the real 07-28
 * call that motivated it must FAIL, and the innocent call next to it must
 * PASS.
 */

function t(...lines: Array<[who: 'AGENT' | 'CALLER', text: string]>): string {
  return lines.map(([who, text]) => `${who}: ${text}`).join('\n');
}

function grade(input: RubricInput, name: string) {
  const r = runAzulRubric(input).find((g) => g.grader === name);
  if (!r) throw new Error(`grader ${name} did not run`);
  return r;
}

describe('azul rubric v2', () => {
  it('is version 3', () => {
    expect(RUBRIC_VERSION).toBe(3);
  });

  it('runs every dimension even when one throws', () => {
    const results = runAzulRubric({ transcript: '', events: [] });
    expect(results).toHaveLength(12);
    expect(new Set(results.map((r) => r.grader)).size).toBe(12);
  });

  // ── D1 urgency ────────────────────────────────────────────────────────
  describe('urgency_routing', () => {
    it('fails an urgent caller who was only booked', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', "I'm seeing flashes and a curtain over my left eye since this morning."],
            ['AGENT', 'I can get you in on Tuesday at 9:00 AM. Does that work?'],
            ['CALLER', 'I guess so.'],
          ),
          events: [
            { tool: 'sage_availability', outcome: { say: 'I have Tuesday at 9:00 AM.' } },
            { tool: 'sage_book', outcome: { booking_status: 'confirmed' } },
          ],
        },
        'rubric_urgency_routing',
      );
      expect(r.pass).toBe(false);
      expect(r.severity).toBe('critical');
      expect(r.detail).toMatch(/flashes|curtain/i);
    });

    it('passes when the urgent caller was routed to a human', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', 'My eye hurts really bad and I can barely see.'],
            ['AGENT', "That needs to be looked at today — let me get you to our team right now."],
          ),
          events: [{ tool: 'sage_handoff', outcome: { ok: true, handoffReason: 'urgent_symptom' } }],
        },
        'rubric_urgency_routing',
      );
      expect(r.pass).toBe(true);
    });

    it('treats running out of post-op drops as surgical, not front-office', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', "I had cataract surgery last week and I'm running out of drops."],
            ['AGENT', 'I can book you a follow-up on Thursday at 2:00 PM.'],
          ),
          events: [{ tool: 'sage_book', outcome: { booking_status: 'confirmed' } }],
        },
        'rubric_urgency_routing',
      );
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/surgical\/post-op/);
    });

    it('does not fire on an ordinary booking call', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', "I'd like to schedule my annual eye exam."],
            ['AGENT', 'I have Tuesday at 9:00 AM.'],
          ),
          events: [{ tool: 'sage_availability', outcome: { say: 'Tuesday at 9:00 AM.' } }],
        },
        'rubric_urgency_routing',
      );
      expect(r.pass).toBe(true);
      expect(r.detail).toMatch(/n\/a/);
    });
  });

  // ── D3 loops ──────────────────────────────────────────────────────────
  describe('repetition', () => {
    it('fails a third ask on the same topic', () => {
      const r = grade(
        {
          transcript: t(
            ['AGENT', 'Can I get your date of birth?'],
            ['CALLER', 'I already gave it to you.'],
            ['AGENT', 'Sorry, what is your date of birth?'],
            ['CALLER', 'March third, nineteen eighty five.'],
            ['AGENT', 'And your date of birth please?'],
          ),
          events: [],
        },
        'rubric_repetition',
      );
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/date of birth/);
    });

    it('allows two asks — one retry is legitimate', () => {
      const r = grade(
        {
          transcript: t(
            ['AGENT', 'Can I get your date of birth?'],
            ['CALLER', '...'],
            ['AGENT', "I didn't catch that — what is your date of birth?"],
          ),
          events: [],
        },
        'rubric_repetition',
      );
      expect(r.pass).toBe(true);
    });

    it('does not count the caller repeating themselves', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', 'My date of birth is March third.'],
            ['CALLER', 'Date of birth March third!'],
            ['CALLER', 'I said my date of birth is March third.'],
            ['AGENT', 'Thank you, I have that.'],
          ),
          events: [],
        },
        'rubric_repetition',
      );
      expect(r.pass).toBe(true);
    });
  });

  // ── the 4:54pm invented slot ──────────────────────────────────────────
  describe('offer_integrity', () => {
    it('fails the 4:54pm call: a 10:00 AM offer that no tool ever returned', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', 'Can I get ten o’clock with Dr. Wernow?'],
            ['AGENT', 'Let me check our openings for you.'],
            ['AGENT', 'I have 10:00 AM available with Dr. Wernow. Shall I book it?'],
            ['CALLER', 'Yes please.'],
          ),
          events: [
            { tool: 'sage_availability', outcome: { say: 'The earliest I have is 8:10 AM.' } },
          ],
        },
        'rubric_offer_integrity',
      );
      expect(r.pass).toBe(false);
      expect(r.severity).toBe('critical');
      expect(r.detail).toMatch(/invented slot/);
    });

    it('passes when the offered time came back from the tool', () => {
      const r = grade(
        {
          transcript: t(['AGENT', 'I have 8:10 AM available. Does that work?']),
          events: [{ tool: 'sage_availability', outcome: { say: 'The earliest I have is 8:10 AM.' } }],
        },
        'rubric_offer_integrity',
      );
      expect(r.pass).toBe(true);
    });

    it('matches a 24-hour tool result against a spoken 12-hour time', () => {
      const r = grade(
        {
          transcript: t(['AGENT', "You're all set for 2:30 PM on Thursday."]),
          events: [{ tool: 'sage_book', outcome: { booking_status: 'confirmed', start: '2026-07-31T14:30:00' } }],
        },
        'rubric_offer_integrity',
      );
      expect(r.pass).toBe(true);
    });

    it('does not fire when the agent is only repeating the request', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', 'Do you have anything at 10:00?'],
            ['AGENT', 'Let me look for 10:00 and see what I can find.'],
          ),
          events: [{ tool: 'sage_availability', outcome: { say: 'The earliest I have is 8:10 AM.' } }],
        },
        'rubric_offer_integrity',
      );
      expect(r.pass).toBe(true);
    });
  });

  // ── D4 mishearings ────────────────────────────────────────────────────
  describe('name_fidelity', () => {
    it('fails when the agent attributes its own spelling to the caller', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', 'My last name is Nguyen.'],
            ['AGENT', 'You said Wynn, is that right?'],
          ),
          events: [],
        },
        'rubric_name_fidelity',
      );
      expect(r.pass).toBe(false);
      expect(r.detail).toMatch(/Wynn/);
    });

    it('passes when the agent repeats what the caller actually said', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', 'My last name is Nguyen.'],
            ['AGENT', 'You said Nguyen — let me look that up.'],
          ),
          events: [],
        },
        'rubric_name_fidelity',
      );
      expect(r.pass).toBe(true);
    });

    it('ignores conversational "you said that"', () => {
      const r = grade(
        {
          transcript: t(
            ['CALLER', 'I already told you.'],
            ['AGENT', 'You said that, thank you for your patience.'],
          ),
          events: [],
        },
        'rubric_name_fidelity',
      );
      expect(r.pass).toBe(true);
    });
  });

  // ── D5 the Catron double-booking ──────────────────────────────────────
  describe('write_once', () => {
    it('fails a second sage_book after a confirmed booking', () => {
      const r = grade(
        {
          transcript: '',
          events: [
            { tool: 'sage_book', outcome: { booking_status: 'confirmed' } },
            { tool: 'sage_book', outcome: { booking_status: 'confirmed' } },
          ],
        },
        'rubric_write_once',
      );
      expect(r.pass).toBe(false);
      expect(r.severity).toBe('critical');
      expect(r.detail).toMatch(/sage_book/);
    });

    it('allows a retry after a FAILED write', () => {
      const r = grade(
        {
          transcript: '',
          events: [
            { tool: 'sage_book', outcome: { error: 'slot_taken' } },
            { tool: 'sage_book', outcome: { booking_status: 'confirmed' } },
          ],
        },
        'rubric_write_once',
      );
      expect(r.pass).toBe(true);
    });

    it('fails a second intake after duplicate_detected was already a success', () => {
      const r = grade(
        {
          transcript: '',
          events: [
            { tool: 'sage_new_patient_intake', outcome: { status: 'created' } },
            { tool: 'sage_new_patient_intake', outcome: { status: 'duplicate_detected' } },
          ],
        },
        'rubric_write_once',
      );
      expect(r.pass).toBe(false);
    });
  });

  // ── calibration against the first real sim run (2026-07-29) ───────────
  // Every case below is a FALSE POSITIVE the rubric produced on its first
  // outing against sim traces, blocking a publish it had no business
  // blocking. They are kept as tests so the fixes can't quietly regress.
  describe('false positives from the first sim run', () => {
    it('counts an accepted sage_handoff as a terminal disposition', () => {
      // The `urgent` persona: flashes and a curtain, correctly routed to a
      // human — and scored a dead end, because the terminal list only knew
      // about transfer_to_office and file_location_ticket, neither of which
      // exists in the sim rig.
      const r = grade(
        {
          transcript: t(
            ['CALLER', "I've been seeing flashes and a dark curtain since this morning."],
            ['AGENT', 'I want to get you to our clinical team right away.'],
          ),
          events: [{ tool: 'sage_handoff', outcome: { ok: true, handoffReason: 'urgent_symptom' } }],
        },
        'rubric_terminal_disposition',
      );
      expect(r.pass).toBe(true);
    });

    it('does NOT accept an unreadable handoff response as routing', () => {
      // Codex review, PR #49. summarizeResult stores {unparsed:true} when the
      // response can't be parsed (the rig stores {raw:...}); neither carries an
      // error, so "not obviously failed" would have scored the service falling
      // over as a clean disposition — the exact dead-end class D2 exists for.
      for (const outcome of [{ unparsed: true }, { raw: '502 Bad Gateway' }, {}]) {
        const r = grade(
          { transcript: t(['CALLER', 'Please put me through to someone.']), events: [{ tool: 'sage_handoff', outcome }] },
          'rubric_terminal_disposition',
        );
        expect(r.pass, JSON.stringify(outcome)).toBe(false);
      }
    });

    it('does not accept `method` as proof of routing', () => {
      // method rides the timeline whether the handoff succeeded or not.
      const r = grade(
        {
          transcript: t(['CALLER', 'Connect me to a person.']),
          events: [{ tool: 'sage_handoff', outcome: { ok: false, method: 'callback' } }],
        },
        'rubric_terminal_disposition',
      );
      expect(r.pass).toBe(false);
    });

    it('still calls a REFUSED handoff a dead end', () => {
      const r = grade(
        {
          transcript: t(['CALLER', 'Just connect me to a person.']),
          events: [{ tool: 'sage_handoff', outcome: { ok: false, error: 'identity_required' } }],
        },
        'rubric_terminal_disposition',
      );
      expect(r.pass).toBe(false);
    });

    it('abstains from say-verbatim when the call was translated', () => {
      // The `spanish` persona scored 17% for obeying the language rule: the
      // directive arrives in English and MUST be delivered in Spanish.
      const r = grade(
        {
          transcript: t(
            ['CALLER', '¿Hablas español?'],
            ['AGENT', 'La oficina de Encinitas está abierta de lunes a viernes, de 8 AM a 5 PM. ¿Hay algo más en lo que pueda ayudarte?'],
          ),
          events: [{ tool: 'sage_info', outcome: { say: 'The Encinitas office is open Monday through Friday, 8 AM to 5 PM.' } }],
        },
        'rubric_say_verbatim',
      );
      expect(r.pass).toBe(true);
      expect(r.detail).toMatch(/another language/);
    });

    it('recognises Spanish that is not about office hours', () => {
      // Codex review, PR #49: the first marker list was drawn from the one
      // Spanish call I had, which was office-hours vocabulary. An appointment
      // script shares none of those words and would have been graded as an
      // English deviation — the same false positive, one sentence over.
      for (const line of [
        'Su cita es el martes a las diez de la mañana.',
        'El doctor Nayer puede verla en nuestra oficina de Oceanside.',
        'La dirección es cuatro cinco cero, calle segunda, y hay estacionamiento.',
      ]) {
        const r = grade(
          {
            transcript: t(['CALLER', '¿Puede hablar en español?'], ['AGENT', line]),
            events: [{ tool: 'sage_info', outcome: { say: 'Your appointment is Tuesday at ten in the morning at our Oceanside office.' } }],
          },
          'rubric_say_verbatim',
        );
        expect(r.pass, line).toBe(true);
        expect(r.detail, line).toMatch(/another language/);
      }
    });

    it('does not let one foreign courtesy excuse an English call', () => {
      const r = grade(
        {
          transcript: t(['AGENT', 'De nada! So, we open at a totally different time than the system said.']),
          events: [{ tool: 'sage_info', outcome: { say: 'The Encinitas office is open Monday through Friday, 8 AM to 5 PM.' } }],
        },
        'rubric_say_verbatim',
      );
      expect(r.pass).toBe(false);
    });
  });

  // ── the v1 dimensions still behave ────────────────────────────────────
  it('keeps the v1 dimensions working', () => {
    const results = runAzulRubric({
      transcript: t(['AGENT', 'Your appointment is confirmed.']),
      events: [{ tool: 'sage_book', outcome: { booking_status: 'confirmed' } }],
    });
    expect(results.find((r) => r.grader === 'rubric_identifier_hygiene')?.pass).toBe(true);
    expect(results.find((r) => r.grader === 'rubric_terminal_disposition')?.pass).toBe(true);
  });
});
