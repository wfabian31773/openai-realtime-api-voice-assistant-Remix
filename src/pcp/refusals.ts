/**
 * WHAT THE AGENT DOES WHEN A GATE SAYS NO.
 *
 * Every policy guard on the PCP line returned a bare `{success:false, error:
 * '<slug>'}` and nothing else. Nothing told the model what that meant or what
 * to do about it, so it improvised — and what it improvised was a narration of
 * our internals, out loud, to a healthcare professional. From CA1de3229a
 * (2026-08-14, a referring coordinator at Dr. Chen's office):
 *
 *   "I'm sorry, but it looks like a direct handoff isn't available for this
 *    purpose."                                        <- handoff_not_eligible
 *   "I'm still here—one moment. Let me ensure the call disposition is securely
 *    recorded."                              <- durable_disposition_required
 *   "It looks like something isn't finalized yet."             <- the same, x2
 *   "Something still isn't finalized. Let me walk through the key details
 *    again."                                                  <- the same, x3
 *
 * The call ran 188 seconds and the agent said goodbye three times, because
 * terminate_call kept refusing and it had no idea why. Over the ten days to
 * 2026-08-16 these guards refused 211 of 240 handoff attempts, 33 of 85 task
 * filings and 26 of 82 terminations.
 *
 * TWO FIELDS, NOT ONE, and the distinction is load-bearing:
 *
 *   say       a sentence for the CALLER. Present only when the agent genuinely
 *             owes them words. `azulRubric` grades every `outcome.say` for
 *             verbatim delivery, so anything put here is something we have
 *             decided the caller should hear in roughly these words.
 *   guidance  an instruction to the MODEL. Never spoken.
 *
 * Putting a directive in `say` would fail that grader and, worse, invite the
 * model to read it aloud — which is not hypothetical on this system. From
 * STATE-OF-PLAY §3: an earlier attempt at mouthpiece rules in per-response
 * instructions "made it worse — the model read them to patients."
 *
 * So every `guidance` string opens by saying it is not an error and must not
 * be mentioned, the same discipline `gateBeforeExecution` in toolDirection.ts
 * already uses for the two gates it owns.
 *
 * The house rule underneath all of it: A GATE IS NOT A FAULT. Refusing a tool
 * means the agent should do something ELSE, and the something else is almost
 * always "file it with create_pcp_task" — the floor that is always permitted.
 */

interface RefusalCopy {
  /** Spoken to the caller, near-verbatim. Omitted when they are owed nothing. */
  say?: string;
  /** Read by the model only. Always present. */
  guidance: string;
}

const FILE_IT = 'file it with create_pcp_task';

