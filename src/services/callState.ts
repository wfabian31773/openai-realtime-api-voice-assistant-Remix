/**
 * CALL STATE — one normalized view of a live call, not twenty internal Maps.
 *
 * Everything that decides how a call goes is currently spread across ~20
 * per-call Maps (director ledger, loop-guard counts, identity attempts, tool
 * timeline, verified-call set, transfer targets…). Each is correct on its own
 * and none of them is readable while the call is happening, so the only way to
 * answer "why is the agent asking that?" has been to read source and guess.
 *
 * Three separate wrong conclusions in the 2026-08-04/05 review came from that:
 * calls that used tools reading as "No tools used", a director loop plainly
 * audible in the transcript but absent from its telemetry, and — mine — reading
 * a deploy as not-live off stale rows.
 *
 * So: a PROJECTION. One state object per call, updated by normalized events,
 * readable at any instant. It does not replace the Maps that drive behaviour —
 * ripping those out live, on a PHI system, is exactly the change that has gone
 * wrong twice here. It becomes the single thing you READ, and the single thing
 * INVARIANTS are checked against.
 *
 * ── The authoritative-identity rule ────────────────────────────────────────
 * `verify_patient_identity` succeeding is a FACT, arriving from the Eye Care
 * service, which holds the personId. It enters here as ONE normalized event:
 *
 *     { type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true }
 *
 * Nothing downstream re-derives it from the transcript. That inference is what
 * interrupted 22 of 54 verified callers on 08-03.
 *
 * ── Invariants ────────────────────────────────────────────────────────────
 * An invariant is a rule the agent cannot violate, evaluated against this state
 * rather than hoped for in a prompt. Once identity is verified, the patient-type
 * / DOB / surname questions are CLOSED — asking one is a violation, recorded
 * with a name, until verification is explicitly invalidated. See INVARIANTS.
 */

export type PatientType = 'existing' | 'new' | 'unknown';
export type ToolStatus = 'pending' | 'success' | 'error';

/** Canonical ask topics — the same strings conversationLoopGuard classifies to,
 *  so the two never drift. */
export type AskTopic = string;

export interface ToolResult {
  status: ToolStatus;
  at: string;
  /** Short, non-PHI outcome word: 'verified', 'no_match', 'identity_required'. */
  detail?: string;
}

export interface Violation {
  /** Stable machine name, e.g. 'patient_type_reasked_after_verification'. */
  invariant: string;
  topic: AskTopic;
  at: string;
  /** The agent line that violated it, redacted when PHI logging is off. */
  line?: string;
}

export interface DirectorDecision {
  code: string;
  topic: string;
  enforcement: string;
  at: string;
}

export interface CallState {
  callId: string;
  agentSlug: string;
  startedAt: string;
  updatedAt: string;
  /** Monotonic; a client can tell "nothing changed" without diffing. */
  seq: number;

  caller: {
    /** Caller-ID pre-context found a record. NOT identity — see identity. */
    phoneMatched: boolean;
    matchedName: string | null;
  };

  identity: {
    nameSupplied: string | null;
    dobSupplied: string | null;
    /** Eye Care holds the personId for this call. Authoritative. */
    personVerified: boolean;
    identityVerified: boolean;
    patientType: PatientType;
    verifiedAt: string | null;
    /** Set when verification is explicitly withdrawn — the only thing that
     *  reopens the closed questions. */
    invalidatedAt: string | null;
    invalidatedReason: string | null;
  };

  conversation: {
    intent: string | null;
    pendingAsk: AskTopic | null;
    askCounts: Record<AskTopic, number>;
    /** Field names the caller has answered. Names only, never values. */
    answered: AskTopic[];
  };

  tools: Record<string, ToolResult>;

  director: {
    lastDecision: DirectorDecision | null;
    decisionCount: number;
    /** What the agent should be doing next, derived from state. */
    nextExpectedAction: string | null;
    /** Questions that are CLOSED right now, derived from the invariants. */
    prohibitedQuestions: AskTopic[];
  };

  violations: Violation[];
}

