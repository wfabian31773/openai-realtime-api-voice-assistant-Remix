/**
 * A caller who pressed the wrong option is not the caller's problem.
 *
 * OPERATOR RULING, 2026-08-13:
 *
 *   "These are specific queues that are being forwarded. But if someone calls
 *    and they press two for medication refill, and it's an optical question, we
 *    can't just tell the patient call back, call the wrong extension. We have to
 *    have a process where it goes to the appropriate department, which in this
 *    case obviously is optical. And anything that's schedule related that comes
 *    through any of these should go to the HVA hub."
 *
 * Each queue agent knows its own subject because of the line that rang. That is
 * what keeps its prompt small, and it is right almost all of the time — but
 * "almost all" over 9,288 tickets a quarter is a lot of patients told to hang up
 * and dial again. Department 3's own data already shows it: "assistance with
 * eyeglass prescription selection" and "request to schedule an eye exam" are
 * sitting in the medication queue today.
 *
 * So a queue tool files into ITS OWN department unless the caller's words
 * clearly belong to another one, and then it files there instead. The patient is
 * never asked to call back, and the receiving team gets a ticket that says how
 * it arrived.
 *
 * WHAT THIS IS NOT
 *
 * It is not a general classifier and it must not become one. Its job is to catch
 * the OBVIOUS misroute — glasses on the medication line, an appointment request
 * on any line — and to stay silent otherwise, because the line that rang is
 * better evidence than a keyword. When it is unsure it returns null and the
 * home queue keeps the call.
 */

export interface QueueRedirect {
  departmentId: number;
  departmentName: string;
  requestTypeId: number;
  requestReasonId: number;
  requestReason: string;
  /** One line for the description, so the receiving team knows how it arrived. */
  note: string;
}

/** Departments a queue call can legitimately be redirected into. */
const OPTICAL = 1;
const SURGERY = 2;
const TECH = 3;
const HVA_HUB = 9;

/**
 * Appointment scheduling, which the operator routed to the HVA Hub from every
 * queue. Type 32 is the live one: 456 reschedules, 198 new, 55 same-day in 90
 * days. Type 40 carries the same four concepts and is effectively dead at 7.
 */
const SCHEDULING: Array<{ reasonId: number; reason: string; cues: string[] }> = [
  { reasonId: 151, reason: 'Same-Day Appointment Request',
    cues: ['same day', 'same-day', 'today if', 'get in today', 'seen today', 'squeeze me in', 'sooner appointment', 'earlier appointment', 'move my appointment up'] },
  { reasonId: 148, reason: 'Cancel Appointment',
    cues: ['cancel my appointment', 'cancel my appt', 'cancel the appointment', 'cancelar mi cita', 'cannot make my appointment', "can't make my appointment"] },
  { reasonId: 147, reason: 'Reschedule Existing Appointment',
    cues: ['reschedule', 'change my appointment', 'move my appointment', 'different day for my appointment', 'cambiar mi cita', 'reprogramar'] },
  { reasonId: 149, reason: 'Appointment Confirmation Call',
    cues: ['confirm my appointment', 'confirming my appointment', 'is my appointment', 'what time is my appointment', 'confirmar mi cita'] },
  { reasonId: 150, reason: 'Appointment Availability Inquiry',
    cues: ['do you have any openings', 'what times do you have', 'next available', 'availability'] },
  { reasonId: 146, reason: 'New Appointment Request',
    cues: ['make an appointment', 'schedule an appointment', 'schedule an eye exam', 'book an appointment', 'set up an appointment', 'need an appointment', 'get an appointment', 'new patient exam', 'eye exam', 'hacer una cita', 'sacar una cita', 'agendar', 'solicitud de cita', 'cita para'] },
];

/**
 * Optical, which is glasses and contacts as OBJECTS — the frames, the lenses,
 * the prescription for them, collecting them.
 *
 * Deliberately narrow. "Contact lens prescription renewal" is a Tech Support
 * reason (157) and stays there; this is about the eyewear itself.
 */
const OPTICAL_CUES = [
  'glasses', 'eyeglass', 'eye glasses', 'spectacles', 'frames', 'frame',
  'lenses ready', 'new lenses', 'bifocal', 'progressive', 'reading glasses',
  'sunglasses', 'my glasses are', 'pick up my glasses', 'lentes', 'gafas', 'armazon', 'armazón',
];

/** Surgery, when the words are unmistakably about an operation. */
const SURGERY_CUES = [
  'my surgery', 'the surgery', 'cataract surgery', 'lasik', 'surgery date',
  'surgery center', 'pre-op', 'post-op', 'operation', 'cirugía', 'cirugia',
];

