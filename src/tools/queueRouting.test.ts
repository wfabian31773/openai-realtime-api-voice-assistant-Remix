/**
 * Nobody gets told to call back.
 *
 * Operator ruling 2026-08-13: these queues are forwarded, so a patient who
 * pressed the medication option with an optical question must not be sent away
 * to dial again. Scheduling goes to the HVA Hub from every queue.
 *
 * The opposite failure matters just as much. A detector that fires on a keyword
 * would take a medication call OFF the medication line because the caller
 * mentioned their surgery, and the line that rang is better evidence than a
 * word. Half of these tests are about staying silent.
 */
import { describe, it, expect } from 'vitest';
import { detectCrossQueue } from './queueRouting';

const OPTICAL = 1;
const SURGERY = 2;
const TECH = 3;
const HVA = 9;

describe('scheduling goes to the HVA Hub from every queue', () => {
  const lines: Array<[number, string]> = [
    [TECH, 'I need to schedule an eye exam'],
    [OPTICAL, 'can I make an appointment for next week'],
    [SURGERY, 'I need to reschedule my appointment'],
    [TECH, 'cancel my appointment please'],
    [OPTICAL, 'do you have any openings sooner'],
    [TECH, 'quiero hacer una cita'],
  ];

  for (const [home, text] of lines) {
    it(`from department ${home}: "${text.slice(0, 40)}…"`, () => {
      const r = detectCrossQueue(text, home);
      expect(r?.departmentId, text).toBe(HVA);
      expect(r?.requestTypeId).toBe(32); // Appointment Request — the live type
    });
  }

  it('picks the reason the words earned', () => {
    expect(detectCrossQueue('I need to reschedule my appointment', TECH)?.requestReasonId).toBe(147);
    expect(detectCrossQueue('cancel my appointment', TECH)?.requestReasonId).toBe(148);
    expect(detectCrossQueue('can I be seen today', TECH)?.requestReasonId).toBe(151);
    expect(detectCrossQueue('I need to schedule an appointment', TECH)?.requestReasonId).toBe(146);
  });

  it('does not redirect a Hub call to the Hub', () => {
    expect(detectCrossQueue('I need to reschedule my appointment', HVA)).toBeNull();
  });

  // SURGERY IS THE EXCEPTION TO THE HUB RULE. Operator, 2026-08-13, asked
  // directly: "surgery is an exception to that hva hub rule."
  //
  // Everything schedule-related goes to the Hub except an operation. Moving a
  // surgery date is coordinator work — it drags a surgeon's block, a facility
  // slot, pre-op measurements and drops with it — which is why department 2 has
  // its own reason 531, Reschedule / Cancel Surgery.
  describe('surgery is the exception', () => {
    it('keeps a surgery date change with Surgery, from every queue', () => {
      for (const home of [SURGERY, TECH, OPTICAL]) {
        const r = detectCrossQueue('I need to reschedule my surgery', home);
        expect(r?.departmentId ?? SURGERY, `from department ${home}`).toBe(SURGERY);
      }
    });

    it('keeps a surgery cancellation with Surgery', () => {
      expect(detectCrossQueue('please cancel my surgery on the 10th', SURGERY)).toBeNull();
      expect(detectCrossQueue('cancel my cataract surgery', TECH)?.departmentId).toBe(SURGERY);
    });

    it('still sends an ordinary appointment to the Hub', () => {
      // The exception is the OPERATION, not the word "reschedule".
      expect(detectCrossQueue('reschedule my post-op appointment', SURGERY)).toBeNull();
      expect(detectCrossQueue('reschedule my eye exam', TECH)?.departmentId).toBe(HVA);
    });
  });
});

/**
 * Real Spanish ticket text, taken verbatim from department 8's unclassified
 * tickets on 2026-08-13. Ten of these seventeen missed every cue in the first
 * version of the list — it was written English-first, and Spanish states these
 * requests as nouns ("Reprogramación de cita") far more often than English does.
 *
 * These are the actual sentences, accents and all, because that is the only way
 * to know the cues match what people really write rather than what I imagined
 * they would.
 */
describe('Spanish appointment requests reach the Hub', () => {
  const AFTER_HOURS = 8;
  const real: Array<[string, number]> = [
    ['Paciente nuevo desea agendar cita nueva por la tarde', 146],
    ['Solicita agendar cita para cualquier horario disponible', 146],
    ['Solicitud de nueva cita tras pérdida de cita anterior', 146],
    ['Solicita una nueva cita por la tarde, de lunes o viernes', 146],
    ['Solicitud de cita para examen de la vista', 146],
    ['Solicita una cita nueva con el oculista, con preferencia para un sábado', 146],
    ['Nueva paciente quiere agendar cita con un doctor de los ojos', 146],
    ['Solicitud de cita para revisión general', 146],
    ['Solicita cita para examen de ojos', 146],
    ['Quiere reprogramar su cita a partir del 7 de septiembre', 147],
    ['Solicitud de reprogramación de cita', 147],
    ['Reprogramación de cita', 147],
    ['Cancelación de la cita programada para hoy a las 10:10 de la mañana', 148],
    ['Cancelar cita del 5 de agosto de 2026', 148],
    ['Confirmación de la cita de hoy, ya que el paciente cree que fue cancelada', 149],
    ['Paciente necesita confirmar si tiene una cita hoy en la oficina de San Bernardino', 149],
  ];

  for (const [text, reasonId] of real) {
    it(`"${text.slice(0, 44)}…" -> ${reasonId}`, () => {
      const r = detectCrossQueue(text, AFTER_HOURS);
      expect(r?.departmentId, text).toBe(HVA);
      expect(r?.requestTypeId).toBe(32);
      expect(r?.requestReasonId, text).toBe(reasonId);
    });
  }

  it('matches with or without accents', () => {
    // Transcription and staff typing do not agree on these, so both appear in
    // the real data. fold() strips diacritics from both sides.
    expect(detectCrossQueue('Reprogramacion de cita', AFTER_HOURS)?.requestReasonId).toBe(147);
    expect(detectCrossQueue('Cancelacion de la cita', AFTER_HOURS)?.requestReasonId).toBe(148);
    expect(detectCrossQueue('Confirmacion de la cita', AFTER_HOURS)?.requestReasonId).toBe(149);
  });

  it('still says nothing about a Spanish request that is not scheduling', () => {
    // The point of the wider net is appointments, not "any sentence with a
    // Spanish word in it". A refill stays a refill.
    expect(detectCrossQueue('Necesita un resurtido de su medicamento', TECH)).toBeNull();
    expect(detectCrossQueue('Sus lentes están listos para recoger', OPTICAL)).toBeNull();
  });
});

