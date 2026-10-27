/** Process-local live call state. No transcript or guidance is persisted. */
import { randomUUID } from "node:crypto";
import type { TranscriptTurn } from "../runtime/transcriptLog";

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
  approvalId: string;
  tokenJti: string;
  contactId: string;
  attemptId: string;
  callSid: string | null;
  status: LiveCallStatus;
  startedAt: Date;
  endedAt: Date | null;
  turns: TranscriptTurn[];
  controls?: LiveCallControls;
  timer?: ReturnType<typeof setTimeout>;
}

export class LiveCallRegistry {
  private sessions = new Map<string, LiveCallSession>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  create(input: Pick<LiveCallSession, "approvalId" | "tokenJti" | "contactId" | "attemptId">): LiveCallSession {
    const session: LiveCallSession = {
      ...input, sessionId: randomUUID(), callSid: null, status: "dialing",
      startedAt: this.now(), endedAt: null, turns: [],
    };
    this.sessions.set(session.sessionId, session);
    session.timer = setTimeout(() => {
      const end = session.controls?.end;
      this.setStatus(session.sessionId, "failed");
      end?.();
    }, LIVE_MAX_MS);
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
  }

  view(session: LiveCallSession, after = -1) {
    const turns = session.controls?.turns() ?? session.turns;
    return {
      status: session.status, callSid: session.callSid,
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
