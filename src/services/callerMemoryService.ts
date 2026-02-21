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

  buildContextForPrompt(memory: CallerMemory): string {
    if (!memory || memory.totalCalls === 0) {
      return "";
    }

    let context = `
===== CALLER HISTORY (${memory.totalCalls} previous call${memory.totalCalls > 1 ? "s" : ""}) =====
This caller has contacted us before. Use this history to provide personalized service.
`;

    if (memory.patientName) {
      context += `\nKNOWN PATIENT: ${memory.patientName}`;
      if (memory.patientDob) {
        context += ` (DOB: ${memory.patientDob})`;
      }
    }

    if (memory.preferredContactMethod) {
      context += `\nPREFERRED CONTACT: ${memory.preferredContactMethod} (from previous call)`;
    }

    if (memory.lastProviderSeen) {
      context += `\nLAST PROVIDER SEEN: ${memory.lastProviderSeen}`;
    }

    if (memory.lastLocationSeen) {
      context += `\nLAST LOCATION SEEN: ${memory.lastLocationSeen}`;
    }

    context += `\n\nRECENT INTERACTIONS:`;
    for (const call of memory.recentCalls.slice(0, 3)) {
      context += `\n- ${call.date}: ${call.reason} → ${call.outcome}`;
    }

    if (memory.openTickets.length > 0) {
      context += `\n\nOPEN TICKETS: ${memory.openTickets.join(", ")}`;
      context += `\n(If caller is following up on an existing ticket, acknowledge it)`;
    }

    if (memory.notes) {
      context += `\n\nNOTES: ${memory.notes}`;
    }

    context += `

PERSONALIZATION GUIDANCE:
- Greet by name if known: "Hi ${memory.patientName?.split(" ")[0] || "there"}, I see you've called us before."
- If they called recently about the same issue, acknowledge: "I see you reached out about [X] recently..."
- Use their preferred contact method when creating tickets
- Don't re-ask for information you already have (name, DOB) unless confirming
`;

    return context;
  }
}

export const callerMemoryService = CallerMemoryService.getInstance();
