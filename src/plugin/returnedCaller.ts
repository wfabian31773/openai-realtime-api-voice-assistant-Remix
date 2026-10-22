/**
 * Ticket keys for a person ringing the SI Assistant number back.
 *
 * A phone match is a candidate to confirm, never an identity — we never
 * pick between people who share a number (RULE ZERO step 2 / standing
 * instruction 6). Prefer the person the caller was identified as. Otherwise
 * attach a ticket only when exactly one ticket and one patient match among
 * contacts that were actually placed or sent in the last 72 hours. Zero or
 * several → no keys; the message goes to SI Assistant My Messages unmatched
 * for a human to route.
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

export type TicketMatch =
  | { kind: "one"; extras: TicketExtras }
  | { kind: "several" }
  | { kind: "none" };

export function hasTicketKeys(extras: TicketExtras): boolean {
  return Boolean(extras.ticketNumber || extras.approvalId || extras.ticketId);
}

export function ticketKeyOf(extras: TicketExtras): string | null {
  return extras.ticketNumber || extras.ticketId || extras.approvalId || null;
}

export function extrasOfMatch(match: TicketMatch): TicketExtras {
  return match.kind === "one" ? match.extras : {};
}

/** The identified caller's own contact — never another person on the number. */
export function extrasForIdentifiedContact(
  chosen: { contactId: string },
  candidates: Array<{ contactId: string; data?: Record<string, unknown> | null }>,
): TicketExtras {
  const match = candidates.find((c) => c.contactId === chosen.contactId);
  return extrasFromContactData(match?.data);
}

export function uniqueTicketAndPatient(
  rows: Array<{ extras: TicketExtras; patientKey: string }>,
): TicketMatch {
  const withKeys = rows.filter((r) => hasTicketKeys(r.extras) && r.patientKey);
  if (withKeys.length === 0) return { kind: "none" };
  if (withKeys.length === 1) return { kind: "one", extras: withKeys[0].extras };
  const tickets = new Set(withKeys.map((r) => ticketKeyOf(r.extras)).filter((k): k is string => Boolean(k)));
  const patients = new Set(withKeys.map((r) => r.patientKey));
  if (tickets.size === 1 && patients.size === 1) return { kind: "one", extras: withKeys[0].extras };
  return { kind: "several" };
}

/**
 * Campaign contacts that actually reached the network inside 72 hours.
 * A missing or zero lastAttemptAt is not a placed dial.
 */
export function matchPlacedContacts(
  candidates: Array<{
    contactId?: string;
    lastAttemptAt: Date | null;
    data?: Record<string, unknown> | null;
  }>,
  now = new Date(),
): TicketMatch {
  const since = now.getTime() - RETURNED_CALL_LOOKBACK_MS;
  return uniqueTicketAndPatient(
    candidates
      .map((c) => ({
        extras: extrasFromContactData(c.data),
        patientKey: c.contactId ?? "",
        at: c.lastAttemptAt?.getTime() ?? 0,
      }))
      .filter((c) => c.at > 0 && c.at >= since)
      .map(({ extras, patientKey }) => ({ extras, patientKey })),
  );
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
      const fromCampaign = matchPlacedContacts(candidates, now);
      if (fromCampaign.kind === "one") return fromCampaign.extras;
      // Several people or several tickets on this number: never pick, and
      // do not consult approvals for a different winner.
      if (fromCampaign.kind === "several") return {};
    } catch {
      console.error("[si-assistant] returned-caller campaign lookup failed");
    }
  }
  const key = dncKey(phone);
  if (plugin && key) {
    try {
      const rows = await plugin.listCommittedContactsByPhone(
        key,
        new Date(now.getTime() - RETURNED_CALL_LOOKBACK_MS),
      );
      return extrasOfMatch(
        uniqueTicketAndPatient(rows.map((row) => ({ extras: extrasFromApproval(row), patientKey: row.id }))),
      );
    } catch {
      console.error("[si-assistant] returned-caller approval lookup failed");
    }
  }
  return {};
}
