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
import { outboundDialingEnabled, PLACE_BY_KEY, type NotPlacedReason } from "../runtime/outbound/campaign";
import { DIALABLE_STATUSES, dncKey, type OutboundStore } from "../runtime/outbound/store";
import { readDobQuietly } from "../tools/dobParts";
import { boundPluginStore } from "./bindings";
import type { PluginStore } from "./store";
import {
  SI_ASSISTANT_CALLER_ID_ENV,
  SI_ASSISTANT_CAMPAIGN_KEY,
  SI_ASSISTANT_ENABLE_ENV,
  SI_ASSISTANT_SLUG,
} from "./siAssistantConstants";

export const SI_ASSISTANT_CAPS = {
  ...DEFAULT_ATTEMPT_CAPS,
  perDay: 1,
  perWeek: 3,
} as const;

export const SI_ASSISTANT_WINDOW = DEFAULT_CALLING_WINDOW;

/**
 * How long an approved call may wait in the queue before its FIRST dial
 * (v115). A commit is refused outside the calling window, so a healthy
 * dialler rings within a tick or two; this bounds the case where it cannot
 * (routing being fixed, a deploy) so a staffer's approval is never acted on
 * hours or days later. Retries after a first dial follow the caps instead.
 */
export const SI_ASSISTANT_PLACE_BY_MS = 2 * 60 * 60 * 1000;

export type SiAssistantDialingProblem = "outbound_dialing_off" | "campaign_off" | "no_caller_id";

/**
 * Why the dialler would not place an SI Assistant call right now, read from
 * the same switches it reads (`campaignEnabled`, the caller-ID env), or null.
 * A commit must not report a call as queued when nothing will dial it (v115).
 */
export function siAssistantDialingProblem(
  env: Record<string, string | undefined>,
): SiAssistantDialingProblem | null {
  if (!outboundDialingEnabled(env)) return "outbound_dialing_off";
  if (env[SI_ASSISTANT_ENABLE_ENV] !== "1") return "campaign_off";
  if (!(env[SI_ASSISTANT_CALLER_ID_ENV] ?? "").trim()) return "no_caller_id";
  return null;
}

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
        | "too_soon"
        | "call_already_queued";
    };

export async function evaluateAndEnqueueCall(
  store: OutboundStore,
  input: EnqueueCallInput,
  now = new Date(),
  live = false,
): Promise<EnqueueCallResult> {
  const key = dncKey(input.phone);
  if (!key) return { ok: false, reason: "invalid_phone" };
  if (await store.isDoNotContact(input.phone)) {
    return { ok: false, reason: "do_not_contact" };
  }

  const campaignId = await store.ensureCampaign(SI_ASSISTANT_CAMPAIGN_KEY, SI_ASSISTANT_SLUG);
  if (!campaignId) return { ok: false, reason: "no_campaign" };

  const externalRef = `plugin:${input.approvalId}`;
  // The caps are per PHONE (priorAttempts reads every attempt in the campaign
  // on the same ten digits), so any row on this number carries its history.
  // Each approval is its own row, so reading only this approval's row would
  // find none and let a second approval through the daily cap (v115).
  const rows = await store.sourceRows(campaignId);
  // Another approval's call to this number that the dialler will still place
  // (queued, a retry, or on the line now): it rings first or this one does,
  // and the per-phone caps hold the other until its place-by deadline lapses.
  // Refused here so the commit never answers "queued" for a call that would
  // not ring.
  const stillDialling = rows.some(
    (r) =>
      r.externalRef !== externalRef &&
      dncKey(r.phone) === key &&
      (r.status === "calling" || r.status === "pending" ||
        (r.customData.plugin_live !== true && (DIALABLE_STATUSES as readonly string[]).includes(r.status))),
  );
  if (stillDialling) return { ok: false, reason: "call_already_queued" };
  const onPhone = rows.find((r) => r.externalRef === externalRef) ?? rows.find((r) => dncKey(r.phone) === key);
  const prior = onPhone ? await store.priorAttempts(onPhone.id) : [];
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
        ...(live ? { plugin_live: true } : {}),
        approval_id: input.approvalId,
        ticket_number: input.ticketNumber ?? null,
        ticket_id: input.ticketId ?? null,
        purpose: input.purpose ?? null,
        ...(dateOfBirth ? { date_of_birth: dateOfBirth } : {}),
        [PLACE_BY_KEY]: new Date(now.getTime() + SI_ASSISTANT_PLACE_BY_MS).toISOString(),
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

/**
 * The dialler settled an SI Assistant call before its first dial (v115): its
 * place-by deadline passed, the number went on the do-not-contact list, or
 * the phone reached its total cap. The approval read `committed` with
 * `queued: true`; it now reads `failed` with the reason, so nobody takes a
 * call that never rang as made. Only a committed approval moves, and only
 * once. A missing store or approval is a no-op: the contact row already says
 * what happened.
 */
export async function reportCallNotPlaced(
  contact: { id: string; customData: Record<string, unknown> },
  reason: NotPlacedReason = "place_by_passed",
  store: PluginStore | null = boundPluginStore(),
  now = new Date(),
): Promise<void> {
  const approvalId = contact.customData.approval_id;
  if (!store || typeof approvalId !== "string" || !approvalId) return;
  const current = await store.getApproval(approvalId);
  if (!current) return;
  // Only a committed approval moves: the conditional update is the check.
  const updated = await store.updateApproval(
    approvalId,
    {
      status: "failed",
      result: { ...(current.result ?? {}), queued: false, placed: false, reason },
      updatedAt: now,
    },
    "committed",
  );
  if (!updated) return;
  try {
    await store.writeAudit({
      tokenJti: "system",
      tool: "call_not_placed",
      route: "/api/plugin/v1/commit_contact",
      method: "SWEEP",
      approvalId,
      ticketId: current.ticketId,
      outcome: "failed",
      httpStatus: 410,
    });
  } catch {
    console.error("[si-assistant] call-not-placed audit failed");
  }
}
