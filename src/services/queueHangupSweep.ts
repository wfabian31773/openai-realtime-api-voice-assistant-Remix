/**
 * THE QUEUE HANGUP SWEEP — same class of safety net scheduling and PCP have.
 *
 * Live, old core. Optical, surgery, tech and records have no `terminate_call`,
 * so a caller hangup, a provider drop, or any teardown ends the call with
 * whatever conversation state the tools already wrote. Until this file, that
 * state died with the session: voiceAgentRoutes gated the sweep to
 * `azul-scheduling` and `pcp`, and the four lanes fell through to
 * `Promise.resolve()`.
 *
 * This builds a create-ticket payload from that state and sends it through
 * `createTicketDurable`. A ticket number comes back from the ticketing app
 * or the request goes in the outbox. This function never invents one, and
 * it never returns success with no number — `createTicketDurable` already
 * refuses that, and the result we expose does too.
 *
 * WHAT IT WILL NOT DO
 *
 *  - Re-resolve an office or a surgeon. Names already on the call travel as
 *    names. The 2026-08-31 lookup collapse is why.
 *  - File a ghost. Caller-ID alone is not a request. Same lesson as azul's
 *    2026-07-30 false tickets and PCP's `toldUsSomething` gate.
 *  - File over a ticket this call already has, or over an open ticket
 *    `check_open_tickets` already reported.
 *  - Speak, log, or document a name, DOB, phone, or transcript.
 */

import { createTicketDurable } from './durableTicketFiling';
import {
  QUEUE_HOME_DEPARTMENT,
  isQueueLane,
  queueCallStateFor,
  type QueueLane,
} from './queueCallState';
import { verifiedIdentityFor } from '../tools/verifiedIdentity';
import { isTwilioCallSid } from '../tools/callSid';
import { normalizePhone } from '../utils/phone';
import type { CreateTicketParams } from '../../server/services/ticketingApiClient';

export interface QueueSweepSnapshot {
  callId: string;
  agentSlug: string | undefined;
  twilioCallSid?: string;
  from?: string;
  dbCallLogId?: string;
}

export interface QueueSweepResult {
  filed: boolean;
  ticketNumber?: string;
  queued?: boolean;
  outboxId?: string;
  skipped?:
    | 'not_a_queue_lane'
    | 'no_stated_request'
    | 'already_filed'
    | 'open_ticket_already'
    | 'no_identity'
    | 'no_callback'
    | 'terminal_refusal'
    | 'persist_failed';
  /** Always false when present. A missing number is a failure, not a VA- we minted. */
  inventedTicketNumber?: false;
}

const HANGUP_HEADER =
  'CALLER HUNG UP BEFORE THE REQUEST WAS COMPLETE. Filed from what was gathered on the call so it is not lost.';

export async function sweepQueueUnfiledCall(snap: QueueSweepSnapshot): Promise<QueueSweepResult> {
  try {
    if (!isQueueLane(snap.agentSlug)) {
      return { filed: false, skipped: 'not_a_queue_lane', inventedTicketNumber: false };
    }
    const slug: QueueLane = snap.agentSlug;
    const callSid = isTwilioCallSid(snap.twilioCallSid) ? snap.twilioCallSid : undefined;
    const held = queueCallStateFor(callSid);

    if (held?.filedTicketNumber || held?.filedPending) {
      console.info(`[QUEUE SWEEP] ${slug}: already has a ticket — nothing to file`);
      return { filed: false, skipped: 'already_filed', inventedTicketNumber: false };
    }
    if (held?.existingOpenTicket) {
      console.info(`[QUEUE SWEEP] ${slug}: open ticket already on the call — nothing to file`);
      return { filed: false, skipped: 'open_ticket_already', inventedTicketNumber: false };
    }

    const stated = Boolean(held?.requestDescription || held?.requestReasonId);
    if (!stated) {
      console.info(`[QUEUE SWEEP] ${slug}: no stated request — nothing to file`);
      return { filed: false, skipped: 'no_stated_request', inventedTicketNumber: false };
    }

    const identity = verifiedIdentityFor(callSid);
    const first = (held?.firstName || identity?.firstName || '').trim();
    const last = (held?.lastName || identity?.lastName || '').trim();
    if (!first || !last) {
      console.info(`[QUEUE SWEEP] ${slug}: has a request but no identity — cannot build a payload`);
      return { filed: false, skipped: 'no_identity', inventedTicketNumber: false };
    }

    const rawPhone = held?.callbackNumber || snap.from || '';
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 10) {
      console.info(`[QUEUE SWEEP] ${slug}: has a request but no callback number — cannot build a payload`);
      return { filed: false, skipped: 'no_callback', inventedTicketNumber: false };
    }

    const payload = await buildPayload(slug, {
      first,
      last,
      dob: identity?.dateOfBirth,
      phone: rawPhone,
      held,
      callSid,
    });
    if (!payload) {
      return { filed: false, skipped: 'persist_failed', inventedTicketNumber: false };
    }

    console.warn(
      `[QUEUE SWEEP] ${slug}: hangup with no ticket — filing from conversation state`,
    );

    const res = await createTicketDurable(payload);
    if (res.success && res.ticketNumber) {
      console.info(`[QUEUE SWEEP] ✓ ${slug} filed ${res.ticketNumber}`);
      return { filed: true, ticketNumber: res.ticketNumber, inventedTicketNumber: false };
    }
    if (res.queued && res.outboxId) {
      console.info(
        `[QUEUE SWEEP] ✓ ${slug} CAPTURED as ${res.outboxId} — worker will retry. ` +
          `There is no ticket number — do not invent one.`,
      );
      return {
        filed: false,
        queued: true,
        outboxId: res.outboxId,
        inventedTicketNumber: false,
      };
    }
    if (res.terminal) {
      console.error(
        `[QUEUE SWEEP] ${slug}: create-ticket REFUSED the payload — not queued`,
      );
      return { filed: false, skipped: 'terminal_refusal', inventedTicketNumber: false };
    }
    console.error(`[QUEUE SWEEP] ✗ ${slug} could not persist — request is NOT held`);
    return { filed: false, skipped: 'persist_failed', inventedTicketNumber: false };
  } catch (e) {
    console.error('[QUEUE SWEEP] failed (call already ended):', e);
    return { filed: false, skipped: 'persist_failed', inventedTicketNumber: false };
  }
}

