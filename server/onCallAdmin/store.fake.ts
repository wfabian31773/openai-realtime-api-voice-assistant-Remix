/**
 * An in-memory OnCallAdminStore for tests. `transaction` snapshots the state
 * and restores it when the callback throws, the way ROLLBACK does, so a test
 * can make the audit insert fail and see that the change did not land.
 */
import type { AttemptLite, CallLogLite, EscalationLite, OverrideRow, ScheduleRow } from "./logic";
import type {
  AdminProvider,
  AuditEntry,
  AuditRow,
  CallBundleRaw,
  DirectorRow,
  OnCallAdminStore,
  OnCallAdminTx,
} from "./store";

export interface FakeState {
  providers: AdminProvider[];
  directors: DirectorRow[];
  schedule: ScheduleRow[];
  overrides: OverrideRow[];
  audit: AuditRow[];
  escalations: EscalationLite[];
  attempts: Array<AttemptLite & { escalationId: number; callSid: string }>;
  callLogs: CallLogLite[];
}

export interface FakeOptions {
  rotationTables?: boolean;
  adminTables?: boolean;
  /** Throw from the audit insert (to prove the change rolls back with it). */
  failAudit?: boolean;
}

function clone(s: FakeState): FakeState {
  return {
    providers: s.providers.map((p) => ({ ...p })),
    directors: s.directors.map((d) => ({ ...d })),
    schedule: s.schedule.map((r) => ({ ...r })),
    overrides: s.overrides.map((o) => ({ ...o })),
    audit: s.audit.map((a) => ({ ...a })),
    escalations: s.escalations,
    attempts: s.attempts,
    callLogs: s.callLogs,
  };
}

export function emptyFakeState(): FakeState {
  return { providers: [], directors: [], schedule: [], overrides: [], audit: [], escalations: [], attempts: [], callLogs: [] };
}

export class FakeOnCallAdminStore implements OnCallAdminStore {
  state: FakeState;
  opts: FakeOptions;
  transactions = 0;
  private nextId = { provider: 1000, override: 5000, audit: 1 };

  constructor(state: FakeState = emptyFakeState(), opts: FakeOptions = {}) {
    this.state = state;
    this.opts = { rotationTables: true, adminTables: true, ...opts };
  }

  async tables() {
    const missing: string[] = [];
    if (!this.opts.rotationTables) missing.push("on_call_providers");
    if (!this.opts.adminTables) missing.push("on_call_audit_log");
    return { rotation: Boolean(this.opts.rotationTables), admin: Boolean(this.opts.adminTables), missing };
  }

  private guard() {
    if (!this.opts.rotationTables) throw new Error('relation "on_call_providers" does not exist');
  }

  async providers() {
    this.guard();
    return this.state.providers.map((p) => ({ ...p }));
  }
  async directors() {
    this.guard();
    return this.state.directors.map((d) => ({ ...d }));
  }
  async schedule() {
    this.guard();
    return [...this.state.schedule].sort((a, b) => a.week.localeCompare(b.week)).map((r) => ({ ...r }));
  }
  async overrides() {
    this.guard();
    return this.state.overrides.map((o) => ({ ...o }));
  }
  async providerReferenced(id: number) {
    const s = this.state;
    return (
      s.schedule.some((r) => r.providerId === id) ||
      s.overrides.some((o) => o.providerId === id) ||
      s.directors.some((d) => d.providerId === id) ||
      s.attempts.some((a) => a.providerId === id) ||
      s.escalations.some((e) => e.acceptedBy === id || (e.plan?.levels ?? []).some((l) => l.providerId === id))
    );
  }