/**
 * Medication, which belongs to Clinical Tech Support.
 *
 * SPLIT ON PURPOSE. "Prescription" means a drug on this line and a pair of
 * glasses on the optical one — "assistance with eyeglass prescription
 * selection" is a real department 3 ticket today, and treating that word as a
 * medication signal kept it in the medication queue.
 *
 * So the ambiguous words identify a medication call, but they do NOT hold a
 * call against a clearer signal from another queue. Only the unambiguous ones
 * do that.
 */
const TECH_CUES_STRONG = [
  'refill', 'pharmacy', 'medication', 'eye drop', 'eyedrop',
  'prior auth', 'medicamento', 'farmacia', 'gotas',
];
const TECH_CUES_AMBIGUOUS = ['prescription', 'receta', 'rx'];
const TECH_CUES = [...TECH_CUES_STRONG, ...TECH_CUES_AMBIGUOUS];

function hit(text: string, cues: string[]): boolean {
  return cues.some((c) => text.includes(c));
}

/**
 * Where this request really belongs, or null to keep it on the queue that took
 * the call.
 *
 * ORDER, and why:
 *
 *   1. SCHEDULING FIRST, from every queue — the operator's ruling — EXCEPT an
 *      operation. Asked directly, 2026-08-13: "surgery is an exception to that
 *      hva hub rule."
 *
 *      Moving a surgery date is coordinator work rather than front-desk
 *      scheduling: it drags a surgeon's block, a facility slot, pre-op
 *      measurements and a drop schedule with it, which is why department 2 has
 *      its own reason 531. The exception is the OPERATION, not the word
 *      "reschedule" — "reschedule my post-op appointment" is still Surgery's,
 *      and "reschedule my eye exam" still goes to the Hub.
 *
 *   2. Then the subject-matter queues, each only when the home queue is not
 *      already the right one.
 *
 * A request that mentions BOTH its home subject and another one stays home.
 * "Refill the drops for my cataract surgery" is a medication request on the
 * medication line, not a surgery redirect — so a redirect requires the other
 * queue's language WITHOUT the home queue's.
 */
export function detectCrossQueue(text: string, homeDepartmentId: number): QueueRedirect | null {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;

  const mentionsSurgery = hit(t, SURGERY_CUES);
  const mentionsOptical = hit(t, OPTICAL_CUES);
  const mentionsMedication = hit(t, TECH_CUES);
  // Only an unambiguous drug signal keeps a call on the medication line against
  // a clear signal from elsewhere. See TECH_CUES_STRONG.
  const mentionsMedicationClearly = hit(t, TECH_CUES_STRONG);

  // 1. Appointments -> HVA Hub, from anywhere, unless it is a surgery date.
  if (!mentionsSurgery) {
    for (const s of SCHEDULING) {
      if (hit(t, s.cues)) {
        if (homeDepartmentId === HVA_HUB) return null;
        return {
          departmentId: HVA_HUB,
          departmentName: 'HVA Hub',
          requestTypeId: 32,
          requestReasonId: s.reasonId,
          requestReason: s.reason,
          note: 'Scheduling request — taken on another line and routed here.',
        };
      }
    }
  }

  // 2. Optical, when it is about eyewear and NOT about this queue's own subject.
  if (
    homeDepartmentId !== OPTICAL &&
    mentionsOptical &&
    !(homeDepartmentId === TECH && mentionsMedicationClearly) &&
    !(homeDepartmentId === SURGERY && mentionsSurgery)
  ) {
    return {
      departmentId: OPTICAL,
      departmentName: 'Optical Support',
      // "General / Other" for department 1 — the receiving optician reads the
      // description. Guessing at one of the eighteen optical reasons from a
      // sentence taken on a different line would be the same mistake this whole
      // effort exists to undo.
      requestTypeId: 66,
      requestReasonId: 536,
      requestReason: 'Other - See Description',
      note: 'Optical request — taken on another line and routed here.',
    };
  }

  // 3. Surgery, when it is unmistakably about an operation.
  if (
    homeDepartmentId !== SURGERY &&
    mentionsSurgery &&
    !(homeDepartmentId === TECH && mentionsMedicationClearly)
  ) {
    return {
      departmentId: SURGERY,
      departmentName: 'Surgery Coordination',
      requestTypeId: 65,
      requestReasonId: 535,
      requestReason: 'Other - See Description',
      note: 'Surgery request — taken on another line and routed here.',
    };
  }

  // 4. Medication, when it is unmistakably a prescription matter.
  if (homeDepartmentId !== TECH && mentionsMedication && !mentionsSurgery && !mentionsOptical) {
    return {
      departmentId: TECH,
      departmentName: 'Clinical Tech Support',
      requestTypeId: 72,
      requestReasonId: 542,
      requestReason: 'Other - See Description',
      note: 'Medication request — taken on another line and routed here.',
    };
  }

  return null;
}
