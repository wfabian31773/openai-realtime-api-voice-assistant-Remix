/**
 * THE PROMPT MUST NOT CONTAIN THE LIST. IT REVERSED ITSELF ON 2026-08-17.
 *
 * The original version of this file pinned the OPPOSITE property — that every
 * director question appeared in the prompt, in order. That was written on
 * 08-14, when the operator said the sequencing was "all over the place"
 * because the model invented its own order:
 *
 *   agent   "May I have your name, please?"
 *   caller  "Yeah, it's Wayne Fabian."
 *   agent   "Thank you, Wayne. What is your role?"
 *   agent   "Of course — may I have your name and the office or medical group?"
 *
 * Rendering the whole numbered intake into the prompt (#201) did stop the
 * invention. It replaced it with something worse: the model could see every
 * question, so it READ AHEAD and fired several per turn. From CAc88c6e9c on
 * 08-17, with the turn table beside it —
 *
 *   agent  "Which organization are you calling from?"        12:16:30.887
 *   agent  "Is this number ending in 7471 the best one?"     12:16:32.028  +1,141ms
 *   caller "You didn't give me a chance to respond..."       12:16:50.528
 *
 * No caller turn and no tool call between them. Two different fields in one
 * breath. The operator: "you gotta wait for a fucking answer. One answer at a
 * time."
 *
 * THE LESSON, and it is why this file now tests the inverse: the director has
 * ALWAYS handed over exactly one field at a time. `record_pcp_intake` returns
 * `nextQuestion` and nothing else. The list in the prompt was redundant on the
 * day it was written, and redundant context the model can act on is not
 * harmless — it is an invitation.
 *
 * So: the prompt describes the PROTOCOL, never the contents. The order still
 * lives in exactly one place (the director), and director.test.ts /
 * gateRecovery.test.ts pin that it is right.
 */
import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const { buildPcpPrompt } = await import('../agents/pcpAgent');
const { PROFESSIONAL_FIELDS, PATIENT_INTAKE_ORDER, PROMPTS, PcpDirector } = await import('./director');

const prompt = buildPcpPrompt({ callerPhone: '+18455317471' } as never);

describe('the model cannot read ahead, because it is not given the list', () => {
  it('no intake question appears in the prompt', () => {
    /**
     * The direct regression test for CAc88c6e9c. Every one of these in the
     * prompt is a question the model can ask before the caller has answered
     * the last one.
     */
    for (const f of PROFESSIONAL_FIELDS) {
      const q = PROMPTS[f];
      if (!q) continue;
      expect(prompt, `prompt still contains "${q}" — the model can read ahead`).not.toContain(q);
    }
  });

  it('the two fields it actually bundled are both absent', () => {
    // "Which organization are you calling from?" + "What is the best callback
    // number?" — asked 1,141ms apart with nothing in between.
    expect(prompt).not.toContain(PROMPTS.callerOrganization!);
    expect(prompt).not.toContain(PROMPTS.callbackNumber!);
  });

  it('states the one-question rule, and states it as the top rule', () => {
    expect(prompt).toMatch(/Ask ONE question/);
    expect(prompt).toMatch(/Wait for the caller to answer/i);
    expect(prompt).toMatch(/then silence/i);
    // Named explicitly, because a general "be concise" does not survive.
    expect(prompt).toMatch(/Not a question plus/i);
  });

  it('tells the model where the next question comes from', () => {
    expect(prompt).toMatch(/record_pcp_intake tells you/i);
    expect(prompt).toMatch(/You do not have the list and you do not need it/i);
  });

  it('the patient intake is still shorter, and still excludes the professional fields', () => {
    // The director owns this now; the prompt only says a patient gets a
    // shorter one and must never be asked a professional question.
    expect(PATIENT_INTAKE_ORDER.length).toBeLessThan(PROFESSIONAL_FIELDS.length);
    expect(PATIENT_INTAKE_ORDER).not.toContain('callerRole');
    expect(PATIENT_INTAKE_ORDER).not.toContain('callerOrganization');
    expect(PATIENT_INTAKE_ORDER).not.toContain('callerFacilityType');
    expect(prompt).toMatch(/no role, no organization, no facility type/i);
  });

  it('forbids acknowledging an answer the caller has not given', () => {
    /**
     * The sharpest symptom, from CA66344af6 on 08-17 — the agent asked for a
     * date of birth and then, 1,223ms later with no caller turn, said "Thank
     * you for confirming that." The operator: "It asks me a question and
     * follows up with thanks. I haven't even gotten a chance to utter a word."
     *
     * A generic "be concise" does not reach this. The behaviour has to be
     * named, along with the specific words it hides behind.
     */
    expect(prompt).toMatch(/NEVER THANK SOMEONE FOR AN ANSWER THEY HAVE NOT GIVEN/);
    for (const word of ['Thanks', 'Great', 'Got it', 'Perfect', 'Understood']) {
      expect(prompt, `the prompt should name "${word}" as a reply, not an opener`).toContain(word);
    }
    expect(prompt).toMatch(/Your turn ends the moment the question mark lands/i);
  });

  it('tells it that a one-word answer IS the purpose', () => {
    // Measured over 364 PCP calls on 08-06/07: openings are terse —
    // "Referrals." "Authorization." "Appointments." Asking them to elaborate
    // is another question they did not need.
    expect(prompt).toMatch(/Callers here are brief/i);
    expect(prompt).toMatch(/Do not ask them to elaborate/i);
  });

  /**
   * A value the director will accept for each field, so a walk can answer one
   * question and move to the next. `callerFacilityType` and `callPurpose` are
   * closed enums; the rest are free text.
   */
  const answerFor = (field: string): Record<string, unknown> => {
    if (field === 'callPurpose') return { callPurpose: 'peer_to_peer' };
    if (field === 'callerFacilityType') return { callerFacilityType: 'pcp_office' };
    return { [field]: 'provided' };
  };

  /**
   * Walking the WHOLE list, rather than checking index 0 and 1, is what makes
   * this survive the next reorder: it asserts the director and the rendered
   * script agree on the sequence, not on two particular positions. The old
   * version of this test passed on the order that put callPurpose last, which
   * is the order that refused 88% of handoffs.
   */
  it('asks a professional for the whole list, in the rendered order', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    for (const field of PROFESSIONAL_FIELDS) {
      expect(d.next('pro1').nextQuestion?.field, `expected ${field} next`).toBe(field);
      d.update('pro1', answerFor(String(field)));
    }
  });

  it('asks the purpose FIRST, and it is what switches a caller to the patient list', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    // Nothing known yet: the very first question on this line is the purpose.
    expect(d.next('p1').nextQuestion?.field).toBe('callPurpose');
    expect(PROFESSIONAL_FIELDS[0]).toBe('callPurpose');
    expect(PATIENT_INTAKE_ORDER[0]).toBe('callPurpose');

    // Answering it as a patient must switch lists immediately — before a role,
    // an organization or a facility type is ever asked for. That ordering is
    // the whole reason bd89b226 was asked "What is your role at Optum Clinic?"
    d.update('p1', { callPurpose: 'patient_caller' });
    for (const field of PATIENT_INTAKE_ORDER.slice(1)) {
      expect(d.next('p1').nextQuestion?.field, `expected ${field} next`).toBe(field);
      d.update('p1', answerFor(String(field)));
    }
    expect(d.next('p1').nextQuestion, 'patient intake should be complete').toBeUndefined();
  });

  it('never asks a patient a professional question', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('p2', { callPurpose: 'patient_caller' });
    const asked: string[] = [];
    for (let i = 0; i < 10; i++) {
      const field = d.next('p2').nextQuestion?.field;
      if (!field) break;
      asked.push(String(field));
      d.update('p2', answerFor(String(field)));
    }
    for (const professionalOnly of ['callerRole', 'callerOrganization', 'callerFacilityType']) {
      expect(asked, `a patient was asked ${professionalOnly}`).not.toContain(professionalOnly);
    }
  });
});