export type CallStateEvent =
  | { type: 'CALL_STARTED'; agentSlug: string; at?: string }
  | { type: 'CALLER_MATCHED'; phoneMatched: boolean; matchedName?: string | null }
  | { type: 'FIELD_SUPPLIED'; field: AskTopic; value?: string | null }
  | { type: 'AGENT_ASKED'; topic: AskTopic; line?: string }
  | { type: 'INTENT_SET'; intent: string }
  | { type: 'TOOL_RESULT'; tool: string; status: ToolStatus; detail?: string }
  | { type: 'IDENTITY_VERIFIED'; patientType: PatientType; personVerified: boolean; name?: string | null; dob?: string | null }
  | { type: 'IDENTITY_INVALIDATED'; reason: string }
  | { type: 'DIRECTOR_DECISION'; code: string; topic: string; enforcement: string };

/**
 * INVARIANTS — rules the agent cannot violate.
 *
 * `when` reads the state; `prohibits` lists the ask topics that are closed while
 * it holds. A prohibited ask is a named violation, not a judgement call.
 */
export interface Invariant {
  id: string;
  when: (s: CallState) => boolean;
  prohibits: AskTopic[];
  /** Shown to the model when it violates the rule. */
  because: string;
}

export const INVARIANTS: Invariant[] = [
  {
    id: 'identity_reasked_after_verification',
    // Explicit invalidation is the ONLY thing that reopens these. That is the
    // escape hatch: a caller who turns out to be someone else invalidates, and
    // the questions become askable again.
    when: (s) => s.identity.identityVerified && !s.identity.invalidatedAt,
    prohibits: ['existing patient', 'date of birth', 'last name', 'first name', 'full name'],
    because:
      'The Eye Care service has already verified who this caller is on this call. ' +
      'Their name, date of birth and whether they are an existing patient are settled ' +
      'facts — re-asking any of them is the single most common loop complaint in the ' +
      'call audits. Use what the server verified and move to what the caller wants.',
  },
  {
    id: 'patient_type_asked_at_all',
    // The prompt is explicit: "NEVER ask 'Have you been seen here before?' as a
    // routing question; the LOOKUP routes, not the caller's memory."
    when: (s) => s.tools['verify_patient_identity']?.status === 'success',
    prohibits: ['existing patient'],
    because:
      'The lookup routes, not the caller\'s memory. verify_patient_identity has already ' +
      'answered whether this person has a record.',
  },
];

/** Ask topics that are closed right now. */
export function prohibitedQuestions(s: CallState): AskTopic[] {
  const out = new Set<AskTopic>();
  for (const inv of INVARIANTS) {
    if (!inv.when(s)) continue;
    for (const t of inv.prohibits) out.add(t);
  }
  return [...out];
}

/** Which invariant, if any, this ask breaks. */
export function checkAsk(s: CallState, topic: AskTopic): Invariant | null {
  for (const inv of INVARIANTS) {
    if (inv.when(s) && inv.prohibits.includes(topic)) return inv;
  }
  return null;
}

/**
 * What the agent ought to be doing next. Deliberately simple and derived — a
 * reviewer watching a live call needs "should be asking for the office", not a
 * plan tree.
 */
export function nextExpectedAction(s: CallState): string | null {
  if (!s.identity.identityVerified) {
    if (!s.identity.nameSupplied) return 'collect last name';
    if (!s.identity.dobSupplied) return 'collect date of birth';
    if (s.tools['verify_patient_identity']?.status !== 'success') return 'call verify_patient_identity';
  }
  if (!s.conversation.intent) return 'establish what the caller wants';
  if (s.conversation.pendingAsk) return `awaiting ${s.conversation.pendingAsk}`;
  return null;
}

function emptyState(callId: string, agentSlug: string, at: string): CallState {
  return {
    callId,
    agentSlug,
    startedAt: at,
    updatedAt: at,
    seq: 0,
    caller: { phoneMatched: false, matchedName: null },
    identity: {
      nameSupplied: null,
      dobSupplied: null,
      personVerified: false,
      identityVerified: false,
      patientType: 'unknown',
      verifiedAt: null,
      invalidatedAt: null,
      invalidatedReason: null,
    },
    conversation: { intent: null, pendingAsk: null, askCounts: {}, answered: [] },
    tools: {},
    director: { lastDecision: null, decisionCount: 0, nextExpectedAction: null, prohibitedQuestions: [] },
    violations: [],
  };
}

/**
 * The reducer. Pure: same state + event always yields the same next state, so
 * a call can be replayed from its event log and the result compared.
 */