export const PCP_REFUSALS: Record<string, RefusalCopy> = {
  /**
   * The one that dominated. 180 occurrences on 2026-08-07 alone.
   *
   * With `callPurpose` moved to the front of the intake (director.ts) this
   * should now be rare, but rare is not never — a model can still reach for a
   * tool before recording. The recovery has to be a question the caller does
   * not experience as a repeat.
   */
  call_purpose_required: {
    guidance:
      'NOT AN ERROR — do not apologize and do not mention anything technical. You have not recorded what this call is about yet. ' +
      'If the caller has already told you, call record_pcp_intake now with callPurpose set and do NOT ask them again. ' +
      'Only if they genuinely have not said, ask "What are you calling about today?" Then retry this tool.',
  },

  /**
   * The one that trapped a live caller for 188 seconds and produced three
   * separate "something isn't finalized" lines.
   */
  durable_disposition_required: {
    guidance:
      'NOT AN ERROR — say nothing about anything being unfinished, and do NOT say goodbye again. ' +
      'Nothing durable has been recorded for this call yet, so it cannot end. ' +
      `Call create_pcp_task with what you already have, then call terminate_call once more.`,
  },

  durable_ticket_required_before_handoff: {
    guidance:
      'NOT AN ERROR — say nothing about it. The request has to be on record before anyone is dialled. ' +
      'Call create_pcp_task now, then carry on with the call normally.',
  },

  /**
   * The transfer is off, but the request IS filed. The caller is owed a plain
   * sentence here — and specifically NOT the words the agent chose for itself,
   * which told a referring coordinator that "a direct handoff isn't available
   * for this purpose". That is our vocabulary, not theirs.
   */
  handoff_not_eligible_task_created: {
    say: "I'm not able to put you through from this line, but I've taken this down and the right team will follow up with you.",
    guidance:
      'The request is already filed — this is not a failure. Deliver the line above and continue. ' +
      'Never tell a caller that a handoff or transfer is "unavailable", "not available for this purpose", or blocked.',
  },

  /** Transfer refused AND the fallback filing failed. The only genuinely bad one. */
  handoff_not_eligible: {
    say: "I've taken this down and I'm making sure it reaches the right team.",
    guidance:
      'Say the line above, then call create_pcp_task again to get the request on record. ' +
      'Do not mention a system problem and do not promise a transfer.',
  },

  director_disposition_mismatch: {
    guidance:
      'NOT AN ERROR — say nothing. Call create_pcp_task again with disposition set to CREATE_TASK. ' +
      'Filing is always permitted; only the transfer direction was refused.',
  },

  automate_not_allowed_for_purpose: {
    guidance:
      `NOT AN ERROR — say nothing. This kind of request cannot be closed out on the call, so ${FILE_IT} instead.`,
  },

  authoritative_tool_success_required: {
    guidance:
      'NOT AN ERROR — say nothing. You have not completed an approved lookup, so you cannot record this as resolved. ' +
      `Take the request and ${FILE_IT}.`,
  },

  public_knowledge_not_allowed_for_purpose: {
    guidance:
      'NOT AN ERROR — say nothing about a lookup. There is no approved public-information source for this kind of call. ' +
      `Answer only from what you already know for certain, or ${FILE_IT}.`,
  },

  scheduling_not_allowed: {
    guidance:
      `NOT AN ERROR — say nothing about a lookup. This request is not answered from the schedule, so ${FILE_IT}.`,
  },

  no_authoritative_source: {
    guidance:
      `NOT AN ERROR — say nothing about a lookup. There is no approved source for this request, so ${FILE_IT}.`,
  },

  staff_verification_failed: {
    guidance:
      'NOT AN ERROR — do not mention verification to the caller, and never suggest they failed anything. ' +
      `You cannot read patient details out on this call. Take the request and ${FILE_IT}.`,
  },

  patient_medical_records_pathway_isolated: {
    guidance:
      'NOT AN ERROR — say nothing. A records request has its own tool: use handle_patient_medical_records_request.',
  },

  /** A real dependency failure, so the caller IS owed an explanation. */
  schedule_lookup_failed: {
    say: "I'm not able to pull that up right now, but I can take this down for the team.",
    guidance: `The lookup genuinely failed. Say the line above, then ${FILE_IT}.`,
  },

  records_tool_unavailable: {
    guidance:
      'Say nothing about an error yet. Call handle_patient_medical_records_request once more. ' +
      `If it fails again, ${FILE_IT} instead.`,
  },

  /**
   * A patient's ticket failed to file. The upstream `error` is passed through
   * for diagnosis, so this copy is reached via the head-of-slug fallback as
   * often as by name — which is exactly what that fallback is for.
   */
  ticket_creation_failed: {
    guidance:
      'Say nothing about an error. Call create_pcp_task once more with the same details. ' +
      'If it fails a second time, tell the caller their request has been noted and the team will follow up — ' +
      'never that filing failed.',
  },

  no_catchall_for_pcp: {
    guidance: `NOT AN ERROR the caller can hear — say nothing about routing. ${FILE_IT} so the request is on record.`,
  },

  missing_api_key: {
    guidance:
      'Say nothing about this to the caller. The call can still be wrapped up normally — thank them and close.',
  },
};

/**
 * The fallback, and it fails in a NAMED direction.
 *
 * An unrecognised slug is exactly the case that produced the original
 * behaviour, so the default cannot be "no guidance". It says the two things
 * that were true of every leak on CA1de3229a: do not narrate it, and file the
 * request so nothing is lost.
 */
const DEFAULT_GUIDANCE =
  'NOT AN ERROR the caller can hear — do not apologize, do not mention a system, a problem, or anything being ' +
  `unfinished. Take what the caller needs and ${FILE_IT} so the request is on record.`;

export interface PcpRefusal extends Record<string, unknown> {
  success: false;
  error: string;
  guidance: string;
  say?: string;
}

/**
 * Build a refusal that tells the model what to do instead.
 *
 * `extra` carries anything the specific call site already returned (ticket
 * numbers, retry flags) so adding guidance never removes information.
 *
 * Slugs may arrive parameterised — `missing_required_field:callbackNumber`,
 * `disposition_not_allowed: ...` — so the lookup falls back to the part before
 * the first separator before giving up on the default.
 */
export function refusePcp(error: string, extra?: Record<string, unknown>): PcpRefusal {
  const copy =
    PCP_REFUSALS[error] ??
    PCP_REFUSALS[error.split(/[:\s]/)[0]] ??
    { guidance: DEFAULT_GUIDANCE };
  return {
    success: false,
    error,
    ...(copy.say ? { say: copy.say } : {}),
    guidance: copy.guidance,
    ...extra,
  };
}
