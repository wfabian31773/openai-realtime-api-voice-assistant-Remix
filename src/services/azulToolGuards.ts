/**
 * LOCAL GATES in front of two Eye Care refusals that cost live calls.
 *
 * Same principle as guardIdentityArgs, which this follows deliberately: when the
 * refusal is predictable from state we already hold, answer it HERE. A round trip
 * to be told "no" costs the caller ~2s of silence, and the model's response to a
 * bare error is to send the same call again.
 *
 * Pure functions on purpose — the agent does the timeline/session lookups and
 * passes the answers in, so the policy is testable without a database.
 */

/** A refusal shaped like the service's own, plus what to do about it. */
export interface LocalRefusal {
  error: string;
  decision: 'blocked_locally';
  agent_instruction: string;
}

export function refusalJson(tool: string, r: LocalRefusal): string {
  return JSON.stringify({ tool, result: { ok: false, ...r } });
}

/**
 * `appointment_reference_unknown` — 15 blocked calls, 07-27 to 08-03.
 *
 * sage_reschedule, sage_confirm_appointment, get_appointment_details and
 * cancel_appointment all resolve their target from an ordinal in the
 * get_patient_appointments list for THIS call. When that list was never fetched,
 * came back empty, or the ordinal is outside it, the server refuses — and the
 * model retried: sage_reschedule burned 34 invocations across 9 calls.
 *
 * `count` is the appointmentCount from the most recent successful
 * get_patient_appointments on this call, or null if there wasn't one.
 */
export function checkAppointmentOrdinal(
  count: number | null,
  ordinal: unknown,
): LocalRefusal | null {
  if (count === null) {
    return {
      error: 'appointment_reference_unknown',
      decision: 'blocked_locally',
      agent_instruction:
        "You have not looked up this caller's appointments on this call, so there is no " +
        'appointment NUMBER to act on. Call get_patient_appointments first, read the list back ' +
        'to the caller, and use the number they choose. Do not call this tool again until you ' +
        'have done that.',
    };
  }
  if (count === 0) {
    return {
      error: 'appointment_reference_unknown',
      decision: 'blocked_locally',
      agent_instruction:
        'This caller has NO appointments on file, so there is nothing to act on. Do not retry. ' +
        'Tell them you do not see an appointment under their name, and either book a new one or ' +
        'hand off with sage_handoff (patient_identity_uncertain) if they insist one exists — a ' +
        'missing appointment usually means a spelling difference or a different record.',
    };
  }
  const n = typeof ordinal === 'number' ? ordinal : Number(ordinal);
  if (!Number.isInteger(n) || n < 1 || n > count) {
    return {
      error: 'appointment_reference_unknown',
      decision: 'blocked_locally',
      agent_instruction:
        `Appointment number ${String(ordinal)} does not exist. The caller's list on this call has ` +
        `${count} appointment${count === 1 ? '' : 's'}, numbered 1 to ${count}. Use one of those ` +
        'numbers. If you are unsure which the caller means, read the list back and ask.',
    };
  }
  return null;
}

/**
 * `identity_required` on sage_handoff — 24 refusals, 07-24 to 08-03, every one a
 * caller who had asked for a person and got silence.
 *
 * The catch-22 that made it stick: `patient_identity_uncertain` is the reason you
 * use precisely BECAUSE identity could not be established, and it was refused for
 * want of identity. Call 2a602292 sent it three times and was refused three
 * times; on 07-27 one call fired seven refused handoffs in 34 seconds.
 *
 * Retrying an identical anonymous packet cannot succeed — the gate is server-side
 * and nothing about the call has changed. So after the first refusal, stop and
 * tell the model what would actually change the outcome.
 */
export function checkHandoffIdentity(args: {
  verified: boolean;
  /** A name to put in the packet, from any source (arg or the caller's own
   *  earlier attempt). Empty/undefined means the packet is anonymous. */
  name?: string | null;
  /** identity_required refusals already seen on this call. */
  priorRefusals: number;
}): LocalRefusal | null {
  const hasName = !!(args.name && String(args.name).trim());
  if (args.verified || hasName || args.priorRefusals === 0) return null;
  return {
    error: 'identity_required',
    decision: 'blocked_locally',
    agent_instruction:
      'This handoff was already refused because nobody has been identified on this call, and ' +
      'nothing has changed since. Retrying cannot succeed. Ask the caller ONCE for their first ' +
      'and last name — "so I can tell the team who is calling" — then call sage_handoff again. ' +
      'If they refuse, say so in patientResponse and call it once more; the refusal itself is ' +
      'what the server needs.',
  };
}

/**
 * The name to put in a handoff packet.
 *
 * A VERIFIED call sends nothing: the server injects the personId from its own
 * session, and the param description is explicit that re-sending a name there is
 * the loop this system is being hardened against.
 *
 * An UNVERIFIED call falls back to what the caller already said this call. That
 * is not re-collecting anything — the name failed to MATCH a record, which is
 * exactly the case the patientName parameter exists for.
 */
export function handoffIdentity(args: {
  verified: boolean;
  patientName?: string | null;
  patientDob?: string | null;
  attempt?: { firstName?: string; lastName?: string; dateOfBirth?: string } | null;
}): { name?: string; dob?: string } {
  if (args.verified) {
    return {
      ...(args.patientName ? { name: args.patientName } : {}),
      ...(args.patientDob ? { dob: args.patientDob } : {}),
    };
  }
  let name = args.patientName ?? undefined;
  let dob = args.patientDob ?? undefined;
  if (!name && args.attempt) {
    const assembled = [args.attempt.firstName, args.attempt.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (assembled) name = assembled;
  }
  if (!dob && args.attempt?.dateOfBirth) dob = args.attempt.dateOfBirth;
  return { ...(name ? { name } : {}), ...(dob ? { dob } : {}) };
}
