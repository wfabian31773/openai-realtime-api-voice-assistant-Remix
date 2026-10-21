/**
 * NPX's outreach endpoints, for the NPX outreach call (v109).
 *
 * Operator, 2026-10-20: a voice agent calls Azul Vision patients whose
 * routine exam is weeks away and offers a sooner one at an NPX partner that
 * takes their medical group; on a yes it books in NPX, then the Azul
 * appointment is cancelled in NextGen. NPX's side merged as EPC #281; its
 * contract is `apps/npx/docs/modules/OUTREACH_AGENT.md` in the Console repo.
 *
 * Three calls, each bounded and each failing CLOSED:
 *  - offer:  up to two slots, no patient data either way;
 *  - book:   the patient's identity in, ids and the practice out;
 *  - report: whether the Azul appointment was cancelled (no patient data).
 * Without NPX_OUTREACH_API_KEY every call answers `not_configured` and sends
 * nothing. Nothing here logs a request body: the booking carries a name and
 * a date of birth.
 */

export const NPX_OUTREACH_DEFAULT_BASE_URL = 'https://cec-npx.vercel.app';

/** Per-call budgets. The booking runs a transaction under a lock on NPX's
 * side, so it gets the longest; all three sit well inside the bridge's
 * tool-dispatch watchdog. */
export const NPX_TIMEOUT_MS = { offer: 8_000, book: 12_000, report: 8_000 } as const;

export interface NpxSlot {
  slotId: string;
  startAt: string;
  endAt: string;
  timezone: string;
  day: string;
  partnerOrgId: string;
  partnerName: string;
  clinicId: string;
  clinicName: string;
  address: string;
  phone: string;
  providerName: string;
  visitType: string;
}

export interface NpxOfferRequest {
  medicalGroupName: string;
  partnerNames: string[];
  /** YYYY-MM-DD — the Azul appointment being replaced. */
  replacedAppointmentDate: string;
  minDaysSooner?: number;
}

export type NpxOfferResult =
  | { ok: true; latestDay: string; slots: NpxSlot[] }
  | { ok: false; error: NpxError };

export interface NpxBookRequest {
  slotId: string;
  medicalGroupName: string;
  minDaysSooner?: number;
  patient: {
    firstName: string;
    lastName: string;
    /** YYYY-MM-DD */
    dateOfBirth: string;
    /** The NextGen PersonID of the Console record the call worked from. */
    ngePersonId: string;
    phone?: string;
  };
  replacedAppointment: { ngeAppointmentId: string; date: string };
  spokenLanguage?: 'en' | 'es';
  /** The CallSid, for tracing. */
  callRef?: string;
}

export type NpxBookResult =
  | { ok: true; bookingId: string; alreadyBooked: boolean; recordGroupDiffers: boolean; slot: NpxSlot }
  | { ok: false; error: NpxError; next?: 'offer_again' | 'hand_to_staff' };

export type NpxReportResult = { ok: true } | { ok: false; error: NpxError };

/**
 * Every failure, named. The NPX codes are passed through; the rest are this
 * side's: `not_configured` (no key), `timeout`, `network`, `unauthorized`
 * (401 — a wrong or rotated key), `rate_limited` (429), `bad_request` (400 —
 * a bug on this side, never the caller's), `server` (5xx or an unreadable
 * reply).
 */
export type NpxError =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'unauthorized'
  | 'rate_limited'
  | 'bad_request'
  | 'server'
  | 'unknown_medical_group'
  | 'ambiguous_medical_group'
  | 'no_partners'
  | 'slot_unavailable'
  | 'held_by_other_practice'
  | 'patient_record_retired'
  | 'not_an_outreach_booking';

const NPX_CODES = new Set<NpxError>([
  'unknown_medical_group',
  'ambiguous_medical_group',
  'no_partners',
  'slot_unavailable',
  'held_by_other_practice',
  'patient_record_retired',
  'not_an_outreach_booking',
]);

/** The failure-report reason NPX accepts: a short code, never free text. */
export const NPX_REASON_CODE = /^[a-z0-9_]{1,64}$/;

