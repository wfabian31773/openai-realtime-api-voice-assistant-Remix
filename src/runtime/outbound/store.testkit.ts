/**
 * An in-memory OutboundStore for tests. It keeps the one property the real
 * store's SQL exists for: `claimContact` moves a row to 'calling' only if
 * it is still dialable and due, and only one caller gets it.
 */
import type { OutboundContact } from "./campaign";
import type { CallbackCandidate } from "./callback";
import { nameKey } from "../../tools/verifiedIdentity";
import {
  CALLBACK_ATTEMPT_NUMBER,
  DIALABLE_STATUSES,
  NOT_PLACED,
  CONFIRMATION_FIELD,
  OUTREACH_TEXT_KEY,
  TEXTABLE_STATUSES,
  dncKey,
  type AttemptFinish,
  type ContactRow,
  type ContactStatus,
  type OutboundStore,
  type PriorAttempt,
  type SettleOptions,
  type SourceRow,
} from "./store";
import type { SourceContact } from "./campaign";
import { ChannelDoNotContact, SMS_DNC_SOURCE } from "./channelDnc";
import type { OutreachTextRecord } from "./outreachText";
import type { BookingConfirmationRecord } from "./bookingConfirmation";

export interface FakeAttempt {
  id: string;
  contactId: string;
  campaignId: string;
  attemptNumber: number;
  /** "outbound" unless written by openCallbackAttempt. */
  direction?: "outbound" | "inbound";
  at: Date;
  callSid?: string;
  finish?: AttemptFinish;
  endedAt?: Date;
}

export class FakeOutboundStore implements OutboundStore {
  contacts = new Map<string, ContactRow & { updatedAt: Date; notes?: string }>();
  attempts: FakeAttempt[] = [];
  /** Shared with MemoryPluginStore in channel-separation tests. */
  channelDnc = new ChannelDoNotContact();
  /** Voice opt-outs only. Existing tests seed this map; SMS STOP is `channelDnc.sms`. */
  get dnc(): Map<string, string> {
    return this.channelDnc.voice;
  }
  campaignId = "campaign-1";
  /** The campaign key ensureCampaign/callbackCandidates answer for; any key
   * when null (the dialer's tests never name one). */
  campaignKey: string | null = null;
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
      contacted: false,
      nextAttemptAt: null,
      customData: {},
      externalRef: null,
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
      .filter((c) => c.campaignId === campaignId && c.customData.plugin_live !== true && this.due(c, now))
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

  /** Contact ids whose phone reads as the same ten digits as this one's,
   * in this contact's campaign only, or in every campaign. */
  private samePhone(contactId: string, everyCampaign: boolean): Set<string> {
    const me = this.contacts.get(contactId);
    if (!me) return new Set();
    const key = (phone: string) => phone.replace(/\D/g, "").slice(-10);
    return new Set(
      [...this.contacts.values()]
        .filter((c) => (everyCampaign || c.campaignId === me.campaignId) && key(c.phone) === key(me.phone))
        .map((c) => c.id),
    );
  }

  async priorAttempts(contactId: string): Promise<PriorAttempt[]> {
    // Same rule as the SQL: the phone in this campaign, and a dial Twilio
    // refused spends nothing.
    const siblings = this.samePhone(contactId, false);
    return this.attempts
      .filter((a) => siblings.has(a.contactId) && (a.direction ?? "outbound") === "outbound" && a.finish?.status !== NOT_PLACED)
      .map((a) => ({ at: a.at, contactId: a.contactId }));
  }

  async consecutiveRefusedAttempts(contactId: string, since: Date): Promise<number> {
    // Same rule as the SQL: this contact row, trailing not_placed only,
    // inside the window.
    const mine = this.attempts
      .filter((a) => a.contactId === contactId && (a.direction ?? "outbound") === "outbound" && a.at >= since)
      .slice()
      .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    let n = 0;
    for (const a of mine) {
      if (a.finish?.status !== NOT_PLACED) break;
      n += 1;
    }
    return n;
  }

  async callOpenOnPhone(contactId: string, since: Date): Promise<boolean> {
    // Same rule as the SQL: the phone in EVERY campaign, still on the line,
    // a dial or a returned call alike.
    const siblings = this.samePhone(contactId, true);
    return this.attempts.some((a) => siblings.has(a.contactId) && !a.endedAt && a.at >= since);
  }

  async startAttempt(contactId: string, campaignId: string, attemptNumber: number): Promise<string> {
    const id = `attempt-${++this.seq}`;
    this.attempts.push({ id, contactId, campaignId, attemptNumber, at: this.clock() });
    return id;
  }