export function reduce(prev: CallState, ev: CallStateEvent, at: string): CallState {
  const s: CallState = {
    ...prev,
    caller: { ...prev.caller },
    identity: { ...prev.identity },
    conversation: {
      ...prev.conversation,
      askCounts: { ...prev.conversation.askCounts },
      answered: [...prev.conversation.answered],
    },
    tools: { ...prev.tools },
    director: { ...prev.director },
    violations: [...prev.violations],
    updatedAt: at,
    seq: prev.seq + 1,
  };

  switch (ev.type) {
    case 'CALL_STARTED':
      s.agentSlug = ev.agentSlug;
      break;

    case 'CALLER_MATCHED':
      s.caller.phoneMatched = ev.phoneMatched;
      s.caller.matchedName = ev.matchedName ?? null;
      break;

    case 'FIELD_SUPPLIED':
      if (!s.conversation.answered.includes(ev.field)) s.conversation.answered.push(ev.field);
      if (ev.field === 'date of birth') s.identity.dobSupplied = ev.value ?? s.identity.dobSupplied;
      if (ev.field === 'last name' || ev.field === 'full name') {
        s.identity.nameSupplied = ev.value ?? s.identity.nameSupplied;
      }
      // The caller answered it, so it is no longer outstanding.
      if (s.conversation.pendingAsk === ev.field) s.conversation.pendingAsk = null;
      break;

    case 'AGENT_ASKED':
      s.conversation.askCounts[ev.topic] = (s.conversation.askCounts[ev.topic] ?? 0) + 1;
      s.conversation.pendingAsk = ev.topic;
      break;

    case 'INTENT_SET':
      s.conversation.intent = ev.intent;
      break;

    case 'TOOL_RESULT':
      s.tools[ev.tool] = { status: ev.status, at, ...(ev.detail ? { detail: ev.detail } : {}) };
      break;

    case 'IDENTITY_VERIFIED':
      // ONE event, from the service that actually knows. Nothing re-derives it.
      s.identity.personVerified = ev.personVerified;
      s.identity.identityVerified = ev.personVerified;
      s.identity.patientType = ev.patientType;
      s.identity.verifiedAt = at;
      s.identity.invalidatedAt = null;
      s.identity.invalidatedReason = null;
      if (ev.name) s.identity.nameSupplied = ev.name;
      if (ev.dob) s.identity.dobSupplied = ev.dob;
      break;

    case 'IDENTITY_INVALIDATED':
      s.identity.identityVerified = false;
      s.identity.personVerified = false;
      s.identity.invalidatedAt = at;
      s.identity.invalidatedReason = ev.reason;
      break;

    case 'DIRECTOR_DECISION':
      s.director.lastDecision = { code: ev.code, topic: ev.topic, enforcement: ev.enforcement, at };
      s.director.decisionCount += 1;
      break;
  }

  // Derived fields, recomputed on every event so a reader never sees them stale.
  s.director.prohibitedQuestions = prohibitedQuestions(s);
  s.director.nextExpectedAction = nextExpectedAction(s);

  // An ask that breaks an invariant is recorded as a named violation. Done here
  // rather than at the call site so it cannot be forgotten by a new caller.
  if (ev.type === 'AGENT_ASKED') {
    const broken = checkAsk(prev, ev.topic);
    if (broken) {
      s.violations.push({ invariant: broken.id, topic: ev.topic, at, ...(ev.line ? { line: ev.line } : {}) });
    }
  }

  return s;
}

/** One row of the per-turn timeline: what the state was, and what produced it. */
export interface StateSnapshot {
  at: string;
  seq: number;
  /** 'caller' | 'agent' | 'tool' | 'director' | 'system' */
  source: string;
  /** The line or tool name that caused this snapshot. */
  label: string;
  state: CallState;
  directorDecision: DirectorDecision | null;
  violation: Violation | null;
}

/** Keep the tail; a long call must not grow without bound. */
const MAX_SNAPSHOTS = 200;

export class CallStateStore {
  private states = new Map<string, CallState>();
  private snaps = new Map<string, StateSnapshot[]>();
  constructor(private now: () => string = () => new Date().toISOString()) {}