type Fetch = typeof fetch;

export interface NpxOutreachClient {
  configured: boolean;
  offer(req: NpxOfferRequest): Promise<NpxOfferResult>;
  book(req: NpxBookRequest): Promise<NpxBookResult>;
  reportCancel(bookingId: string, outcome: 'cancelled' | { failed: string }): Promise<NpxReportResult>;
}

interface Reply {
  status: number;
  body: Record<string, unknown> | null;
}

export function createNpxOutreachClient(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: Fetch = fetch,
): NpxOutreachClient {
  const key = env.NPX_OUTREACH_API_KEY?.trim();
  const base = (env.NPX_OUTREACH_BASE_URL?.trim() || NPX_OUTREACH_DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function send(
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Reply | NpxError> {
    if (!key) return 'not_configured';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // The body is read inside the timer: a reply whose headers arrive and
      // whose body never does must not hang the call (the 2026-09-17 lesson
      // in ticketingApiClient).
      const text = await r.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      return { status: r.status, body: parsed };
    } catch {
      return controller.signal.aborted ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }
  }

  function failure(reply: Reply | NpxError, label: string): NpxError {
    const err: NpxError =
      typeof reply === 'string'
        ? reply
        : NPX_CODES.has(reply.body?.error as NpxError)
          ? (reply.body!.error as NpxError)
          : reply.status === 401
            ? 'unauthorized'
            : reply.status === 429
              ? 'rate_limited'
              : reply.status === 400
                ? 'bad_request'
                : 'server';
    // The code only — never the body sent or received.
    const status = typeof reply === 'string' ? '' : ` (HTTP ${reply.status})`;
    if (err === 'unauthorized') {
      console.error(`[NPX OUTREACH] ${label} refused${status}: the API key is wrong or was rotated — check NPX_OUTREACH_API_KEY against NPX's AZUL_OUTREACH_API_KEY_SHA256`);
    } else if (err !== 'not_configured') {
      console.warn(`[NPX OUTREACH] ${label} failed: ${err}${status}`);
    }
    return err;
  }

  return {
    configured: Boolean(key),

    async offer(req) {
      const reply = await send('POST', '/api/exchange/outreach/offer', req, NPX_TIMEOUT_MS.offer);
      if (typeof reply !== 'string' && reply.status === 200 && reply.body?.ok === true) {
        const slots = Array.isArray(reply.body.slots) ? (reply.body.slots as NpxSlot[]) : [];
        return { ok: true, latestDay: String(reply.body.latestDay ?? ''), slots: slots.slice(0, 2) };
      }
      return { ok: false, error: failure(reply, 'offer') };
    },

    async book(req) {
      const reply = await send('POST', '/api/exchange/outreach/bookings', req, NPX_TIMEOUT_MS.book);
      if (typeof reply !== 'string' && (reply.status === 200 || reply.status === 201) && reply.body?.ok === true) {
        return {
          ok: true,
          bookingId: String(reply.body.bookingId),
          alreadyBooked: reply.body.alreadyBooked === true,
          recordGroupDiffers: reply.body.recordGroupDiffers === true,
          slot: reply.body.slot as NpxSlot,
        };
      }
      const next = typeof reply !== 'string' ? reply.body?.next : undefined;
      return {
        ok: false,
        error: failure(reply, 'book'),
        ...(next === 'offer_again' || next === 'hand_to_staff' ? { next } : {}),
      };
    },

    async reportCancel(bookingId, outcome) {
      const body =
        outcome === 'cancelled'
          ? { outcome: 'cancelled' }
          : { outcome: 'failed', reason: NPX_REASON_CODE.test(outcome.failed) ? outcome.failed : 'unspecified' };
      const reply = await send(
        'PATCH',
        `/api/exchange/outreach/bookings/${encodeURIComponent(bookingId)}`,
        body,
        NPX_TIMEOUT_MS.report,
      );
      if (typeof reply !== 'string' && reply.status === 200 && reply.body?.ok === true) return { ok: true };
      return { ok: false, error: failure(reply, 'cancel report') };
    },
  };
}
