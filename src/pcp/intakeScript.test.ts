/**
 * THE PROMPT AND THE DIRECTOR MUST ASK THE SAME QUESTIONS, IN THE SAME ORDER.
 *
 * Operator, 2026-08-14, after a live call: *"we should have maybe in the prompt
 * ask these questions in order and get a response and record them in order...
 * if it's a PCP you ask these questions, if it's a patient you do this, because
 * this shit sounds crazy."*
 *
 * He was right, and the cause was structural rather than a bad model. The
 * prompt said "ask only the single next question record_pcp_intake gives you"
 * and never showed it WHAT the order was. So the model invented a sequence and
 * the director corrected it a turn later — and the caller heard both:
 *
 *   agent   "May I have your name, please?"
 *   caller  "Yeah, it's Wayne Fabian."
 *   agent   "Thank you, Wayne. What is your role?"
 *   agent   "Of course — may I have your name and the office or medical group
 *            you're calling from?"
 *   caller  "he just asked me my name. I gave it to you. Now you ask me my name
 *            again and the medical group. Like this shit is all off."
 *
 * The script is now generated from the director's own PROFESSIONAL_FIELDS /
 * PATIENT_INTAKE_ORDER and PROMPTS. These tests exist so it stays generated: a
 * hand-copied list in a prompt is a copy, and copies drift.
 */
import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const { buildPcpPrompt } = await import('../agents/pcpAgent');
const { PROFESSIONAL_FIELDS, PATIENT_INTAKE_ORDER, PROMPTS, PcpDirector } = await import('./director');

const prompt = buildPcpPrompt({ callerPhone: '+18455317471' } as never);

describe('every question the director can ask appears in the prompt', () => {
  it('lists the professional intake in the director\'s order', () => {
    const asked = PROFESSIONAL_FIELDS.map((f) => PROMPTS[f]!);
    for (const q of asked) expect(prompt, `missing: ${q}`).toContain(q);

    // Order, not just presence — the sequencing was the complaint.
    const positions = asked.map((q) => prompt.indexOf(q));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('lists the patient intake, and it is SHORTER', () => {
    for (const f of PATIENT_INTAKE_ORDER) {
      expect(prompt, `missing patient question: ${f}`).toContain(PROMPTS[f]!);
    }
    // "What type of healthcare organization is that?" is not a question a
    // person ringing about their own eye drops can answer.
    expect(PATIENT_INTAKE_ORDER.length).toBeLessThan(PROFESSIONAL_FIELDS.length);
    expect(PATIENT_INTAKE_ORDER).not.toContain('callerRole');
    expect(PATIENT_INTAKE_ORDER).not.toContain('callerOrganization');
    expect(PATIENT_INTAKE_ORDER).not.toContain('callerFacilityType');
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
  it('says one question at a time, and never bundled', () => {
    expect(prompt).toMatch(/Ask ONE question/i);
    expect(prompt).toMatch(/Never bundle two/i);
  });

  it('forbids re-asking something already answered', () => {
    // The single loudest complaint on the call.
    expect(prompt).toMatch(/NEVER re-ask something the\s*caller has already answered/i);
  });

  it('tells it to skip a step the caller already volunteered', () => {
    // "Dr. Chen's office in Riverside" is a name AND an organisation, offered
    // before anything was asked.
    expect(prompt).toMatch(/already given you something before you asked/i);
  });

  it('names record_pcp_intake as the authority on what is missing', () => {
    expect(prompt).toMatch(/record_pcp_intake tells you which field is still missing/i);
  });
});

describe('the script is generated, not copied', () => {
  it('renders a field added to the director without touching the prompt', () => {
    // Every professional question in the prompt comes from PROMPTS. If someone
    // hand-writes a list later, this catches the copy the moment it diverges.
    for (const f of PROFESSIONAL_FIELDS) {
      const q = PROMPTS[f];
      expect(q, `PROMPTS has no wording for ${String(f)}`).toBeTruthy();
      expect(prompt).toContain(q!);
    }
  });
});
