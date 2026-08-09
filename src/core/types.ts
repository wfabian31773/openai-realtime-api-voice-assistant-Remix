/**
 * The New Core — contracts (docs/rebuild/reconstruction-plan.md §3).
 *
 * A line module owns the WHOLE call as a state machine: every state has the
 * exact line to say, what it listens for, where the answer lands in the
 * call-facts ledger, and the single next state. The realtime model renders
 * speech and transcribes hearing — it decides nothing.
 *
 * Services are injected: real adapters in production, simulated ones in the
 * Gate A/B harnesses. A line module can only reach the capabilities its
 * services object carries — the capability matrix is enforced by what exists,
 * not by rules (an answering-service services object HAS no transfer).
 */

export interface CoreAction {
  /** Exact line to force, verbatim, this turn. Null = say nothing (rare). */
  say: string | null;
  /** Hang up after the line finishes playing. */
  endCall?: boolean;
  /** Ops alert to record (ticket fallback, sweep recovery, etc). */
  alert?: string;
  /**
   * Deferred completion for say-and-act states: the transport speaks `say`
   * (the wait line), awaits this, then forces the returned action's line.
   * Keeps promises and their actions in one unit while latency is covered.
   */
  followUp?: () => Promise<CoreAction>;
}

export interface ClassifyResult {
  departmentId: number; // 1=Optical, 2=Surgery, 3=Tech
  requestTypeId: number;
  requestReasonId: number;
  priority: 'low' | 'normal' | 'medium' | 'high' | 'urgent';
  locationId: number | null;
  providerId: number | null;
}

export interface TicketInput {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  callbackNumber: string;
  subject: string;
  description: string;
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
  priority: 'low' | 'normal' | 'medium' | 'high' | 'urgent';
  locationId?: number | null;
  providerId?: number | null;
  locationName?: string | null;
  providerName?: string | null;
  unresolvedInfo?: string | null;
}

export interface TicketResult {
  ok: boolean;
  ticketNumber?: string;
  error?: string;
}

/**
 * Everything an answering-service-class line may do. Note what is absent:
 * no transfer, no scheduling — asking a million times still won't reach one.
 */
export interface TicketLineServices {
  /** Name+DOB lookup — used ONLY when there is no matched-record DOB to compare against. */
  verifyByLookup(first: string, last: string, dob: string): Promise<boolean>;
  /** Pure-code request classification (config/answeringServiceTicketing). */
  classify(description: string): Promise<ClassifyResult>;
  fileTicket(input: TicketInput): Promise<TicketResult>;
}

export interface LineModule<S = unknown> {
  slug: string;
  /** Begin a call (after the enforced greeting has played). */
  start(callId: string): void;
  /** One caller utterance in → the exact next action out. Never throws. */
  onUtterance(callId: string, text: string): Promise<CoreAction>;
  /** Current state name, for the turn table / Observatory. */
  stateOf(callId: string): string | null;
  /**
   * Called when the call ends (caller hung up, transport closed) BEFORE
   * release. A caller who states a request and drops must still reach the
   * team: the module files what it has. Returns an ops alert if it couldn't.
   */
  finalize?(callId: string): Promise<{ filed: boolean; alert?: string }>;
  release(callId: string): void;
}
