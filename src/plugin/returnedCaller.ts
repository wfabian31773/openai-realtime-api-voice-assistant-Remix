/**
 * Ticket keys for a person ringing the SI Assistant number back.
 * A returned call has no outboundContact on the runtime session, so
 * teardown and take_si_assistant_message look up the most recent
 * approved outbound contact to that caller (72 hours).
 */
import { extrasFromContactData } from "./callbackReport";
import { boundOutboundStore, boundPluginStore } from "./bindings";
import { RETURNED_CALL_LOOKBACK_MS } from "./store";
import { SI_ASSISTANT_CAMPAIGN_KEY } from "./siAssistantConstants";
import { dncKey, type OutboundStore } from "../runtime/outbound/store";
import type { PluginStore } from "./store";

export type TicketExtras = {
  ticketNumber?: string | null;
  approvalId?: string | null;
  ticketId?: string | null;
};

export function hasTicketKeys(extras: TicketExtras): boolean {
  return Boolean(extras.ticketNumber || extras.approvalId || extras.ticketId);
}

export function extrasFromRecentContacts(
  candidates: Array<{ lastAttemptAt: Date | null; data?: Record<string, unknown> | null }>,
  now = new Date(),
): TicketExtras {
  const since = now.getTime() - RETURNED_CALL_LOOKBACK_MS;
  const scored = candidates
    .map((c) => ({
      extras: extrasFromContactData(c.data),
      at: c.lastAttemptAt?.getTime() ?? 0,
    }))
    .filter((c) => hasTicketKeys(c.extras) && (c.at === 0 || c.at >= since));
  scored.sort((a, b) => {
    if (a.at === 0 && b.at !== 0) return 1;
    if (b.at === 0 && a.at !== 0) return -1;
    return b.at - a.at;
  });
  return scored[0]?.extras ?? {};
}

export function extrasFromApproval(row: {
  id: string;
  ticketId: string | null;
  ticketNumber: string | null;
}): TicketExtras {
  return {
    ticketNumber: row.ticketNumber,
    approvalId: row.id,
    ticketId: row.ticketId,
  };
}

export async function extrasForReturnedCaller(
  phone: string,
  now = new Date(),
  outbound: OutboundStore | null = boundOutboundStore(),
  plugin: PluginStore | null = boundPluginStore(),
): Promise<TicketExtras> {
  if (outbound) {
    try {
      const { candidates } = await outbound.callbackCandidates(SI_ASSISTANT_CAMPAIGN_KEY, phone);
      const fromCampaign = extrasFromRecentContacts(candidates, now);
      if (hasTicketKeys(fromCampaign)) return fromCampaign;
    } catch {
      console.error("[si-assistant] returned-caller campaign lookup failed");
    }
  }
  const key = dncKey(phone);
  if (plugin && key) {
    try {
      const row = await plugin.findRecentApprovedContactByPhone(
        key,
        new Date(now.getTime() - RETURNED_CALL_LOOKBACK_MS),
      );
      if (row) return extrasFromApproval(row);
    } catch {
      console.error("[si-assistant] returned-caller approval lookup failed");
    }
  }
  return {};
}
