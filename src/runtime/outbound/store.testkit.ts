/**
 * An in-memory OutboundStore for tests. It keeps the one property the real
 * store's SQL exists for: `claimContact` moves a row to 'calling' only if
 * it is still dialable and due, and only one caller gets it.
 */
import type { OutboundContact } from "./campaign";
import { DIALABLE_STATUSES, dncKey, type AttemptFinish, type ContactRow, type ContactStatus, type OutboundStore } from "./store";

export interface FakeAttempt {
  id: string;
  contactId: string;
  campaignId: string;
  attemptNumber: number;
  at: Date;
  callSid?: string;
  finish?: AttemptFinish;
}

export class FakeOutboundStore implements OutboundStore {
  contacts = new Map<string, ContactRow & { updatedAt: Date; notes?: string }>();
  attempts: FakeAttempt[] = [];
  dnc = new Map<string, string>();
  campaignId = "campaign-1";
  agentRowMissing = false;
  private seq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  addContact(c: Partial<ContactRow> & { id: string; phone: string }): void {
    this.contacts.set(c.id, {
      campaignId: this.campaignId,
      firstName: null,
      lastName: null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      customData: {},
      ...c,
      updatedAt: this.clock(),
    });
  }

  async ensureCampaign(): Promise<string | null> {
    return this.agentRowMissing ? null : this.campaignId;
  }

  private due(c: ContactRow, now: Date): boolean {
    return (
      (DIALABLE_STATUSES as readonly string[]).includes(c.status) &&
      (!c.nextAttemptAt || c.nextAttemptAt.getTime() <= now.getTime())
    );
  }

  async dialableContacts(campaignId: string, now: Date, limit: number): Promise<ContactRow[]> {
    return [...this.contacts.values()]
      .filter((c) => c.campaignId === campaignId && this.due(c, now))
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }

  async claimContact(contactId: string, now: Date): Promise<ContactRow | null> {
    const c = this.contacts.get(contactId);
    if (!c || !this.due(c, now)) return null;
    c.status = "calling";
    c.updatedAt = this.clock();
    return { ...c };
  }

  async releaseContact(contactId: string, status: ContactStatus, nextAttemptAt: Date | null): Promise<void> {
    const c = this.contacts.get(contactId);
    if (!c || c.status !== "calling") return;
    c.status = status;
    c.nextAttemptAt = nextAttemptAt;
  }

  async priorAttemptTimes(contactId: string): Promise<Date[]> {
    return this.attempts.filter((a) => a.contactId === contactId).map((a) => a.at);
  }

  async startAttempt(contactId: string, campaignId: string, attemptNumber: number): Promise<string> {
    const id = `attempt-${++this.seq}`;
    this.attempts.push({ id, contactId, campaignId, attemptNumber, at: this.clock() });
    const c = this.contacts.get(contactId);
    if (c) c.attempts += 1;
    return id;
  }

  async setAttemptCallSid(attemptId: string, callSid: string): Promise<void> {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (a) a.callSid = callSid;
  }

  async finishAttempt(attemptId: string, finish: AttemptFinish): Promise<void> {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (!a) return;
    // Same rule as the SQL: the answer webhook's verdict outranks "completed".
    const kept = a.finish && ["voicemail", "fax", "not_ready"].includes(a.finish.status);
    a.finish = { ...a.finish, ...finish, ...(kept ? { status: a.finish!.status } : {}) };
  }

  async loadCallContact(contactId: string, attemptId: string): Promise<OutboundContact | null> {
    const c = this.contacts.get(contactId);
    const a = this.attempts.find((x) => x.id === attemptId && x.contactId === contactId);
    if (!c || !a) return null;
    return {
      contactId: c.id,
      campaignId: c.campaignId,
      attemptId,
      phone: c.phone,
      firstName: c.firstName,
      lastName: c.lastName,
      data: c.customData,
    };
  }

  async settleContact(
    contactId: string,
    status: ContactStatus,
    opts: { nextAttemptAt?: Date | null; onlyIfCalling?: boolean; notes?: string } = {},
  ): Promise<boolean> {
    const c = this.contacts.get(contactId);
    if (!c) return false;
    if (opts.onlyIfCalling && c.status !== "calling") return false;
    c.status = status;
    c.nextAttemptAt = opts.nextAttemptAt ?? null;
    if (opts.notes) c.notes = opts.notes;
    return true;
  }

  async callsInFlight(campaignId: string, since: Date): Promise<number> {
    return [...this.contacts.values()].filter(
      (c) => c.campaignId === campaignId && c.status === "calling" && c.updatedAt >= since,
    ).length;
  }

  async reapStaleClaims(campaignId: string, before: Date): Promise<number> {
    let n = 0;
    for (const c of this.contacts.values()) {
      if (c.campaignId === campaignId && c.status === "calling" && c.updatedAt < before) {
        c.status = "no_answer";
        n += 1;
      }
    }
    return n;
  }

  async isDoNotContact(phone: string): Promise<boolean> {
    const key = dncKey(phone);
    return !key || this.dnc.has(key);
  }

  async stampDoNotContact(phone: string, source: string): Promise<void> {
    const key = dncKey(phone);
    if (key && !this.dnc.has(key)) this.dnc.set(key, source);
  }
}
