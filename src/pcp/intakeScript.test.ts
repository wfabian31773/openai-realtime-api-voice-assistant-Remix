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

  it('matches what the director actually asks a patient first', () => {
    // The rendered list is worthless if the director asks something else.
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('p1', { callPurpose: 'patient_caller' });
    expect(d.next('p1').nextQuestion?.field).toBe(PATIENT_INTAKE_ORDER[0]);

    d.update('p1', { callerName: 'Wayne Fabian' });
    expect(d.next('p1').nextQuestion?.field).toBe(PATIENT_INTAKE_ORDER[1]);
  });

  it('matches what the director asks a professional first', () => {
    const d = new PcpDirector({ lunchClosure: () => false });
    d.update('pro1', {});
    expect(d.next('pro1').nextQuestion?.field).toBe(PROFESSIONAL_FIELDS[0]);

    d.update('pro1', { callerName: 'Dr Chen office' });
    expect(d.next('pro1').nextQuestion?.field).toBe(PROFESSIONAL_FIELDS[1]);
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
