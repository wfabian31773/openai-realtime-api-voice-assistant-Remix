/**
 * An in-memory OnCallStore with the same rules as the SQL one: one escalation
 * per call, version-checked writes, a lease on claimed rows, an attempt ended
 * once, and the patient details dropped at a terminal status. Tests only.
 */
import type {
  AttemptRow,
  EscalationPatch,
  EscalationRow,
  NewAttempt,
  NewEscalation,
  OnCallStore,
} from "./store";
import type { RotationData } from "./rotation";

export interface FakeOnCallStore extends OnCallStore {
  escalations: Map<number, EscalationRow & { leaseUntil: Date | null }>;
  attempts: Map<number, AttemptRow>;
  rotation: RotationData;
  /** Make every write after this throw (a Hub outage). */
  failWrites: boolean;
  tablesPresent: boolean;
}

export function createFakeOnCallStore(rotation: RotationData, now: () => Date = () => new Date()): FakeOnCallStore {
  let escId = 0;
  let attId = 0;
  const escalations = new Map<number, EscalationRow & { leaseUntil: Date | null }>();
  const attempts = new Map<number, AttemptRow>();

  const strip = (e: EscalationRow & { leaseUntil: Date | null }): EscalationRow => {
    const { leaseUntil: _lease, ...rest } = e;
    return structuredClone(rest);
  };

  const apply = (id: number, version: number, p: EscalationPatch, terminal: boolean): EscalationRow | null => {
    if (store.failWrites) throw new Error("fake store: writes failing");
    const e = escalations.get(id);
    if (!e || e.version !== version) return null;
    if (p.status !== undefined) e.status = p.status;
    if (p.levelIndex !== undefined) e.levelIndex = p.levelIndex;
    if (p.attemptNo !== undefined) e.attemptNo = p.attemptNo;
    if (p.phase !== undefined) e.phase = p.phase;
    if ("nextAt" in p) e.nextAt = p.nextAt ?? null;
    if (p.levelStartedAt) e.levelStartedAt = p.levelStartedAt;
    if ("acceptedBy" in p || "acceptedAt" in p) {
      e.acceptedBy = p.acceptedBy ?? null;
      e.acceptedAt = p.acceptedAt ?? null;
    }
    if (p.releaseLease || terminal) e.leaseUntil = null;
    if (terminal) {
      e.details = null;
      e.callerNumber = null;
    }
    e.version += 1;
    return strip(e);
  };

  const store: FakeOnCallStore = {
    escalations,
    attempts,
    rotation,
    failWrites: false,
    tablesPresent: true,
    async available() {
      return store.tablesPresent;
    },
    async loadRotation() {
      return store.rotation;
    },
    async openEscalation(n: NewEscalation) {
      if (store.failWrites) throw new Error("fake store: writes failing");
      for (const e of escalations.values()) if (e.callSid === n.callSid) return null;
      const row = {
        id: ++escId,
        callSid: n.callSid,
        mode: n.mode,
        status: "active" as const,
        levelIndex: 0,
        attemptNo: n.attemptNo,
        phase: "due" as const,
        nextAt: n.nextAt,
        levelStartedAt: n.levelStartedAt,
        routing: structuredClone(n.routing),
        plan: structuredClone(n.plan),
        details: n.details ? { ...n.details } : null,
        callerNumber: n.callerNumber,
        acceptedBy: null,
        acceptedAt: null,
        version: 0,
        createdAt: now(),
        leaseUntil: null,
      };
      escalations.set(row.id, row);
      return strip(row);
    },
    async getEscalation(id) {
      const e = escalations.get(id);
      return e ? strip(e) : null;
    },
    async getEscalationByCall(callSid) {
      for (const e of escalations.values()) if (e.callSid === callSid) return strip(e);
      return null;
    },
    async claimDue(at, leaseMs, limit) {
      if (store.failWrites) throw new Error("fake store: writes failing");
      const due = [...escalations.values()]
        .filter(
          (e) =>
            e.status === "active" &&
            e.nextAt !== null &&
            e.nextAt.getTime() <= at.getTime() &&
            (e.leaseUntil === null || e.leaseUntil.getTime() < at.getTime()),
        )
        .sort((a, b) => a.nextAt!.getTime() - b.nextAt!.getTime())
        .slice(0, limit);
      for (const e of due) {
        e.leaseUntil = new Date(at.getTime() + leaseMs);
        e.version += 1;
      }
      return due.map(strip);
    },
    async updateEscalation(id, version, patch) {
      return apply(id, version, patch, false);
    },
    async closeEscalation(id, version, patch) {
      return apply(id, version, patch, true);
    },
    async logAttempt(a: NewAttempt) {
      if (store.failWrites) throw new Error("fake store: writes failing");
      const row: AttemptRow = {
        id: ++attId,
        escalationId: a.escalationId,
        callSid: a.callSid,
        levelIndex: a.levelIndex,
        role: a.role,
        providerId: a.providerId,
        kind: a.kind,
        attemptNo: a.attemptNo,
        mode: a.mode,
        dialedTo: a.dialedTo,
        outcome: a.outcome ?? "in_progress",
        providerCallSid: a.providerCallSid ?? null,
        smsSid: a.smsSid ?? null,
        routingReason: a.routingReason ?? null,
        startedAt: now(),
        endedAt: a.endedAt ?? null,
      };
      attempts.set(row.id, row);
      return { ...row };
    },
    async setAttemptCallSid(attemptId, sid) {
      const a = attempts.get(attemptId);
      if (a) a.providerCallSid = sid;
    },
    async endAttempt(attemptId, outcome, at) {
      if (store.failWrites) throw new Error("fake store: writes failing");
      const a = attempts.get(attemptId);
      if (!a || a.outcome !== "in_progress") return null;
      a.outcome = outcome;
      a.endedAt = at;
      return { ...a };
    },
    async getAttempt(attemptId) {
      const a = attempts.get(attemptId);
      return a ? { ...a } : null;
    },
    async attemptsFor(callSid) {
      return [...attempts.values()].filter((a) => a.callSid === callSid).map((a) => ({ ...a }));
    },
  };
  return store;
}
