import { storage } from "../../server/storage";
import type { CallLog } from "../../shared/schema";

export interface CallerHistoryEntry {
  date: string;
  reason: string;
  outcome: string;
  ticketNumber?: string;
  agentUsed?: string;
  duration?: number;
  preferredContactMethod?: string;
}

export interface CallerMemory {
  phoneNumber: string;
  totalCalls: number;
  lastCallDate?: string;
  patientName?: string;
  patientDob?: string;
  lastProviderSeen?: string;
  lastLocationSeen?: string;
  preferredContactMethod?: string;
  recentCalls: CallerHistoryEntry[];
  openTickets: string[];
  notes: string;
}

export class CallerMemoryService {
  private static instance: CallerMemoryService;

  private constructor() {}

  static getInstance(): CallerMemoryService {
    if (!this.instance) {
      this.instance = new CallerMemoryService();
    }
    return this.instance;
  }

  async getCallerMemory(phoneNumber: string, maxCalls: number = 5): Promise<CallerMemory | null> {
    if (!phoneNumber) {
      console.log("[CALLER MEMORY] No phone number provided");
      return null;
    }

    const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
    console.log(`[CALLER MEMORY] Looking up history for: ${normalizedPhone}`);

    try {
      const callHistory = await storage.getCallHistoryByPhone(normalizedPhone, maxCalls);

      if (!callHistory || callHistory.length === 0) {
        console.log(`[CALLER MEMORY] No previous calls found for: ${normalizedPhone}`);
        return null;
      }

      console.log(`[CALLER MEMORY] Found ${callHistory.length} previous call(s) for: ${normalizedPhone}`);

      const memory = this.buildCallerMemory(normalizedPhone, callHistory);
      return memory;
    } catch (error) {
      console.error("[CALLER MEMORY] Error fetching caller history:", error);
      return null;
    }
  }

