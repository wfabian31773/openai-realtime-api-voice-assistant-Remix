/**
 * MARK A DEAD LETTER HANDLED, WITHOUT REPLAYING IT.
 *
 * A resolved row drops out of the stall alarm and out of the follow-up
 * notice. It does not change status or payload — the request still sits
 * there if someone later needs to read it — and it does not auto-fire on
 * deploy. Existing 2026-09-25 rows wait for Wayne.
 */
import { db } from '../../server/db';
import { ticketOutbox } from '../../shared/schema';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { isTerminalRefusal } from './terminalRefusal';
import { followupFactsFromPayload } from '../../server/services/ticketFollowupEmail';

export type ResolveOutboxResult =
  | { ok: true; id: string; resolvedAt: string; resolvedBy: string }
  | { ok: false; reason: 'not_found' | 'not_dead_letter' | 'already_resolved' };

export function actorFromRequest(req: {
  session?: { userId?: string };
  user?: { claims?: { sub?: string } };
}): string | null {
  if (req.session?.userId) return req.session.userId;
  if (req.user?.claims?.sub) return req.user.claims.sub;
  return null;
}

export async function resolveOutboxRow(input: {
  id: string;
  resolvedBy: string;
  note?: string | null;
}): Promise<ResolveOutboxResult> {
  const now = new Date();
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const updated = await db
    .update(ticketOutbox)
    .set({
      resolvedAt: now,
      resolvedBy: input.resolvedBy,
      resolutionNote: note,
      updatedAt: now,
    })
    .where(
      and(
        eq(ticketOutbox.id, input.id),
        eq(ticketOutbox.status, 'dead_letter'),
        isNull(ticketOutbox.resolvedAt),
      ),
    )
    .returning({ id: ticketOutbox.id, resolvedAt: ticketOutbox.resolvedAt, resolvedBy: ticketOutbox.resolvedBy });

  if (updated.length > 0) {
    return {
      ok: true,
      id: updated[0].id,
      resolvedAt: (updated[0].resolvedAt ?? now).toISOString(),
      resolvedBy: updated[0].resolvedBy ?? input.resolvedBy,
    };
  }

  const [existing] = await db
    .select({
      id: ticketOutbox.id,
      status: ticketOutbox.status,
      resolvedAt: ticketOutbox.resolvedAt,
    })
    .from(ticketOutbox)
    .where(eq(ticketOutbox.id, input.id))
    .limit(1);

  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.resolvedAt) return { ok: false, reason: 'already_resolved' };
  return { ok: false, reason: 'not_dead_letter' };
}

export interface UnresolvedDeadLetter {
  id: string;
  callSid: string | null;
  createdAt: string;
  lastError: string | null;
  refusalStatusCode: number | null;
  kind: 'terminal' | 'transport';
  departmentId: string;
  agentUsed: string;
}

export async function listUnresolvedDeadLetters(): Promise<UnresolvedDeadLetter[]> {
  const rows = await db
    .select({
      id: ticketOutbox.id,
      callSid: ticketOutbox.callSid,
      createdAt: ticketOutbox.createdAt,
      lastError: ticketOutbox.lastError,
      refusalStatusCode: ticketOutbox.refusalStatusCode,
      payload: ticketOutbox.payload,
    })
    .from(ticketOutbox)
    .where(and(eq(ticketOutbox.status, 'dead_letter'), isNull(ticketOutbox.resolvedAt)))
    .orderBy(desc(ticketOutbox.createdAt));

  return rows.map((row) => {
    const facts = followupFactsFromPayload(row.payload);
    return {
      id: row.id,
      callSid: row.callSid,
      createdAt: row.createdAt.toISOString(),
      lastError: row.lastError,
      refusalStatusCode: row.refusalStatusCode,
      kind: isTerminalRefusal(row.refusalStatusCode ?? undefined) ? 'terminal' : 'transport',
      departmentId: facts.departmentId,
      agentUsed: facts.agentUsed,
    };
  });
}
