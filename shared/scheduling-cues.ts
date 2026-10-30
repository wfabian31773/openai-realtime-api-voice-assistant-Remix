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
 * Shared by the queue router, department 9 taxonomy and records-line intent
 * classifier. The Spanish work above was hard-won against real ticket text; a
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
    cues: ['make an appointment', 'schedule an appointment', 'schedule my appointment', 'appointment scheduling', 'schedule an eye exam', 'book an appointment', 'set up an appointment', 'set-up a', 'need an appointment', 'get an appointment', 'new patient exam', 'new patient appointment', 'eye exam',
           // Named exam types. "Request to schedule regular check-up" is a real
           // department 9 ticket that matched nothing here. Hyphenated and
           // joined forms only — a bare "check up" would take "check up on my
           // glasses" off the optical line.
           'check-up', 'checkup', 'annual exam', 'yearly exam', 'routine exam', 'vision exam', 'dilated exam',
           'hacer una cita', 'sacar una cita', 'pedir una cita', 'agendar', 'solicitud de cita', 'solicitud de nueva cita', 'solicita una cita', 'solicita cita', 'nueva cita', 'cita nueva', 'cita para', 'quiere una cita', 'necesita una cita', 'desea una cita',
           'examen de la vista', 'examen de ojos', 'revision general', 'revisión general'] },
];