  private normalizePhoneNumber(phone: string): string {
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+${digits}`;
    }
    if (digits.length === 10) {
      return `+1${digits}`;
    }
    return phone;
  }

  private buildCallerMemory(phoneNumber: string, calls: CallLog[]): CallerMemory {
    const recentCalls: CallerHistoryEntry[] = calls.map((call) => ({
      date: this.formatDate(call.createdAt),
      reason: this.extractReason(call),
      outcome: this.extractOutcome(call),
      ticketNumber: call.ticketNumber || undefined,
      agentUsed: call.agentUsed || undefined,
      duration: call.duration || undefined,
      preferredContactMethod: undefined,
    }));

    const openTickets = calls
      .filter((c) => c.ticketNumber && !c.ticketingSyncedAt)
      .map((c) => c.ticketNumber!)
      .filter((t, i, arr) => arr.indexOf(t) === i);

    const mostRecent = calls[0];

    const notes = this.buildNotes(calls);

    return {
      phoneNumber,
      totalCalls: calls.length,
      lastCallDate: mostRecent?.createdAt ? this.formatDate(mostRecent.createdAt) : undefined,
      patientName: mostRecent?.patientName || mostRecent?.callerName || undefined,
      patientDob: mostRecent?.patientDob || undefined,
      lastProviderSeen: mostRecent?.lastProviderSeen || undefined,
      lastLocationSeen: mostRecent?.lastLocationSeen || undefined,
      preferredContactMethod: undefined,
      recentCalls,
      openTickets,
      notes,
    };
  }

  private formatDate(date: Date | null | undefined): string {
    if (!date) return "Unknown";
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return "Today";
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }

  private extractReason(call: CallLog): string {
    if (call.summary) {
      const summary = call.summary;
      if (summary.length > 100) {
        return summary.substring(0, 100) + "...";
      }
      return summary;
    }

    if (call.detectedConditions && Array.isArray(call.detectedConditions) && call.detectedConditions.length > 0) {
      return `Medical concern: ${(call.detectedConditions as string[]).join(", ")}`;
    }

    return "General inquiry";
  }

  private extractOutcome(call: CallLog): string {
    if (call.transferredToHuman) {
      return "Transferred to staff";
    }
    if (call.ticketNumber) {
      return `Ticket created: ${call.ticketNumber}`;
    }
    if (call.status === "completed") {
      return "Resolved by agent";
    }
    return call.status || "Unknown";
  }

  private findMostRecentPreference(calls: CallLog[], field: keyof CallLog): string | undefined {
    for (const call of calls) {
      const value = call[field];
      if (value && typeof value === "string") {
        return value;
      }
    }
    return undefined;
  }

  private buildNotes(calls: CallLog[]): string {
    const notes: string[] = [];

    const transferCount = calls.filter((c) => c.transferredToHuman).length;
    if (transferCount > 0) {
      notes.push(`Transferred to staff ${transferCount} time(s) in recent calls`);
    }

    const ticketCount = calls.filter((c) => c.ticketNumber).length;
    if (ticketCount > 0) {
      notes.push(`${ticketCount} ticket(s) created in recent calls`);
    }

    const sentiments = calls.map((c) => c.sentiment).filter(Boolean);
    const frustratedCount = sentiments.filter((s) => s === "frustrated" || s === "irate").length;
    if (frustratedCount > 0) {
      notes.push(`Caller expressed frustration in ${frustratedCount} recent call(s)`);
    }

    return notes.join(". ");
  }

  /**
   * THE CALLER-HISTORY SECTION IS KEYED ON A PHONE NUMBER, SO IT IS A
   * CANDIDATE — the same thing RULE ZERO step 2, standing instruction 6 and
   * the v47 schedule redaction say about a match on the calling number.
   * Several people share a phone, and nobody has confirmed that the person
   * speaking is the person who called last time.
   *
   * Until 2026-09-30 this section wrote the previous call's full name and
   * date of birth into the prompt as `KNOWN PATIENT: <name> (DOB: …)`, with
   * "Don't re-ask for information you already have (name, DOB)" underneath,
   * plus the last provider and office seen and each previous call's summary.
   * On `CA32108e28bc5b21ca1514a126303d0671` (after-hours, 2026-09-30 13:31
   * UTC) that defeated the v47 redaction through a side door: the schedule
   * section correctly withheld the appointment behind a name-and-date lookup,
   * and this section handed the model the surname and the date it needed to
   * make that lookup by itself. The caller affirmed a first name and spoke a
   * date of birth; the surname never came from their mouth; the appointment
   * was read; the full name was asked AFTER. The pre-context block's own rule
   * is that a first name confirms no last name and that nothing from anyone's
   * record is disclosed on the strength of a phone match — and `patientName`
   * here can even be Twilio's CNAM (`callerName`), the name on the phone bill.
   *
   * So the section now carries only what is true of the NUMBER and discloses
   * nothing from anyone's record: how many times it has called, the outcome
   * of each recent call (a ticket number at most), open tickets, a contact
   * preference, and the counts in `notes`. No name, no date of birth, no
   * provider, no office, no previous-call summary, and no instruction to skip
   * the identity questions. The caller's identity comes from the caller, the
   * way the schedule's does: pre-context supplies a first name to confirm and
   * `lookup_schedule` needs the surname and the date of birth to return
   * anything. `callerMemoryIsACandidate.test.ts` pins the renderer and
   * `noIvrMemoryIsACandidate.test.ts` pins it on both pipelines' prompts.
   */
  buildContextForPrompt(memory: CallerMemory): string {
    if (!memory || memory.totalCalls === 0) {
      return "";
    }

    let context = `
===== CALLER HISTORY (${memory.totalCalls} previous call${memory.totalCalls > 1 ? "s" : ""} from this NUMBER) =====
This phone number has contacted us before. That is a fact about the NUMBER, not the caller:
several people share a phone, and nothing here identifies who is speaking. Nobody's name, date
of birth, doctor, office or previous request is listed here, on purpose — collect the caller's
identity from the caller, exactly as you would on a first-time call.
`;

    if (memory.preferredContactMethod) {
      context += `\nPREFERRED CONTACT: ${memory.preferredContactMethod} (from a previous call on this number)`;
    }

    context += `\n\nRECENT INTERACTIONS FROM THIS NUMBER (outcome only):`;
    for (const call of memory.recentCalls.slice(0, 3)) {
      context += `\n- ${call.date}: ${call.outcome}`;
    }

    if (memory.openTickets.length > 0) {
      context += `\n\nOPEN TICKETS: ${memory.openTickets.join(", ")}`;
      context += `\n(If the caller is following up on an existing ticket, acknowledge it)`;
    }

    if (memory.notes) {
      context += `\n\nNOTES: ${memory.notes}`;
    }

    context += `

HOW TO USE THIS:
- Do NOT greet by name from this section, and do NOT skip the name or date-of-birth
  questions because of it. A previous call on this number is not this caller's identity.
- Use the preferred contact method when creating a ticket, if the caller does not state one.
- If they are following up on an open ticket, acknowledge it.
`;

    return context;
  }
}

export const callerMemoryService = CallerMemoryService.getInstance();