async function buildPayload(
  slug: QueueLane,
  args: {
    first: string;
    last: string;
    dob?: string;
    phone: string;
    held: ReturnType<typeof queueCallStateFor>;
    callSid?: string;
  },
): Promise<CreateTicketParams | null> {
  const home = args.held?.departmentId ?? QUEUE_HOME_DEPARTMENT[slug];
  const { otherReasonFor } = await import('../tools/otherReason');
  const other = otherReasonFor(home);
  if (!other && !args.held?.requestTypeId) {
    console.error(`[QUEUE SWEEP] ${slug}: no catch-all for department ${home}`);
    return null;
  }

  const { sanitizeForSms } = await import('./gsm7');
  const { sanitizeLocationName, sanitizeProviderName } = await import('./ticketFieldSanitizers');
  const rawDescription = args.held?.requestDescription ?? '';
  const cleanDescription = sanitizeForSms(
    [HANGUP_HEADER, rawDescription].filter(Boolean).join('\n\n'),
  );

  const { detectCrossQueue } = await import('../tools/queueRouting');
  const redirect = rawDescription ? detectCrossQueue(rawDescription, home) : null;
  const departmentId = redirect?.departmentId ?? home;
  const requestTypeId = redirect?.requestTypeId ?? args.held?.requestTypeId ?? other!.requestTypeId;
  const requestReasonId =
    redirect?.requestReasonId ?? args.held?.requestReasonId ?? other!.requestReasonId;
  const description = redirect
    ? `${redirect.note}\n\n${cleanDescription.value}`
    : cleanDescription.value;

  let parts: { month: string; day: string; year: string } | null = null;
  if (args.dob) {
    const { normalizeDobParts } = await import('../tools/dobParts');
    parts = normalizeDobParts(args.dob);
  }

  const officeName = sanitizeLocationName(
    args.held?.verifiedLocation || args.held?.usualOffice || '',
  ).value;
  const providerName = sanitizeProviderName(args.held?.lastProvider || '').value;
  const filedOnSurgery = departmentId === QUEUE_HOME_DEPARTMENT.surgery;
  const filedOnOptical = departmentId === QUEUE_HOME_DEPARTMENT.optical;
  const missingRouting = (filedOnSurgery && !providerName) || (filedOnOptical && !officeName);

  return {
    departmentId,
    requestTypeId,
    requestReasonId,
    patientFirstName: args.first,
    patientLastName: args.last,
    patientPhone: normalizePhone(args.phone),
    preferredContactMethod: 'phone',
    ...(parts
      ? {
          patientBirthMonth: parts.month,
          patientBirthDay: parts.day,
          patientBirthYear: parts.year,
        }
      : {}),
    ...(officeName ? { locationOfLastVisit: officeName } : {}),
    ...(filedOnSurgery && providerName ? { lastProviderSeen: providerName } : {}),
    /**
     * Hangup IS the spent ask. The ticketing app refuses a department-2
     * ticket with no surgeon; on the live tool that refusal becomes a
     * question. There is nobody left to ask. Same flag the filing tool
     * sends after two refusals — operator ruling 2026-09-02.
     */
    ...(filedOnSurgery ? { routingAskExhausted: true } : {}),
    description,
    priority: missingRouting ? 'high' : 'medium',
    callData: {
      agentUsed: slug,
      ...(args.callSid ? { callSid: args.callSid } : {}),
    },
    ...(args.callSid ? { idempotencyKey: `call-${args.callSid}` } : {}),
  };
}