describe('the rules that stop the sequence being improvised', () => {
  it('says one question at a time, and forbids the follow-on sentence', () => {
    expect(prompt).toMatch(/Ask ONE question/i);
    // "Never bundle two" was not enough — the model did not bundle, it added a
    // SECOND turn. The rule has to name that shape.
    expect(prompt).toMatch(/about to add another sentence after a question/i);
  });

  it('forbids re-asking something already answered', () => {
    // The single loudest complaint on the call.
    expect(prompt).toMatch(/Asking for what you were just told/i);
  });

  it('tells it to skip a step the caller already volunteered', () => {
    // "Dr. Chen's office in Riverside" is a name AND an organisation, offered
    // before anything was asked.
    expect(prompt).toMatch(/already given you something before you asked/i);
  });

  it('names record_pcp_intake as the authority on what is missing', () => {
    expect(prompt).toMatch(/record_pcp_intake tells you/i);
    expect(prompt).toMatch(/it names ONE missing field/i);
  });
});

describe('the order lives in exactly one place', () => {
  /**
   * It used to live in two — the director AND the rendered prompt — and the
   * test here checked they matched. Now the prompt has no order at all, so
   * there is nothing to drift. What must hold is that every field the director
   * can ask still HAS wording, because the director speaks it via nextQuestion.
   */
  it('every director field has a prompt sentence to ask it with', () => {
    for (const f of PROFESSIONAL_FIELDS) {
      expect(PROMPTS[f], `PROMPTS has no wording for ${String(f)}`).toBeTruthy();
    }
    for (const f of PATIENT_INTAKE_ORDER) {
      expect(PROMPTS[f], `PROMPTS has no wording for ${String(f)}`).toBeTruthy();
    }
  });

  it('and none of that wording leaks into the prompt', () => {
    // The inverse of the old assertion, and the whole point of this change.
    const leaked = [...PROFESSIONAL_FIELDS, ...PATIENT_INTAKE_ORDER]
      .map((f) => PROMPTS[f])
      .filter((q): q is string => Boolean(q))
      .filter((q) => prompt.includes(q));
    expect(leaked, `these questions are visible to the model: ${leaked.join(' | ')}`).toEqual([]);
  });
});