  async transaction<T>(fn: (tx: OnCallAdminTx) => Promise<T>): Promise<T> {
    this.transactions++;
    const before = clone(this.state);
    const st = this.state;
    const self = this;
    const tx: OnCallAdminTx = {
      providers: () => this.providers(),
      directors: () => this.directors(),
      schedule: () => this.schedule(),
      overrides: () => this.overrides(),
      providerReferenced: (id) => this.providerReferenced(id),
      async setWeekProvider(week, providerId, note) {
        const r = st.schedule.find((x) => x.week === week);
        if (!r) return false;
        r.providerId = providerId;
        r.note = note;
        return true;
      },
      async insertWeek(week, providerId, note) {
        if (st.schedule.some((x) => x.week === week)) throw new Error("duplicate key week_starts_on");
        st.schedule.push({ week, providerId, note, updatedAt: null });
      },
      async insertOverride(o) {
        const row: OverrideRow = { id: self.nextId.override++, ...o, createdAt: new Date() };
        st.overrides.push(row);
        return { ...row };
      },
      async endOverride(id, at) {
        const o = st.overrides.find((x) => x.id === id);
        if (o) o.endsAt = at;
      },
      async deleteOverride(id) {
        st.overrides = st.overrides.filter((x) => x.id !== id);
      },
      async insertProvider(p) {
        if (p.rotationOrder !== null && st.providers.some((x) => x.rotationOrder === p.rotationOrder)) {
          throw new Error("duplicate key rotation_order");
        }
        const row: AdminProvider = { id: self.nextId.provider++, ...p, active: true, createdAt: null, updatedAt: null };
        st.providers.push(row);
        return { ...row };
      },
      async updateProvider(id, patch) {
        const p = st.providers.find((x) => x.id === id);
        if (!p) return null;
        if (
          patch.rotationOrder !== undefined &&
          patch.rotationOrder !== null &&
          st.providers.some((x) => x.id !== id && x.rotationOrder === patch.rotationOrder)
        ) {
          throw new Error("duplicate key rotation_order");
        }
        Object.assign(p, patch);
        return { ...p };
      },
      async deleteProvider(id) {
        st.providers = st.providers.filter((x) => x.id !== id);
      },
      async setRotationOrders(changes) {
        for (const c of changes) {
          const p = st.providers.find((x) => x.id === c.id);
          if (p) p.rotationOrder = null;
        }
        for (const c of changes) {
          if (st.providers.some((x) => x.rotationOrder === c.to)) throw new Error("duplicate key rotation_order");
          const p = st.providers.find((x) => x.id === c.id);
          if (p) p.rotationOrder = c.to;
        }
      },
      async setDirector(region, providerId) {
        const d = st.directors.find((x) => x.region === region);
        if (d) d.providerId = providerId;
        else st.directors.push({ region, providerId, updatedAt: null });
      },
      async deleteDirector(region) {
        st.directors = st.directors.filter((x) => x.region !== region);
      },
      async audit(e: AuditEntry) {
        if (self.opts.failAudit) throw new Error("audit insert failed");
        if (!self.opts.adminTables) throw new Error('relation "on_call_audit_log" does not exist');
        if (!e.reason.trim()) throw new Error("reason check");
        st.audit.push({ ...e, id: self.nextId.audit++, createdAt: new Date().toISOString() });
      },
    };
    try {
      return await fn(tx);
    } catch (e) {
      this.state = before;
      throw e;
    }
  }

  async auditLog(f: { entityType?: string; action?: string; actor?: string; limit: number }) {
    return this.state.audit
      .filter((a) => (!f.entityType || a.entityType === f.entityType) && (!f.action || a.action === f.action))
      .filter((a) => !f.actor || (a.actorEmail ?? "").includes(f.actor) || a.actorUserId === f.actor)
      .slice()
      .reverse()
      .slice(0, f.limit);
  }
  async escalations(f: { since: Date; until: Date; limit: number }) {
    return this.state.escalations.filter((e) => e.createdAt >= f.since && e.createdAt < f.until).slice(0, f.limit);
  }
  async attemptsForEscalations(ids: number[]) {
    return this.state.attempts.filter((a) => ids.includes(a.escalationId));
  }
  async callLogsBySid(sids: string[]) {
    return this.state.callLogs.filter((c) => c.callSid && sids.includes(c.callSid));
  }
  async urgentCallsWithoutChain() {
    return [];
  }
  async callBundle(callSid: string): Promise<CallBundleRaw> {
    return {
      callLog: this.state.callLogs.find((c) => c.callSid === callSid) ?? null,
      turns: [],
      callEvents: [],
      escalation: this.state.escalations.find((e) => e.callSid === callSid) ?? null,
      attempts: this.state.attempts.filter((a) => a.callSid === callSid),
      extraEvents: [],
    };
  }
}
