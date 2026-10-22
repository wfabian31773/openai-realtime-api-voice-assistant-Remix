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
  ticketNumber?: string | null;
  ticketId?: string | null;
  purpose?: string | null;
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

  await store.upsertSourceContacts(campaignId, [
    {
      externalRef,
      phone: `+1${key}`,
      firstName: input.firstName?.trim() || null,
      lastName: input.lastName?.trim() || null,
      data: {
        source: "si-assistant",
        approval_id: input.approvalId,
        ticket_number: input.ticketNumber ?? null,
        ticket_id: input.ticketId ?? null,
        purpose: input.purpose ?? null,
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
