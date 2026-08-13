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
 * Medical Records is a HOME department here, never a destination.
 *
 * Nothing redirects INTO it: "can I get a copy of my records" on the optical
 * line is a question the optician can pass along, and a records team is not a
 * place to send a call on a keyword. But records requests constantly name
 * another department's subject — "the notes from the surgery I had on 7/30",
 * "a copy of my glasses prescription" — and without a guard those would be
 * dragged off the records queue by the surgery and optical cues below.
 */
const MEDICAL_RECORDS = 16;

/**
 * What a records request sounds like. Used ONLY to keep such a request on the
 * records line, never to route one there.
 */
const RECORDS_CUES = [
  // Deliberately broad, and safe because it is CONSULTED ONLY when the call
  // arrived on the records line. On that line a document word is the default
  // reading — "the notes from the surgery she had on 7/30" is a records
  // request, not a surgery one. It is still specific enough that a genuine
  // optical request reaching this line ("my glasses broke") routes onward, as
  // the operator's ruling requires.
  'record', 'chart', 'note', 'report', 'documentation',
  'copy of', 'copies of', 'release of information',
  'expediente', 'historial', 'copia', 'copias', 'informe',
];

/**
 * Appointment scheduling, which the operator routed to the HVA Hub from every
 * queue. Type 32 is the live one: 456 reschedules, 198 new, 55 same-day in 90
 * days. Type 40 carries the same four concepts and is effectively dead at 9.
 *
 * SPANISH IS NOT A TRANSLATION OF THE ENGLISH LIST — measured 2026-08-13.
 *
 * The first version of these cues was written English-first with a few Spanish
 * phrases appended, and it was wrong in a way that only the real tickets show.
 * Department 8's 274 unclassified tickets are overwhelmingly Spanish appointment
 * requests, and **10 of a 17-line sample missed every cue.**
 *
 * Two reasons, both structural rather than vocabulary:
 *
 *   NOMINALISATION. Ticket text says "Reprogramación de cita" and "Cancelación
 *   de la cita", not "reprogramar" and "cancelar mi cita". Spanish states these
 *   as nouns far more often than English does, so a cue built from the verb
 *   misses the common form. The cues below are stems — `reprogram` catches
 *   reprogramar, reprogramación and reprogramacion together.
 *
 *   ACCENTS. "Cancelación" and "cancelacion" both appear, because transcription
 *   and staff typing do not agree. Rather than doubling every entry, `hit()`
 *   strips diacritics from both sides, so a cue may be written either way.
 */
export interface SchedulingCue { reasonId: number; reason: string; cues: string[] }

/**
 * Exported so department 9's own taxonomy uses the SAME table rather than a
 * copy of it. The Spanish work above was hard-won against real ticket text; a
 * second list would start out identical and drift the first time either is
 * touched.
 */
export const SCHEDULING: SchedulingCue[] = [
  { reasonId: 151, reason: 'Same-Day Appointment Request',
    cues: ['same day', 'same-day', 'today if', 'get in today', 'seen today', 'squeeze me in', 'sooner appointment', 'earlier appointment', 'move my appointment up', 'cita para hoy', 'hoy mismo'] },
  { reasonId: 148, reason: 'Cancel Appointment',
    cues: ['cancel my appointment', 'cancel my appt', 'cancel the appointment', 'cannot make my appointment', "can't make my appointment",
           'cancelar mi cita', 'cancelar la cita', 'cancelar cita', 'cancelación de la cita', 'cancelación de cita', 'cancelar su cita'] },
  { reasonId: 147, reason: 'Reschedule Existing Appointment',
    cues: ['reschedule', 'change my appointment', 'move my appointment', 'different day for my appointment',
           'reprogram', 'cambiar mi cita', 'cambiar la cita', 'mover mi cita', 'mover la cita'] },
  { reasonId: 149, reason: 'Appointment Confirmation Call',
    cues: ['confirm my appointment', 'confirming my appointment', 'is my appointment', 'what time is my appointment',
           'confirmar mi cita', 'confirmar la cita', 'confirmar cita', 'confirmación de la cita', 'confirmación de cita', 'confirmar si tiene', 'confirmar si tengo'] },
  // NOT "cualquier horario disponible". That is a caller saying they are
  // flexible while BOOKING — "Solicita agendar cita para cualquier horario
  // disponible" is a new appointment, and cueing 150 on it took the request
  // off 146. An availability inquiry asks what exists; it does not ask for one.
  { reasonId: 150, reason: 'Appointment Availability Inquiry',
    cues: ['do you have any openings', 'what times do you have', 'next available', 'availability',
           'tienen disponibilidad', 'hay disponibilidad', 'qué horarios tienen', 'que horarios hay'] },
  { reasonId: 146, reason: 'New Appointment Request',
    cues: ['make an appointment', 'schedule an appointment', 'schedule an eye exam', 'book an appointment', 'set up an appointment', 'set-up a', 'need an appointment', 'get an appointment', 'new patient exam', 'new patient appointment', 'eye exam',
           // Named exam types. "Request to schedule regular check-up" is a real
           // department 9 ticket that matched nothing here. Hyphenated and
           // joined forms only — a bare "check up" would take "check up on my
           // glasses" off the optical line.
           'check-up', 'checkup', 'annual exam', 'yearly exam', 'routine exam', 'vision exam', 'dilated exam',
           'hacer una cita', 'sacar una cita', 'pedir una cita', 'agendar', 'solicitud de cita', 'solicitud de nueva cita', 'solicita una cita', 'solicita cita', 'nueva cita', 'cita nueva', 'cita para', 'quiere una cita', 'necesita una cita', 'desea una cita',
           'examen de la vista', 'examen de ojos', 'revision general', 'revisión general'] },
];

