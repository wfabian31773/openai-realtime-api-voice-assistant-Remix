import type { CreateTicketParams } from '../../server/services/ticketingApiClient';

interface Filing {
  idempotencyKey: string | null;
  status: string;
  ticketNumber: string | null;
  refusalStatusCode?: number | null;
  payload: unknown;
}

type Update = { callSid?: string; ticketNumber?: string; transcript?: string };
type Response = { success: boolean; ticketNumber?: string; error?: string };

function noteOf(payload: unknown): string | undefined {
  const item = payload as { kind?: string; params?: CreateTicketParams } | null;
  if (item?.kind !== 'create_ticket_v1') return undefined;
  return item.params?.callData?.transcript?.split('\n').find(line => /^Callback extension: \d+$/.test(line));
}

/** Read the same per-patient keys the filing path uses; the outbox survives a restart. */
export async function callbackExtensionFilings(sid?: string, ticketNumber?: string): Promise<Filing[]> {
  const [{ db }, { ticketOutbox }, { eq, like, or }] = await Promise.all([
    import('../../server/db'), import('../../shared/schema'), import('drizzle-orm'),
  ]);
  const key = sid ? `call-${sid}` : undefined;
  if (!key && !ticketNumber) return [];
  return db.select({
    idempotencyKey: ticketOutbox.idempotencyKey,
    status: ticketOutbox.status,
    ticketNumber: ticketOutbox.ticketNumber,
    refusalStatusCode: ticketOutbox.refusalStatusCode,
    payload: ticketOutbox.payload,
  }).from(ticketOutbox).where(key
    ? or(eq(ticketOutbox.idempotencyKey, key), like(ticketOutbox.idempotencyKey, `${key}-p%`))
    : eq(ticketOutbox.ticketNumber, ticketNumber!));
}

/** Send the shared conversation with only the receiving ticket's own extension. */
export async function syncWithCallbackExtensions<T extends Update>(
  payload: T,
  load: (sid?: string, ticketNumber?: string) => Promise<Filing[]>,
  send: (payload: T) => Promise<Response>,
): Promise<Response> {
  const sid = payload.callSid && /^CA[0-9a-f]{32}$/i.test(payload.callSid) ? payload.callSid : undefined;
  if (!payload.transcript || (!sid && !payload.ticketNumber)) return send(payload);
  const key = sid ? `call-${sid}` : undefined;
  const entries = (await (sid ? load(sid) : load(undefined, payload.ticketNumber))).filter(row =>
    (key ? (row.idempotencyKey === key || new RegExp(`^${key}-p\\d{1,3}$`).test(row.idempotencyKey ?? '')) : row.ticketNumber === payload.ticketNumber) &&
    (row.payload as { kind?: string } | null)?.kind === 'create_ticket_v1',
  );
  // A timeout may have created a ticket. Wait for the idempotent retry before
  // selecting a ticket by CallSid, which could overwrite its original note.
  if (entries.some(row => row.status !== 'sent' && !(row.status === 'dead_letter' && (row.refusalStatusCode === 400 || row.refusalStatusCode === 422)))) {
    return { success: false, error: 'Ticket filing is still pending' };
  }
  const sent = entries.filter(row => row.status === 'sent');
  if (!sid && sent.some(row => (row.payload as { consolidated?: boolean }).consolidated)) {
    // A ticket number alone cannot identify which consolidated contact called.
    return { success: false, error: 'Cannot safely sync a consolidated contact without its call identifier' };
  }
  if (!sent.some(row => noteOf(row.payload))) return send(payload);
  if (sent.some(row => !row.ticketNumber)) return { success: false, error: 'Filed ticket number is unavailable' };

  const { callSid: _sid, ...byTicket } = payload;
  const seen = new Set<string>();
  // A consolidated filing is a contact on a pre-existing ticket. Looking it
  // up by ticket number updates the parent, not that contact; leave its filed
  // staff note intact instead of assigning it to the wrong record.
  const targets = sent.filter(row => !(row.payload as { consolidated?: boolean }).consolidated)
    .map(row => ({ ticketNumber: row.ticketNumber!, note: noteOf(row.payload) }));
  if (payload.ticketNumber && !sent.some(row => row.ticketNumber === payload.ticketNumber)) {
    targets.push({ ticketNumber: payload.ticketNumber, note: undefined });
  }
  for (const target of targets) {
    if (seen.has(target.ticketNumber)) continue;
    seen.add(target.ticketNumber);
    const transcript = target.note && !payload.transcript.split('\n').includes(target.note)
      ? `${payload.transcript}\n${target.note}` : payload.transcript;
    const result = await send({ ...byTicket, ticketNumber: target.ticketNumber, transcript } as T);
    if (!result.success) return result;
  }
  if (sent.some(row => (row.payload as { consolidated?: boolean }).consolidated)) {
    return { success: false, error: 'Cannot safely sync a consolidated contact by ticket number' };
  }
  return { success: true, ticketNumber: payload.ticketNumber || targets[0]?.ticketNumber };
}
