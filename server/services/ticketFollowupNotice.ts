/**
 * SEND THE FOLLOW-UP NOTICE ONCE PER TERMINAL ROW.
 *
 * Claim, then send, then keep the claim. A failed send unclaims so the next
 * cycle retries. Already-notified and resolved rows are never selected.
 *
 * Eligibility is the persisted refusal_status_code against the enumerated
 * payload-refusal set — never last_error text. A row dead-lettered before
 * that column existed (the three of 2026-09-25) stays NULL and is not
 * emailed as a terminal refusal; Wayne resolves those by hand.
 *
 * Does not go through sendAlert: that path's cooldown and hourly cap would
 * throttle a row away. emailService.sendEmail is the same SMTP route the
 * operator named for the filing alarm.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { ticketOutbox } from '../../shared/schema';
import { PAYLOAD_REFUSAL_STATUSES, isTerminalRefusal } from '../../src/services/terminalRefusal';
import { sendEmail } from './emailService';
import {
  buildFollowupEmail,
  followupFactsFromPayload,
  type FollowupNoticeRow,
} from './ticketFollowupEmail';

export function isFollowupEligible(row: {
  refusalStatusCode: number | null;
  followupNotifiedAt: Date | null;
  resolvedAt: Date | null;
  status?: string;
}): boolean {
  if (row.followupNotifiedAt) return false;
  if (row.resolvedAt) return false;
  if (row.status && row.status !== 'dead_letter') return false;
  return isTerminalRefusal(row.refusalStatusCode ?? undefined);
}

export async function notifyTerminalRefusals(): Promise<{ notified: number }> {
  try {
    const pending = await db
      .select({
        id: ticketOutbox.id,
        callSid: ticketOutbox.callSid,
        createdAt: ticketOutbox.createdAt,
        lastError: ticketOutbox.lastError,
        refusalStatusCode: ticketOutbox.refusalStatusCode,
        payload: ticketOutbox.payload,
        followupNotifiedAt: ticketOutbox.followupNotifiedAt,
        resolvedAt: ticketOutbox.resolvedAt,
        status: ticketOutbox.status,
      })
      .from(ticketOutbox)
      .where(
        and(
          eq(ticketOutbox.status, 'dead_letter'),
          isNull(ticketOutbox.resolvedAt),
          isNull(ticketOutbox.followupNotifiedAt),
          inArray(ticketOutbox.refusalStatusCode, [...PAYLOAD_REFUSAL_STATUSES]),
        ),
      );

    const eligible = pending.filter((row) =>
      isFollowupEligible({
        refusalStatusCode: row.refusalStatusCode,
        followupNotifiedAt: row.followupNotifiedAt,
        resolvedAt: row.resolvedAt,
        status: row.status,
      }),
    );
    if (eligible.length === 0) return { notified: 0 };

    const now = new Date();
    const claimed = await db
      .update(ticketOutbox)
      .set({ followupNotifiedAt: now, updatedAt: now })
      .where(
        and(
          inArray(
            ticketOutbox.id,
            eligible.map((r) => r.id),
          ),
          eq(ticketOutbox.status, 'dead_letter'),
          isNull(ticketOutbox.followupNotifiedAt),
          isNull(ticketOutbox.resolvedAt),
        ),
      )
      .returning({
        id: ticketOutbox.id,
        callSid: ticketOutbox.callSid,
        createdAt: ticketOutbox.createdAt,
        lastError: ticketOutbox.lastError,
        refusalStatusCode: ticketOutbox.refusalStatusCode,
        payload: ticketOutbox.payload,
      });

    if (claimed.length === 0) return { notified: 0 };

    try {
      const noticeRows: FollowupNoticeRow[] = claimed.map((row) => {
        const facts = followupFactsFromPayload(row.payload);
        return {
          id: row.id,
          callSid: row.callSid,
          createdAt: row.createdAt,
          lastError: row.lastError,
          refusalStatusCode: row.refusalStatusCode,
          departmentId: facts.departmentId,
          agentUsed: facts.agentUsed,
        };
      });

      const sent = await sendEmail(buildFollowupEmail(noticeRows));
      if (!sent) {
        await unclaimFollowup(claimed.map((r) => r.id));
        console.error(
          `[TICKET FOLLOW-UP] send failed — unclaimed ${claimed.length} row(s) so the next cycle can retry`,
        );
        return { notified: 0 };
      }

      console.info(
        `[TICKET FOLLOW-UP] notified ${claimed.length} terminal refusal(s) as ${noticeRows.map((r) => r.callSid ?? r.id).join(', ')}`,
      );
      return { notified: claimed.length };
    } catch (sendErr) {
      // A throw after the claim used to leave followup_notified_at set and
      // the row never emailed again — the grading-claim shape, one door over.
      await unclaimFollowup(claimed.map((r) => r.id));
      console.error(
        `[TICKET FOLLOW-UP] send threw — unclaimed ${claimed.length} row(s):`,
        sendErr,
      );
      return { notified: 0 };
    }
  } catch (err) {
    console.error('[TICKET FOLLOW-UP] could not send notices:', err);
    return { notified: 0 };
  }
}

async function unclaimFollowup(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(ticketOutbox)
    .set({ followupNotifiedAt: null, updatedAt: new Date() })
    .where(inArray(ticketOutbox.id, ids));
}