/**
 * Sub-specialties the practice actually schedules separately. A caller naming
 * one of these is not asking for a routine exam.
 */
export const SPECIALIST_CUES = [
  'cornea specialist', 'retina specialist', 'glaucoma specialist',
  'oculoplastic', 'oculoplastics', 'neuro-ophthalm', 'neuro ophthalm',
  'pediatric optometrist', 'pediatric ophthalm', 'peds',
  'see a specialist', 'specialist consult', 'specialist appointment',
  'referral appointment', 'referred to', 'was referred', 'referral from my',
  'cataract consult', 'cataract evaluation', 'consult for my cataract',
  'low vision', 'uveitis',
  'especialista', 'consulta con especialista',
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

/**
 * Lowercase and strip diacritics, so "Cancelación" and "cancelacion" are the
 * same word to a cue. Both sides go through it, which is what lets a cue be
 * written in whichever form reads better.
 */
export function fold(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Is this scheduling request for a named sub-specialty?
 *
 * The cue list lives HERE rather than in `hubTaxonomy`, even though 152 is a
 * department 9 reason, because hubTaxonomy already imports from this file and
 * the reverse would be a cycle. Same list either way — which is the point: a
 * request routed from another queue gets the same reason as one classified
 * directly.
 */
function specialistReferral(foldedText: string): boolean {
  return SPECIALIST_CUES.some((c) => foldedText.includes(fold(c)));
}

/** `text` is already folded by the caller; cues are folded here. */
function hit(text: string, cues: string[]): boolean {
  return cues.some((c) => text.includes(fold(c)));
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
  const t = fold(text);
  if (!t.trim()) return null;

  const mentionsSurgery = hit(t, SURGERY_CUES);
  const mentionsOptical = hit(t, OPTICAL_CUES);
  const mentionsMedication = hit(t, TECH_CUES);
  // Only an unambiguous drug signal keeps a call on the medication line against
  // a clear signal from elsewhere. See TECH_CUES_STRONG.
  const mentionsMedicationClearly = hit(t, TECH_CUES_STRONG);

  /**
   * A records request on the records line stays there, whatever else it names.
   *
   * "The notes from the surgery she had on 7/30, the PCP has not got the
   * report" is a real department 16 ticket. Every subject-matter rule below
   * would pull it into Surgery on the words "the surgery", and the records team
   * would never see it. Same for "a copy of my glasses prescription".
   *
   * Scheduling is deliberately NOT covered by this guard — the operator's
   * ruling is that schedule-related requests go to the Hub from every queue,
   * and a records line is one of them.
   */
  const holdsOnRecordsLine = homeDepartmentId === MEDICAL_RECORDS && hit(t, RECORDS_CUES);

  // 1. Appointments -> HVA Hub, from anywhere, unless it is a surgery date.
  //
  // THIS REPLACES A MANUAL MOVE. Operator, 2026-08-13: "we don't have a queue
  // for the HVA hub... those have been landing [in other queues], and then
  // they've been moving over manually into the HVA hub for our scheduling team
  // to address." Nobody answers a department 9 number; this is the handoff
  // between the queue that took the call and the team that works it, so the
  // reason has to be right or the scheduling team gets an undifferentiated pile
  // instead of a sorted queue.
  if (!mentionsSurgery) {
    for (const s of SCHEDULING) {
      if (hit(t, s.cues)) {
        if (homeDepartmentId === HVA_HUB) return null;
        // A named sub-specialty is a different scheduling problem from a
        // routine exam — different provider list, different slot length, often
        // a referral to chase first. Department 9 has reason 152 for it and it
        // has been used ONCE in 90 days, so it is asked BEFORE the six ordinary
        // appointment reasons rather than after.
        const specialist = specialistReferral(t);
        return {
          departmentId: HVA_HUB,
          departmentName: 'HVA Hub',
          requestTypeId: 32,
          requestReasonId: specialist ? 152 : s.reasonId,
          requestReason: specialist ? 'Specialist Referral Appointment' : s.reason,
          note: 'Scheduling request — taken on another line and routed here.',
        };
      }
    }
  }

  // 2. Optical, when it is about eyewear and NOT about this queue's own subject.
  if (
    homeDepartmentId !== OPTICAL &&
    mentionsOptical &&
    !holdsOnRecordsLine &&
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
    !holdsOnRecordsLine &&
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
  if (
    homeDepartmentId !== TECH &&
    mentionsMedication &&
    !holdsOnRecordsLine &&
    !mentionsSurgery &&
    !mentionsOptical
  ) {
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