  /** Apply an event and return the new state. Never throws. */
  apply(callId: string, agentSlug: string, ev: CallStateEvent, label = ''): CallState | null {
    try {
      if (!callId) return null;
      const at = this.now();
      const prev = this.states.get(callId) ?? emptyState(callId, agentSlug, at);
      const next = reduce(prev, ev, at);
      this.states.set(callId, next);

      const violation = next.violations.length > prev.violations.length
        ? next.violations[next.violations.length - 1]
        : null;
      const list = this.snaps.get(callId) ?? [];
      list.push({
        at,
        seq: next.seq,
        source: sourceOf(ev),
        label: label || labelOf(ev),
        state: next,
        directorDecision: ev.type === 'DIRECTOR_DECISION' ? next.director.lastDecision : null,
        violation,
      });
      if (list.length > MAX_SNAPSHOTS) list.splice(0, list.length - MAX_SNAPSHOTS);
      this.snaps.set(callId, list);
      return next;
    } catch {
      return null; // state bookkeeping must never break a call
    }
  }

  get(callId: string): CallState | null {
    return this.states.get(callId) ?? null;
  }

  snapshots(callId: string): StateSnapshot[] {
    return this.snaps.get(callId) ?? [];
  }

  /** Resolve by any id the call is known by. */
  find(idOrSid: string, alias?: (id: string) => string | undefined): CallState | null {
    const direct = this.states.get(idOrSid);
    if (direct) return direct;
    const mapped = alias?.(idOrSid);
    return mapped ? this.states.get(mapped) ?? null : null;
  }

  release(callId: string | undefined): void {
    if (!callId) return;
    this.states.delete(callId);
    this.snaps.delete(callId);
  }

  /** Test/telemetry view. */
  activeCallIds(): string[] {
    return [...this.states.keys()];
  }
}

function sourceOf(ev: CallStateEvent): string {
  switch (ev.type) {
    case 'FIELD_SUPPLIED': return 'caller';
    case 'AGENT_ASKED': return 'agent';
    case 'TOOL_RESULT':
    case 'IDENTITY_VERIFIED':
    case 'IDENTITY_INVALIDATED': return 'tool';
    case 'DIRECTOR_DECISION': return 'director';
    default: return 'system';
  }
}

function labelOf(ev: CallStateEvent): string {
  switch (ev.type) {
    case 'FIELD_SUPPLIED': return ev.field;
    case 'AGENT_ASKED': return `ask:${ev.topic}`;
    case 'TOOL_RESULT': return `${ev.tool}=${ev.status}`;
    case 'IDENTITY_VERIFIED': return `identity_verified:${ev.patientType}`;
    case 'IDENTITY_INVALIDATED': return `identity_invalidated:${ev.reason}`;
    case 'DIRECTOR_DECISION': return `${ev.enforcement}:${ev.code}`;
    case 'INTENT_SET': return `intent:${ev.intent}`;
    default: return ev.type.toLowerCase();
  }
}

/**
 * PHI. The dashboard is authenticated and the operator needs real values to
 * judge a call ("is it hearing the surname right?"). Logs and any unauthenticated
 * surface get this instead — the SHAPE, never the values, matching the rule
 * SAFE_ARG_KEYS already enforces on the tool timeline.
 */
export function redactState(s: CallState): CallState {
  return {
    ...s,
    caller: { ...s.caller, matchedName: s.caller.matchedName ? '[REDACTED]' : null },
    identity: {
      ...s.identity,
      nameSupplied: s.identity.nameSupplied ? '[REDACTED]' : null,
      dobSupplied: s.identity.dobSupplied ? '[REDACTED]' : null,
    },
    violations: s.violations.map((v) => ({ ...v, line: v.line ? '[REDACTED]' : undefined })),
  };
}

/** One-line log form for the per-turn record. No PHI. */
export function stateLogLine(s: CallState): string {
  const c = s.conversation;
  return (
    `seq=${s.seq} verified=${s.identity.identityVerified} type=${s.identity.patientType} ` +
    `intent=${c.intent ?? '-'} pendingAsk=${c.pendingAsk ?? '-'} ` +
    `asks={${Object.entries(c.askCounts).map(([k, v]) => `${k}:${v}`).join(',')}} ` +
    `next=${s.director.nextExpectedAction ?? '-'} violations=${s.violations.length}`
  );
}

export const callStateStore = new CallStateStore();
