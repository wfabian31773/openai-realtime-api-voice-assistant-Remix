/**
 * Place an approved SI Assistant call by queueing one contact into the
 * existing campaign dialer (src/runtime/outbound/). Nothing here dials
 * Twilio itself — the scheduler ticks the `si-assistant` campaign.
 */

import {
  DEFAULT_ATTEMPT_CAPS,
  DEFAULT_CALLING_WINDOW,
  mayDialNow,
  type DialDecision,
} from "../runtime/outbound/callingWindow";
import { dncKey, type OutboundStore } from "../runtime/outbound/store";
import { readDobQuietly } from "../tools/dobParts";
import { SI_ASSISTANT_CAMPAIGN_KEY, SI_ASSISTANT_SLUG } from "./siAssistantConstants";

export const SI_ASSISTANT_CAPS = {
  ...DEFAULT_ATTEMPT_CAPS,
  perDay: 1,
  perWeek: 3,
} as const;

export const SI_ASSISTANT_WINDOW = DEFAULT_CALLING_WINDOW;

export interface EnqueueCallInput {
  approvalId: string;
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Patient date of birth from the approved prepare payload (or the ticket). */
  dateOfBirth?: string | null;
  ticketNumber?: string | null;
  ticketId?: string | null;
  purpose?: string | null;
}

/**
 * Parse a spoken or ISO date into the Y-M-D string `dobOnFile` reads.
 * Unparseable input is omitted — missing is not a mismatch.
 */
export function storedDobFromInput(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return storedDobFromInput(String(raw));
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parts = readDobQuietly(raw);
  if (!parts) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sourcePresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function birthPartsRaw(payload: Record<string, unknown>): { present: boolean; raw: string | null } {
  const present =
    sourcePresent(payload.birthMonth) || sourcePresent(payload.birthDay) || sourcePresent(payload.birthYear);
  if (!present) return { present: false, raw: null };
  const month = payload.birthMonth;
  const day = payload.birthDay;
  const year = payload.birthYear;
  if (!sourcePresent(month) || !sourcePresent(day) || !sourcePresent(year)) {
    return { present: true, raw: null };
  }
  return { present: true, raw: `${String(month).trim()}/${String(day).trim()}/${String(year).trim()}` };
}

export type PrepareDobResult = { ok: true; dateOfBirth: string } | { ok: false; error: string };

/**
 * Resolve the ticket patient's date of birth from prepare_call.
 * Accepts dateOfBirth, date_of_birth, or ticketing's birthMonth/Day/Year.
 * Missing or unparseable is a 400. Two present sources that parse differently
 * are a 400.
 */
export function prepareDobFromPayload(payload: Record<string, unknown>): PrepareDobResult {
  const sources: Array<{ name: string; parsed: string | null }> = [];
  if (sourcePresent(payload.dateOfBirth)) {
    sources.push({ name: "dateOfBirth", parsed: storedDobFromInput(payload.dateOfBirth) });
  }
  if (sourcePresent(payload.date_of_birth)) {
    sources.push({ name: "date_of_birth", parsed: storedDobFromInput(payload.date_of_birth) });
  }
  const parts = birthPartsRaw(payload);
  if (parts.present) {
    sources.push({ name: "birth parts", parsed: storedDobFromInput(parts.raw) });
  }
  if (sources.length === 0) {
    return {
      ok: false,
      error: "A parseable date of birth is required (dateOfBirth, or birthMonth, birthDay and birthYear)",
    };
  }
  for (const source of sources) {
    if (!source.parsed) {
      return { ok: false, error: "date of birth is unparseable" };
    }
  }
  const first = sources[0].parsed!;
  for (const source of sources.slice(1)) {
    if (source.parsed !== first) {
      const bothAliases =
        sources.some((s) => s.name === "dateOfBirth") && sources.some((s) => s.name === "date_of_birth");
      return {
        ok: false,
        error: bothAliases ? "dateOfBirth and date_of_birth disagree" : "dates of birth disagree",
      };
    }
  }
  return { ok: true, dateOfBirth: first };
}

/** Name + DOB from the locked prepare_call payload (ticket patient). */
export function identityFromPreparePayload(payload: Record<string, unknown>): {
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
} {
  const firstName = typeof payload.firstName === "string" ? payload.firstName.trim() || null : null;
  const lastName = typeof payload.lastName === "string" ? payload.lastName.trim() || null : null;
  const dob = prepareDobFromPayload(payload);
  return { firstName, lastName, dateOfBirth: dob.ok ? dob.dateOfBirth : null };
}

export type EnqueueCallResult =
  | { ok: true; queued: true; campaignId: string }
  | {
      ok: false;
      reason:
        | "do_not_contact"
        | "invalid_phone"
        | "no_campaign"
        | "outside_hours"
        | "closed_day"
        | "holiday"
        | "daily_cap"
        | "weekly_cap"
        | "total_cap"
        | "too_soon";
    };

export async function evaluateAndEnqueueCall(
  store: OutboundStore,
  input: EnqueueCallInput,
  now = new Date(),
): Promise<EnqueueCallResult> {
  const key = dncKey(input.phone);
  if (!key) return { ok: false, reason: "invalid_phone" };
  if (await store.isDoNotContact(input.phone)) {
    return { ok: false, reason: "do_not_contact" };
  }

  const campaignId = await store.ensureCampaign(SI_ASSISTANT_CAMPAIGN_KEY, SI_ASSISTANT_SLUG);
  if (!campaignId) return { ok: false, reason: "no_campaign" };

  const externalRef = `plugin:${input.approvalId}`;
  const existing = (await store.sourceRows(campaignId)).find((r) => r.externalRef === externalRef);
  const prior = existing ? await store.priorAttempts(existing.id) : [];
  const decision = mayDialNow(now, prior, SI_ASSISTANT_WINDOW, SI_ASSISTANT_CAPS);
  if (!decision.ok) return { ok: false, reason: decision.reason };

  const firstName = input.firstName?.trim() || null;
  const lastName = input.lastName?.trim() || null;
  const dateOfBirth = storedDobFromInput(input.dateOfBirth);
  await store.upsertSourceContacts(campaignId, [
    {
      externalRef,
      phone: `+1${key}`,
      firstName,
      lastName,
      data: {
        source: "si-assistant",
        approval_id: input.approvalId,
        ticket_number: input.ticketNumber ?? null,
        ticket_id: input.ticketId ?? null,
        purpose: input.purpose ?? null,
        ...(dateOfBirth ? { date_of_birth: dateOfBirth } : {}),
      },
    },
  ]);
  return { ok: true, queued: true, campaignId };
}

/** Pure window/caps check used by tests and by commit before enqueue. */
export function siAssistantMayDial(
  now: Date,
  attempts: ReadonlyArray<{ at: Date }>,
): DialDecision {
  return mayDialNow(now, attempts, SI_ASSISTANT_WINDOW, SI_ASSISTANT_CAPS);
}