describe('the operator\'s example: optical question on the medication line', () => {
  it('routes glasses from Tech Support to Optical', () => {
    const r = detectCrossQueue('my glasses broke at the hinge', TECH);
    expect(r?.departmentId).toBe(OPTICAL);
    expect(r?.requestTypeId).toBe(66);
    expect(r?.requestReasonId).toBe(536);
    expect(r?.note).toMatch(/routed here/i);
  });

  it('routes frames from Surgery to Optical', () => {
    expect(detectCrossQueue('I want to pick out new frames', SURGERY)?.departmentId).toBe(OPTICAL);
  });

  it('does not route an optical call away from Optical', () => {
    expect(detectCrossQueue('my glasses broke', OPTICAL)).toBeNull();
  });
});

describe('it stays silent when the line that rang is already right', () => {
  it('keeps a medication call on the medication line', () => {
    expect(detectCrossQueue('I need a refill of my Latanoprost', TECH)).toBeNull();
    expect(detectCrossQueue('my pharmacy never got the prescription', TECH)).toBeNull();
  });

  it('keeps post-surgery drops on the medication line', () => {
    // Mentions a surgery, but it is a prescription request and it arrived on
    // the prescription line. A keyword-happy detector would move it.
    expect(detectCrossQueue('refill the drops for my cataract surgery', TECH)).toBeNull();
  });

  it('keeps a surgery logistics call with Surgery', () => {
    expect(detectCrossQueue('my surgery is Monday and the drops never came', SURGERY)).toBeNull();
    expect(detectCrossQueue('what time should I arrive for my surgery', SURGERY)).toBeNull();
  });

  it('keeps a contact lens PRESCRIPTION with Tech Support', () => {
    // 157 is a Tech Support reason. The eyewear itself is Optical; the
    // prescription for it is not.
    expect(detectCrossQueue('I need to renew my contact lens prescription', TECH)).toBeNull();
  });

  it('says nothing about an empty or unremarkable request', () => {
    expect(detectCrossQueue('', TECH)).toBeNull();
    expect(detectCrossQueue('   ', TECH)).toBeNull();
    expect(detectCrossQueue('I have a question', TECH)).toBeNull();
  });
});

describe('medication and surgery calls reaching the optical line', () => {
  it('routes a refill from Optical to Tech Support', () => {
    const r = detectCrossQueue('I need a refill on my eye drops', OPTICAL);
    expect(r?.departmentId).toBe(TECH);
    expect(r?.requestReasonId).toBe(542);
  });

  it('routes a surgery question from Optical to Surgery', () => {
    expect(detectCrossQueue('a question about my cataract surgery', OPTICAL)?.departmentId).toBe(SURGERY);
  });
});

/**
 * The shared create_ticket guard, used by the answering service, no-IVR and
 * no-IVR v2 — "cross queue routing should be for all agents".
 *
 * That guard was already auto-correcting one misroute (a medication request
 * landing on CEC Networking), so this is the same idea with a wider reach.
 */
describe('every agent that files through the shared guard is routed too', () => {
  it('routes a scheduling request off a clinical queue', () => {
    // ANSWERING_SERVICE_DEPARTMENTS is {OPTICAL, SURGERY, TECH, RESEARCH,
    // CEC_NETWORKING} — the HVA Hub is not in it, so before this an agent
    // using that map could not send an appointment request anywhere but into a
    // clinical queue. "Request to schedule an eye exam" is sitting in the
    // medication queue today because of it.
    const r = detectCrossQueue('request to schedule an eye exam', TECH);
    expect(r?.departmentId).toBe(HVA);
    expect(r?.requestTypeId).toBe(32);
    expect(r?.requestReasonId).toBe(146);
  });

  it('routes an eyeglass request off the medication queue', () => {
    // Also real, also sitting in department 3 today.
    const r = detectCrossQueue('assistance with eyeglass prescription selection', TECH);
    expect(r?.departmentId).toBe(OPTICAL);
  });

  it('leaves a deliberate, correct department choice alone', () => {
    // The answering service CHOOSES a department. When it chose right, this
    // must say nothing — a router that second-guesses a correct decision is
    // worse than no router.
    expect(detectCrossQueue('I need a refill of my Latanoprost', TECH)).toBeNull();
    expect(detectCrossQueue('my glasses broke', OPTICAL)).toBeNull();
    expect(detectCrossQueue('question about my cataract surgery', SURGERY)).toBeNull();
  });

  it('carries a note so the receiving team knows how it arrived', () => {
    const r = detectCrossQueue('I need to reschedule my appointment', TECH);
    expect(r?.note).toMatch(/scheduling request/i);
    expect(r?.note).toMatch(/another line/i);
  });
});
