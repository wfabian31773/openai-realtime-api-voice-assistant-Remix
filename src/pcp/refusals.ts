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

  /**
   * "Carry on with the call normally" is what this used to say, and carrying
   * on is exactly what the model did. CAa37f1a42, 2026-09-04: it filed
   * PCP-57486 and never came back to the transfer it had already promised the
   * caller out loud. The refusal has to name the tool to return to — a
   * refusal that does not say what closes it is a refusal the model treats as
   * the end of the road.
   *
   * The code no longer depends on the model obeying this: once the request is
   * on record, handoff_to_pcp proceeds even if its own ticket write fails
   * again. This is the second floor, not the only one.
   */
  durable_ticket_required_before_handoff: {
    guidance:
      'NOT AN ERROR — say nothing about it. The request has to be on record before anyone is dialled. ' +
      'Call create_pcp_task now, and then call handoff_to_pcp again to connect them. ' +
      'Do not move on to anything else until you have retried the transfer.',
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

  /**
   * Transfer refused AND the fallback filing failed. The only genuinely bad one
   * — and for two months it was the only one that told the caller it had gone
   * well.
   *
   * THE COPY CLAIMED THE RECORD THAT THIS BRANCH IS DEFINED BY NOT HAVING.
   * It read "I've taken this down and I'm making sure it reaches the right
   * team", which is its sibling's line, and the sibling is the one reached when
   * `fallback.success` is TRUE. Here it is false by construction.
   *
   * 2026-09-14, the PCP line's first full day: 17 callers heard that sentence
   * and no ticket of any provenance carries their call SID. Every one of them
   * had said one thing — "speak to a representative" — and every one of their
   * POSTs is in `voice_agent_api_logs` as HTTP 400 ["Validation failed"],
   * because the ticketing app's slug list was one entry short of the agent's
   * (`patient_caller`; ticketing-app #267, since deployed).
   *
   * That cause is closed. This sentence is why it cost us seventeen requests
   * instead of being visible the first time it happened: a caller who is told
   * their request is filed does not call back, and a staffer never sees a
   * ticket to work. The next filing failure will have a different cause —
   * a timeout, an outage, a schema that drifts again — and it must not be
   * silent.
   *
   * WHAT IT SAYS NOW, and why each part is load-bearing:
   *   - it does NOT say the request is recorded, because it is not;
   *   - it does NOT mention a system, an error or a retry (#265 and the
   *     CA1de3229a rule that produced this whole module);
   *   - it ASKS FOR THE CALLBACK NUMBER, which is standing instruction 12 and
   *     is also the one field that makes the teardown floor useful.
   * The commitment it does make — that someone will call back — is kept by
   * `sweepPcpUnfiledCall`, which now files for a caller who asked for a person
   * and did not get one even when they never gave a name.
   */
  handoff_not_eligible: {
    say: "I'm not able to put you through from this line, but I do want the right team to call you back. Is this the best number to reach you on?",
    guidance:
      'The filing did NOT go through — do not tell the caller it did, and do not mention a system, an error or a retry. ' +
      'Say the line above, take the number they give you with record_pcp_intake, then call create_pcp_task again to get the request on record. ' +
      'Do not promise a transfer.',
  },

  /**
   * THE SAME BRANCH, FOR A CALLER WHOSE NUMBER WE DO NOT HAVE.
   *
   * "Is this the best number to reach you on?" presupposes a number (Codex P2,
   * #300). It is right for the common case — `pcpAgent.ts:510` seeds
   * `callbackNumber` from caller ID on every call whose ANI is E.164, and
   * confirming beats asking. It is wrong when there is nothing to confirm: a
   * withheld or blocked caller ID arrives as a non-E.164 string, the seeding
   * regex correctly rejects it, and the caller is then asked to confirm a
   * number nobody holds. An answer of "yes" to that question produces a
   * request that cannot be called back, which is the one outcome this whole
   * branch exists to prevent.
   *
   * THE FORK IS THE HOUSE PATTERN, not a new one. `knowledgeBase.ts:283`
   * already writes it — "I have your callback number as ending in ####. Is
   * that correct?" against "What is the best number to reach you?" — and this
   * refusal's own sibling pair is already selected by a ternary at the call
   * site. So this is a second key, chosen there, rather than logic inside the
   * copy table.
   *
   * Everything else is deliberately identical to the sibling: it refuses the
   * transfer plainly, it does NOT claim the record, and it asks for the
   * callback number (standing instruction 12).
   */
  handoff_not_eligible_no_callback: {
    say: "I'm not able to put you through from this line, but I do want the right team to call you back. What's the best number to reach you on?",
    guidance:
      'The filing did NOT go through — do not tell the caller it did, and do not mention a system, an error or a retry. ' +
      'We have no callback number for this caller, so ASK for one rather than confirming one. ' +
      'Say the line above, take the number they give you with record_pcp_intake, then call create_pcp_task again to get the request on record. ' +
      'Do not promise a transfer.',
  },

  /**
   * WE DIALLED AND NOBODY PICKED UP. CAa2a3a1c1, 2026-09-08 12:28.
   *
   * This is the one the whole module was written for and the one call site it
   * never covered, because a failed dial is not a "refusal" — it is an action
   * that ran and did not work. `handoff_to_pcp` returned
   * `{success:false, handoffStatus:'NO_ANSWER', ticketNumber, fallbackRecorded}`:
   * true, complete, and carrying not one word for the model or the caller. So
   * the model improvised, exactly as it did on CA1de3229a. What it improvised
   * this time was going back to the intake script:
   *
   *   agent   "Give me one moment while I connect you with our PCP team —
   *            I'll stay right here with you."
   *   ...     dial to the PCP queue, 12:30:08, NO_ANSWER
   *   caller  "You still there?"
   *   agent   "Still with you — one moment."
   *   caller  "Did you try to connect?"
   *   agent   "What is the patient's first name?"          <- the whole defect
   *   caller  "No. I'm trying to talk to a representative."
   *
   * The prompt already says "if it does not connect, say exactly that and
   * confirm their request is already recorded". It is forty lines from the
   * tool result, and the tool result is what the model is looking at. A rule
   * stated only in the prompt loses to a return value that says nothing.
   *
   * THE `say` CAN PROMISE THE RECORD BECAUSE THE GATE GUARANTEES IT. The dial
   * is only reached when `requestIsOnRecord` holds — a HAND_OFF or CREATE_TASK
   * disposition is already durable — so "your request is recorded" is not a
   * reassurance, it is an invariant of being here at all.
   *
   * WHAT IT MUST NOT SAY, and this is #265: nothing about the team being busy
   * and nothing about anyone becoming available. `queuePromptRulings.test.ts`
   * bans that language on the four queue lines because the agent improvised it
   * live on 2026-09-03. PCP differs only in that it CAN transfer; it may
   * report what this attempt did, never speculate about the next one.
   */
  /**
   * ONE ROUND BEFORE THE DIAL, and the only refusal on this line that is
   * guaranteed never to repeat.
   *
   * Operator ruling, 2026-09-08: "the ask wins, one round then transfer
   * anyway." The caller asked for a person and is going to get one; this asks
   * once for what the staffer will otherwise have to start from zero on, and
   * then gets out of the way. `preTransferAskUsed` is a per-call latch, so a
   * second handoff attempt dials whatever the caller said or did not say.
   *
   * The `say` is built by `preTransferQuestion` from the gaps that actually
   * exist, so it is passed in rather than written here — a caller who already
   * gave their name is never asked for it again.
   *
   * WHAT THE GUIDANCE MUST NOT DO is let the model treat this as a reason to
   * resume the intake script. That is exactly what happened on CAa2a3a1c1
   * after a failed dial: handed a refusal with no instruction, it went back to
   * "What is the patient's first name?" while the caller asked whether we had
   * tried to connect. One question, then the transfer, whatever the answer.
   */
  pre_transfer_intake: {
    guidance:
      'NOT AN ERROR — say nothing about a system, a problem, or a requirement. The caller IS being transferred; ' +
      'this is the one question you ask first. Say the line above, record what they give you with record_pcp_intake, ' +
      'then call handoff_to_pcp again immediately. ' +
      'Ask it ONCE. If they will not answer, or answer only part of it, call handoff_to_pcp again anyway — the ' +
      'transfer goes ahead either way and the person who picks up can ask. Do NOT return to the intake questions, ' +
      'do not ask for the patient, and do not ask a second time in different words.',
  },

  /**
   * THE WARNING BECAME A QUESTION. Operator ruling, 2026-09-13.
   *
   * Rosa's 09-08 design put the wait warning in the TwiML, which plays AFTER
   * the redirect has already begun and the Media Stream is gone — so the
   * caller heard it with no way to answer. It was an announcement. This is the
   * same content asked as a question, in the agent's own turn, before anything
   * is filed or dialled.
   *
   * The `say` line is supplied by the call site from `QUEUE_CHOICE_WARNING`
   * so the wording lives in one place next to the ruling that produced it.
   *
   * WHAT THE GUIDANCE MUST NOT DO is let the model answer on the caller's
   * behalf. Only a spoken yes goes to the queue; the tool treats a missing
   * answer as "not established" and keeps today's behaviour, which files.
   */
  queue_choice: {
    guidance:
      'NOT AN ERROR — say nothing about a system, a problem, or a requirement. The caller asked for a person and ' +
      'they are entitled to one; this is the choice we owe them first. Say the line above, then call handoff_to_pcp ' +
      'again with callerAcceptedQueue set to what they actually said: true if they want to be connected, false if ' +
      'they would rather you took it here. Do NOT guess, do not leave it out because they were vague, and do not ' +
      'ask twice — if they will not choose, call handoff_to_pcp again without the field and it will be handled.',
  },

  /**
   * They heard the warning and chose to have it taken here. No dial.
   *
   * Deliberately does NOT file a ticket at this point. "If they want to
   * continue, we create a ticket with all the information needed" — filing
   * from here would file it with whatever we happen to hold, which is the
   * 27-second ticket of CA7a5f2bfa all over again. The model goes back to the
   * intake and `create_pcp_task` applies its own readiness rules, with
   * `sweepPcpUnfiledCall` behind it if the caller drops.
   */
  queue_choice_declined: {
    guidance:
      'NOT AN ERROR — say nothing about a system or a problem, and do not mention the transfer again. The caller ' +
      'chose to have you take the request rather than hold for the queue, so there will be no transfer on this ' +
      'call. Thank them, collect what is still missing for the request, and file it with create_pcp_task. Do NOT ' +
      'call handoff_to_pcp again unless the caller themselves asks to be connected after all.',
  },

  handoff_no_answer: {
    say: "I wasn't able to get someone on the line just now, but I have your request recorded and the team will follow up with you.",
    guidance:
      'The dial went out and nobody picked up. The request is already filed — this is not a failure to hide, and it is not a system error either. ' +
      'Say the line above FIRST, before anything else, and never go back to a question as though the transfer had not happened. ' +
      'Do not say the team is busy, do not say anyone will be available shortly, and do not offer to try again. ' +
      'Then confirm the callback number you have is the right one, and ask for anything still missing so the follow-up is not blind.',
  },

  /** The dial itself never got off the ground. Same words to the caller — the
   * difference is ours, not theirs — and the same standing ban on speculating
   * about who is available. */
  handoff_failed: {
    say: "I wasn't able to get someone on the line just now, but I have your request recorded and the team will follow up with you.",
    guidance:
      'The transfer could not be placed. The request is already filed. Say the line above and do not mention a system, an error, or a retry. ' +
      'Then confirm the callback number and collect anything still missing.',
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
