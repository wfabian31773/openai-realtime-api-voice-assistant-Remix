/**
 * Ticket keys for a person ringing the SI Assistant number back.
 *
 * A phone match is a candidate to confirm, never an identity (RULE ZERO
 * step 2 / standing instruction 6). Ticket keys attach ONLY after a full
 * name AND date of birth match the patient on file. A first name — even
 * one the greeting just said — is not identification. Having dialled
 * patient A is not confirmation: that needs an explicit yes to
 * "Am I speaking with A?" plus a DOB match. wrong_person never attaches.
 * A phone match never attaches. Unidentified callbacks go to SI Assistant
 * My Messages with up to three suggested tickets (number + approval id,
 * no extra PHI) drawn from placed dials and sent texts/emails in 72 hours.
 */
import { extrasFromContactData } from "./callbackReport";
import { boundOutboundStore, boundPluginStore } from "./bindings";
import { RETURNED_CALL_LOOKBACK_MS } from "./store";
import { SI_ASSISTANT_CAMPAIGN_KEY } from "./siAssistantConstants";
import { dncKey, type OutboundStore } from "../runtime/outbound/store";
import type { PluginStore } from "./store";

export const SUGGESTION_LIMIT = 3;

export type TicketExtras = {
  ticketNumber?: string | null;
  approvalId?: string | null;
  ticketId?: string | null;
};

export type TicketSuggestion = {
  ticketNumber: string | null;
  approvalId: string | null;
};

export type ChosenIdentity = {
  contactId: string;
  /** Ticket attach requires a full-name + date-of-birth match. */
  verifiedBy?: "first_name" | "full_name_dob";
};

export type TicketAttachment = {
  extras: TicketExtras;
  suggestions: TicketSuggestion[];
  identityConfirmed: boolean;
};

export function hasTicketKeys(extras: TicketExtras): boolean {
  return Boolean(extras.ticketNumber || extras.approvalId || extras.ticketId);
}

export function ticketKeyOf(extras: Pick<TicketExtras, "ticketNumber" | "approvalId" | "ticketId">): string | null {
  return extras.ticketNumber || extras.approvalId || extras.ticketId || null;
}

export function suggestionOf(extras: TicketExtras): TicketSuggestion | null {
  if (!extras.ticketNumber && !extras.approvalId) return null;
  return { ticketNumber: extras.ticketNumber ?? null, approvalId: extras.approvalId ?? null };
}

/** The identified caller's own contact — never another person on the number. */
export function extrasForIdentifiedContact(
  chosen: { contactId: string },
  candidates: Array<{ contactId: string; data?: Record<string, unknown> | null }>,
): TicketExtras {
  const match = candidates.find((c) => c.contactId === chosen.contactId);
  return extrasFromContactData(match?.data);
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

type RankedSuggestion = { suggestion: TicketSuggestion; at: number; key: string };

export function mergeSuggestions(ranked: RankedSuggestion[], limit = SUGGESTION_LIMIT): TicketSuggestion[] {
  const ordered = [...ranked].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const out: TicketSuggestion[] = [];
  for (const row of ordered) {
    if (!row.key || seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(row.suggestion);
    if (out.length >= limit) break;
  }
  return out;
}

/** Campaign contacts that actually reached the network inside 72 hours. */
export function suggestionsFromPlacedContacts(
  candidates: Array<{
    lastAttemptAt: Date | null;
    data?: Record<string, unknown> | null;
  }>,
  now = new Date(),
): RankedSuggestion[] {
  const since = now.getTime() - RETURNED_CALL_LOOKBACK_MS;
  const ranked: RankedSuggestion[] = [];
  for (const c of candidates) {
    const at = c.lastAttemptAt?.getTime() ?? 0;
    if (at <= 0 || at < since) continue;
    const extras = extrasFromContactData(c.data);
    const suggestion = suggestionOf(extras);
    const key = ticketKeyOf(extras);
    if (!suggestion || !key) continue;
    ranked.push({ suggestion, at, key });
  }
  return ranked;
}

export function emptyAttachment(suggestions: TicketSuggestion[] = []): TicketAttachment {
  return { extras: {}, suggestions, identityConfirmed: false };
}

export function identifiedAttachment(extras: TicketExtras): TicketAttachment {
  return { extras, suggestions: [], identityConfirmed: true };
}

/**
 * One attachment for the message and the call report. Confirmed identity
 * (full name + DOB, and on a dialled call an explicit yes) is the only
 * path that may carry ticket keys. Otherwise suggestions only.
 */
export async function attachmentForSiAssistant(
  input: {
    outboundContactData?: Record<string, unknown> | null;
    chosen?: ChosenIdentity | null;
    candidates?: Array<{ contactId: string; data?: Record<string, unknown> | null; lastAttemptAt?: Date | null }>;
    store?: OutboundStore | null;
    attemptId?: string | null;
    phone?: string;
    greetingAffirmed?: boolean;
    dobMatched?: boolean;
    wrongPerson?: boolean;
  },
  now = new Date(),
  outbound: OutboundStore | null = boundOutboundStore(),
  plugin: PluginStore | null = boundPluginStore(),
): Promise<TicketAttachment> {
  const suggestionsOf = async () =>
    input.phone
      ? suggestionsForReturnedCaller(input.phone, now, outbound ?? input.store ?? null, plugin)
      : [];

  if (input.wrongPerson) return emptyAttachment(await suggestionsOf());

  if (input.outboundContactData && input.greetingAffirmed && input.dobMatched) {
    return identifiedAttachment(extrasFromContactData(input.outboundContactData));
  }

  if (input.chosen?.verifiedBy === "full_name_dob") {
    if (input.store && input.attemptId) {
      try {
        const contact = await input.store.loadCallContact(input.chosen.contactId, input.attemptId);
        const extras = extrasFromContactData(contact?.data);
        if (hasTicketKeys(extras)) return identifiedAttachment(extras);
      } catch {
        console.error("[si-assistant] identified-contact load failed");
      }
    }
    return identifiedAttachment(extrasForIdentifiedContact(input.chosen, input.candidates ?? []));
  }

  return emptyAttachment(await suggestionsOf());
}

export async function suggestionsForReturnedCaller(
  phone: string,
  now = new Date(),
  outbound: OutboundStore | null = boundOutboundStore(),
  plugin: PluginStore | null = boundPluginStore(),
): Promise<TicketSuggestion[]> {
  const ranked: RankedSuggestion[] = [];
  if (outbound) {
    try {
      const { candidates } = await outbound.callbackCandidates(SI_ASSISTANT_CAMPAIGN_KEY, phone);
      ranked.push(...suggestionsFromPlacedContacts(candidates, now));
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
      for (const row of rows) {
        // A committed call is only "enqueued". Count texts and emails that
        // were actually sent. Placed dials come from the campaign list.
        if (row.channel === "call") continue;
        if (!row.committedAt || row.committedAt.getTime() <= 0) continue;
        const extras = extrasFromApproval(row);
        const suggestion = suggestionOf(extras);
        const ticketKey = ticketKeyOf(extras);
        if (!suggestion || !ticketKey) continue;
        ranked.push({ suggestion, at: row.committedAt.getTime(), key: ticketKey });
      }
    } catch {
      console.error("[si-assistant] returned-caller approval lookup failed");
    }
  }
  return mergeSuggestions(ranked);
}
