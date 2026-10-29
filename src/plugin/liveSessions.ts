/** Process-local controls. Operator transcripts also have a durable snapshot. */
import { randomUUID } from "node:crypto";
import type { TranscriptTurn } from "../runtime/transcriptLog";
import type { OperatorCallPayload } from "./operatorLine";
import type { OperatorCallRecord } from "./store";

export type LiveCallStatus = "dialing" | "ringing" | "in_progress" | "completed" | "failed" | "no_answer";
export const LIVE_RETENTION_MS = 2 * 60 * 1000;
const LIVE_MAX_MS = 30 * 60 * 1000;
const TERMINAL = new Set<LiveCallStatus>(["completed", "failed", "no_answer"]);

export interface LiveCallControls {
  turns(): TranscriptTurn[];
  instruct(text: string): void;
  end(): void;
}

export interface LiveCallSession {
  sessionId: string;
  approvalId: string | null;
  tokenJti: string;
  contactId: string;
  attemptId: string;
  callSid: string | null;
  status: LiveCallStatus;
  startedAt: Date;
  endedAt: Date | null;
  turns: TranscriptTurn[];
  directCall?: { purpose: string; name?: string };
  operatorCall?: OperatorCallPayload;
  hardStop?: (callSid: string) => Promise<unknown>;
  persist?: (record: OperatorCallRecord) => Promise<void>;
  persistence?: Promise<void>;
  deadlineExceeded?: boolean;
  controls?: LiveCallControls;
  timer?: ReturnType<typeof setTimeout>;
}

export class LiveCallRegistry {
  private sessions = new Map<string, LiveCallSession>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  create(input: Pick<LiveCallSession, "approvalId" | "tokenJti" | "contactId" | "attemptId" | "directCall" | "operatorCall" | "hardStop" | "persist">): LiveCallSession {
    const session: LiveCallSession = {
      ...input, sessionId: randomUUID(), callSid: null, status: "dialing",
      startedAt: this.now(), endedAt: null, turns: [],
    };
    this.sessions.set(session.sessionId, session);
    session.timer = setTimeout(() => {
      const end = session.controls?.end;
      session.deadlineExceeded = true;
      if (session.callSid) void session.hardStop?.(session.callSid).catch(() => {
        console.error("[operator-line] hard stop REST hangup failed; provider timeLimit remains active");
      });
      this.setStatus(session.sessionId, "failed");
      end?.();
    }, session.operatorCall ? session.operatorCall.maxDurationSec * 1000 : LIVE_MAX_MS);
    session.timer.unref?.();
    return session;
  }

  get(sessionId: string): LiveCallSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.endedAt && this.now().getTime() - session.endedAt.getTime() >= LIVE_RETENTION_MS) {
      this.drop(sessionId);
      return null;
    }
    return session;
  }

  owned(sessionId: string, tokenJti: string): LiveCallSession | null {
    const session = this.get(sessionId);
    return session?.tokenJti === tokenJti ? session : null;
  }

  forCall(callSid: string): LiveCallSession | null {
    for (const session of this.sessions.values()) {
      if (session.callSid === callSid) return this.get(session.sessionId);
    }
    return null;
  }

  bindCall(sessionId: string, callSid: string): boolean {
    const session = this.get(sessionId);
    if (!session || !callSid || (session.callSid && session.callSid !== callSid)) return false;
    session.callSid = callSid;
    // A create response / signed callback may arrive after the deadline.
    if (session.deadlineExceeded && session.operatorCall) void session.hardStop?.(callSid).catch(() => undefined);
    this.persist(session);
    return true;
  }

  attach(callSid: string, controls: LiveCallControls): void {
    const session = this.forCall(callSid);
    if (!session || session.endedAt) { controls.end(); return; }
    session.controls = controls;
    this.setStatus(session.sessionId, "in_progress");
  }

  setStatus(sessionId: string, status: LiveCallStatus): void {
    const session = this.get(sessionId);
    if (!session || session.endedAt) return;
    // Progress callbacks can arrive out of order.
    const rank = { dialing: 0, ringing: 1, in_progress: 2, completed: 3, failed: 3, no_answer: 3 };
    if (rank[status] < rank[session.status]) return;
    session.status = status;
    if (TERMINAL.has(status)) {
      session.turns = session.controls?.turns() ?? session.turns;
      session.controls = undefined;
      session.endedAt = this.now();
      clearTimeout(session.timer);
      session.timer = setTimeout(() => this.drop(sessionId), LIVE_RETENTION_MS);
      session.timer.unref?.();
    }
    this.persist(session);
  }

  /** Serialized snapshots prevent a delayed progress write replacing the final transcript. */
  persist(session: LiveCallSession): Promise<void> {
    if (!session.persist || !session.approvalId) return Promise.resolve();
    const record: OperatorCallRecord = {
      initiatedBy: session.operatorCall?.initiated_by ?? "bot_initiative",
      sessionId: session.sessionId, approvalId: session.approvalId, tokenJti: session.tokenJti,
      callSid: session.callSid, status: session.status, startedAt: session.startedAt, endedAt: session.endedAt,
      turns: (session.controls?.turns() ?? session.turns).map((turn) => ({ ...turn })),
    };
    const save = session.persist;
    session.persistence = (session.persistence ?? Promise.resolve()).catch(() => undefined).then(() => save(record));
    void session.persistence.catch(() => console.error("[operator-line] transcript persistence failed"));
    return session.persistence;
  }

  /** Bridge finalization can amend an interrupted final line after a REST hangup. */
  finishTranscript(callSid: string, turns: TranscriptTurn[]): void {
    const session = this.forCall(callSid);
    if (!session?.operatorCall) return;
    session.turns = turns.map((turn) => ({ ...turn }));
    this.persist(session);
  }

  view(session: LiveCallSession, after = -1) {
    const turns = session.controls?.turns() ?? session.turns;
    return {
      status: session.status, callSid: session.callSid,
      ...(session.operatorCall ? { initiated_by: session.operatorCall.initiated_by ?? "bot_initiative" } : {}),
      startedAt: session.startedAt.toISOString(), endedAt: session.endedAt?.toISOString() ?? null,
      transcript: turns.slice(after + 1).map((turn) => ({ role: turn.role, text: turn.text, at: new Date(turn.atMs).toISOString() })),
      nextAfter: turns.length - 1,
    };
  }

  clear(): void {
    for (const id of this.sessions.keys()) this.drop(id);
  }

  drop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      clearTimeout(session.timer);
      session.turns = [];
      session.controls = undefined;
      this.sessions.delete(sessionId);
    }
  }
}

// Statically imported by both API and runtime: one registry in this process.
export const liveCallRegistry = new LiveCallRegistry();