  async markContactDialled(contactId: string): Promise<void> {
    const c = this.contacts.get(contactId);
    if (c) {
      c.attempts += 1;
      c.contacted = true;
    }
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
    if (finish.ended ?? true) a.endedAt ??= this.clock();
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

  async settleContact(contactId: string, status: ContactStatus, opts: SettleOptions = {}): Promise<boolean> {
    const c = this.contacts.get(contactId);
    if (!c) return false;
    if (opts.onlyIfCalling && c.status !== "calling") return false;
    if (opts.exceptStatus?.includes(c.status)) return false;
    if (opts.onlyIfStatusIn && opts.onlyIfStatusIn.length > 0 && !opts.onlyIfStatusIn.includes(c.status)) return false;
    if (opts.onlyIfCurrentAttempt) {
      // Same rule as the SQL: the contact's newest outbound attempt.
      const mine = this.attempts.filter((a) => a.contactId === contactId && (a.direction ?? "outbound") === "outbound");
      if (mine[mine.length - 1]?.id !== opts.onlyIfCurrentAttempt) return false;
    }
    c.status = status;
    c.nextAttemptAt = opts.nextAttemptAt ?? null;
    if (opts.notes) c.notes = opts.notes;
    return true;
  }

  async callsInFlight(campaignId: string, since: Date): Promise<number> {
    // Same rule as the SQL: the live attempt, not the contact's status.
    return this.attempts.filter(
      (a) => a.campaignId === campaignId && (a.direction ?? "outbound") === "outbound" && !a.endedAt && a.at >= since,
    ).length;
  }

  async reapStaleClaims(campaignId: string, before: Date, nextAttemptAt: Date): Promise<number> {
    let n = 0;
    for (const c of this.contacts.values()) {
      if (c.campaignId === campaignId && c.status === "calling" && c.updatedAt < before) {
        c.status = "no_answer";
        c.nextAttemptAt = nextAttemptAt;
        n += 1;
      }
    }
    return n;
  }

  async isDoNotContact(phone: string): Promise<boolean> {
    const key = dncKey(phone);
    return this.channelDnc.isVoiceBlocked(key);
  }

  async stampDoNotContact(phone: string, source: string): Promise<void> {
    const key = dncKey(phone);
    this.channelDnc.stamp(key, source === SMS_DNC_SOURCE ? SMS_DNC_SOURCE : source);
  }

  /** Same rules as the SQL: this campaign's rows on the caller's ten digits,
   * each with its newest dial that reached the network, newest first. */
  async callbackCandidates(
    campaignKey: string,
    phone: string,
  ): Promise<{ campaignId: string | null; candidates: CallbackCandidate[] }> {
    if (this.agentRowMissing || (this.campaignKey !== null && this.campaignKey !== campaignKey)) {
      return { campaignId: null, candidates: [] };
    }
    const key = dncKey(phone);
    if (!key) return { campaignId: this.campaignId, candidates: [] };
    const candidates = [...this.contacts.values()]
      .filter((c) => c.campaignId === this.campaignId && dncKey(c.phone) === key)
      .map((c) => this.candidate(c.id)!)
      .sort((a, b) => (b.lastAttemptAt?.getTime() ?? -Infinity) - (a.lastAttemptAt?.getTime() ?? -Infinity));
    return { campaignId: this.campaignId, candidates };
  }

  async contactsByName(campaignId: string, firstName: string, lastName: string): Promise<CallbackCandidate[]> {
    const first = nameKey(firstName);
    const last = nameKey(lastName);
    if (!last) return [];
    return [...this.contacts.values()]
      .filter(
        (c) =>
          c.campaignId === campaignId &&
          nameKey(c.firstName ?? undefined) === first &&
          nameKey(c.lastName ?? undefined) === last,
      )
      .map((c) => this.candidate(c.id)!);
  }

  async openCallbackAttempt(contactId: string, campaignId: string, callSid: string): Promise<string> {
    const id = `attempt-${++this.seq}`;
    this.attempts.push({
      id,
      contactId,
      campaignId,
      attemptNumber: CALLBACK_ATTEMPT_NUMBER,
      direction: "inbound",
      at: this.clock(),
      callSid,
    });
    return id;
  }

  private candidate(contactId: string): CallbackCandidate | null {
    const c = this.contacts.get(contactId);
    if (!c) return null;
    const placed = this.attempts
      .filter((a) => a.contactId === contactId && (a.direction ?? "outbound") === "outbound" && a.finish?.status !== NOT_PLACED)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    return {
      contactId: c.id,
      campaignId: c.campaignId,
      phone: c.phone,
      firstName: c.firstName,
      lastName: c.lastName,
      status: c.status,
      data: c.customData,
      lastAttemptAt: placed[0]?.at ?? null,
      lastAttemptStatus: placed[0]?.finish?.status ?? (placed[0] ? "initiated" : null),
    };
  }

  /** How many times upsertSourceContacts was called, and with how many rows. */
  upserts: number[] = [];

  async sourceRows(campaignId: string): Promise<SourceRow[]> {
    return [...this.contacts.values()]
      .filter((c) => c.campaignId === campaignId && c.externalRef !== null)
      .map((c) => ({
        id: c.id,
        externalRef: c.externalRef!,
        phone: c.phone,
        firstName: c.firstName,
        lastName: c.lastName,
        customData: c.customData,
        status: c.status,
      }));
  }

  async upsertSourceContacts(campaignId: string, list: Array<SourceContact & { phone: string }>): Promise<number> {
    if (list.length === 0) return 0;
    this.upserts.push(list.length);
    for (const s of list) {
      const existing = [...this.contacts.values()].find((c) => c.campaignId === campaignId && c.externalRef === s.externalRef);
      if (existing) {
        // Same rule as the SQL: the source's fields follow, the status never.
        existing.phone = s.phone;
        existing.firstName = s.firstName;
        existing.lastName = s.lastName;
        // Same rule as the SQL: the outreach text's state is the row's (v211).
        const held = existing.customData[OUTREACH_TEXT_KEY];
        existing.customData = held === undefined ? s.data : { ...s.data, [OUTREACH_TEXT_KEY]: held };
      } else {
        const id = `src-${++this.seq}`;
        this.addContact({
          id,
          phone: s.phone,
          firstName: s.firstName,
          lastName: s.lastName,
          customData: s.data,
          externalRef: s.externalRef,
          campaignId,
        });
      }
    }
    return list.length;
  }

  async parkContacts(campaignId: string, externalRefs: string[], until: Date): Promise<number> {
    let n = 0;
    for (const c of this.contacts.values()) {
      if (
        c.campaignId === campaignId &&
        c.externalRef !== null &&
        externalRefs.includes(c.externalRef) &&
        (DIALABLE_STATUSES as readonly string[]).includes(c.status)
      ) {
        // Same rule as the SQL: later of the two, never brought forward.
        c.nextAttemptAt = c.nextAttemptAt && c.nextAttemptAt > until ? c.nextAttemptAt : until;
        n += 1;
      }
    }
    return n;
  }

  async updateContactPhone(contactId: string, phone: string): Promise<void> {
    const c = this.contacts.get(contactId);
    if (c) c.phone = phone;
  }

  // ── The outreach text and its booking page (v211). Same rules as the SQL. ──

  /** The campaign key contactByTextToken answers with (`campaignKey` when set). */
  textCampaignKey = "npx-outreach";

  private textOf(c: ContactRow): OutreachTextRecord | null {
    const raw = c.customData[OUTREACH_TEXT_KEY];
    return raw && typeof raw === "object" ? (raw as OutreachTextRecord) : null;
  }

  private textDue(c: ContactRow, now: Date): boolean {
    if (!(TEXTABLE_STATUSES as readonly string[]).includes(c.status)) return false;
    if (c.customData.plugin_live === true || c.customData.plugin_live === "true") return false;
    const t = this.textOf(c);
    if (!t) return true;
    return t.state === "retry" && !!t.retry_after && new Date(t.retry_after).getTime() <= now.getTime();
  }

  async textableContacts(campaignId: string, now: Date, limit: number): Promise<ContactRow[]> {
    return [...this.contacts.values()]
      .filter((c) => c.campaignId === campaignId && this.textDue(c, now))
      .slice(0, limit)
      .map((c) => ({ ...c, customData: { ...c.customData } }));
  }

  /** How many claims landed, for the "never texted twice" tests. */
  textClaims = 0;

  async claimText(contactId: string, now: Date, record: OutreachTextRecord): Promise<ContactRow | null> {
    const c = this.contacts.get(contactId);
    if (!c || !this.textDue(c, now)) return null;
    c.customData = { ...c.customData, [OUTREACH_TEXT_KEY]: { ...record } };
    this.textClaims += 1;
    return { ...c, customData: { ...c.customData } };
  }

  async patchText(contactId: string, patch: Partial<OutreachTextRecord>): Promise<void> {
    const c = this.contacts.get(contactId);
    const t = c ? this.textOf(c) : null;
    if (!c || !t) return;
    // JSON's own rule: an undefined field is not written.
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    c.customData = { ...c.customData, [OUTREACH_TEXT_KEY]: { ...t, ...defined } };
  }

  async contactByTextToken(tokenHash: string): Promise<{ contact: ContactRow; campaignKey: string } | null> {
    const found = [...this.contacts.values()].filter((c) => this.textOf(c)?.token_hash === tokenHash);
    if (found.length !== 1) return null;
    return { contact: { ...found[0], customData: { ...found[0].customData } }, campaignKey: this.campaignKey ?? this.textCampaignKey };
  }

  async spendDobTry(contactId: string, tokenHash: string, limit: number): Promise<number | null> {
    const c = this.contacts.get(contactId);
    const t = c ? this.textOf(c) : null;
    if (!c || !t || t.token_hash !== tokenHash) return null;
    const tries = t.dob_tries ?? 0;
    if (tries >= limit) return null;
    c.customData = { ...c.customData, [OUTREACH_TEXT_KEY]: { ...t, dob_tries: tries + 1 } };
    return tries + 1;
  }

  async claimLinkBooking(contactId: string, tokenHash: string, now: Date, staleBefore: Date): Promise<boolean> {
    const c = this.contacts.get(contactId);
    const t = c ? this.textOf(c) : null;
    if (!c || !t || t.token_hash !== tokenHash || t.booked_at) return false;
    if (t.booking_started_at && new Date(t.booking_started_at).getTime() >= staleBefore.getTime()) return false;
    c.customData = { ...c.customData, [OUTREACH_TEXT_KEY]: { ...t, booking_started_at: now.toISOString() } };
    return true;
  }

  async clearSmsStop(phone: string): Promise<void> {
    const key = dncKey(phone);
    if (key) this.channelDnc.setSms(key, false);
  }

  // ── The booking confirmation (v221) ──
  private confirmationOf(c: ContactRow): BookingConfirmationRecord | null {
    const t = c.customData[OUTREACH_TEXT_KEY];
    if (!t || typeof t !== "object") return null;
    const r = (t as Record<string, unknown>)[CONFIRMATION_FIELD];
    return r && typeof r === "object" ? (r as BookingConfirmationRecord) : null;
  }

  private writeConfirmation(c: ContactRow, record: BookingConfirmationRecord): void {
    const t = c.customData[OUTREACH_TEXT_KEY];
    const base = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
    c.customData = { ...c.customData, [OUTREACH_TEXT_KEY]: { ...base, [CONFIRMATION_FIELD]: record } };
  }

  private confirmationDue(c: ContactRow, now: Date): boolean {
    const r = this.confirmationOf(c);
    if (!r || (r.state !== "due" && r.state !== "retry")) return false;
    const at = r.retry_after ?? r.due_at;
    return !!at && new Date(at).getTime() <= now.getTime();
  }

  /** How many confirmation claims landed, for the "never twice" tests. */
  confirmationClaims = 0;

  async queueConfirmation(contactId: string, record: BookingConfirmationRecord): Promise<boolean> {
    const c = this.contacts.get(contactId);
    if (!c) return false;
    const held = this.confirmationOf(c);
    if (held && held.booking_id === record.booking_id) return false;
    this.writeConfirmation(c, { ...record });
    return true;
  }

  async confirmationsDue(campaignId: string, now: Date, limit: number): Promise<ContactRow[]> {
    return [...this.contacts.values()]
      .filter((c) => c.campaignId === campaignId && this.confirmationDue(c, now))
      .slice(0, limit)
      .map((c) => ({ ...c, customData: { ...c.customData } }));
  }

  async claimConfirmation(contactId: string, now: Date): Promise<ContactRow | null> {
    const c = this.contacts.get(contactId);
    if (!c || !this.confirmationDue(c, now)) return null;
    this.writeConfirmation(c, { ...this.confirmationOf(c)!, state: "claimed", claimed_at: now.toISOString() });
    this.confirmationClaims += 1;
    return { ...c, customData: { ...c.customData } };
  }

  async patchConfirmation(contactId: string, patch: Partial<BookingConfirmationRecord>): Promise<void> {
    const c = this.contacts.get(contactId);
    const r = c ? this.confirmationOf(c) : null;
    if (!c || !r) return;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    this.writeConfirmation(c, { ...r, ...defined } as BookingConfirmationRecord);
  }

  async holdConfirmation(contactId: string, bookingId: string, reason: string): Promise<boolean> {
    const c = this.contacts.get(contactId);
    const r = c ? this.confirmationOf(c) : null;
    if (!c || !r || r.booking_id !== bookingId || (r.state !== "due" && r.state !== "retry")) return false;
    this.writeConfirmation(c, { ...r, state: "held", reason });
    return true;
  }
}
