/**
 * WHAT EACH AGENT CAN DO — asked, not remembered.
 *
 * Operator, 2026-08-15: *"do the refactor, capability based not slug lists."*
 *
 * THE FAILURE MODE THIS REPLACES. Until now every capability in the fleet was
 * expressed as a literal list of slugs, and the same capability was expressed
 * separately in each place that cared:
 *
 *   conversationLoopGuard  NO_TRANSFER_AGENTS   = {answering-service}
 *   callGradingService     NO_TRANSFER_AGENTS   = {answering-service, no-ivr,
 *                                                  after-hours, dev-no-ivr,
 *                                                  optical, surgery, tech, records}
 *   callGradingService     TICKET_ONLY_AGENTS   = {answering-service, no-ivr,
 *                                                  after-hours, dev-no-ivr}
 *   voiceAgentRoutes       (two inline literals) = {after-hours, no-ivr,
 *                                                   answering-service,
 *                                                   azul-scheduling, pcp}
 *
 * Four lists, four different answers, one question. Every one of them was
 * written when the answering service was the only tenant, and splitting it into
 * department queues meant each had to be revisited by hand. Several never were,
 * and the ones that were, I got wrong: I put `no-ivr` in a no-transfer set on
 * 08-13 when it is the one agent in the fleet that can transfer.
 *
 * The cost was not theoretical. Tech, Surgery, Optical and Records callers had
 * to ask for a human TWICE before being told the line cannot transfer, because
 * only the answering service was in the guard's list.
 *
 * THE RULE NOW: a capability is a property of the agent, declared once here.
 * Adding an agent is one entry. Nothing else needs editing, and nothing else
 * may keep its own list.
 *
 * AND IT IS CHECKED AGAINST REALITY. `agentCapabilities.test.ts` reads the
 * agent sources and verifies that every agent declaring `canTransfer` really
 * exposes the named tool, and that every agent declaring otherwise exposes no
 * transfer tool at all. A registry that can drift from the code is just a
 * fifth list; this one cannot drift without a test going red.
 */

export interface AgentCapability {
  /**
   * Can this agent connect the caller to a live human, by any mechanism?
   *
   * This is the question four separate lists were each answering differently.
   * It decides whether the agent may promise a transfer, how soon it owes the
   * caller the honest "I can't connect calls", and whether a grader should
   * read escalation language as a missed handoff or as a correctly-taken
   * message.
   */
  canTransfer: boolean;

  /**
   * The model-callable tool that performs the transfer — the EVIDENCE for
   * `canTransfer`, and what the conformance test greps for in the agent's
   * source. `null` when the agent cannot transfer.
   *
   * Naming the tool rather than storing a bare boolean is deliberate: a
   * boolean can be wrong and nothing notices, a tool name is checkable.
   */
  transferTool: string | null;

  /**
   * Does this agent file tickets that carry call data — recording, transcript,
   * duration — worth pushing to the ticketing system when the call ends?
   */
  filesTickets: boolean;

  /** Human-readable note for whoever reads this table next. */
  note: string;
}

/**
 * Every agent the router can build. Verified against the agent sources on
 * 2026-08-15 by reading each module for a model-callable transfer tool.
 */
export const AGENT_CAPABILITIES: Record<string, AgentCapability> = {
  // ── Lines that take a message and cannot connect anyone ──────────────────
  'answering-service': {
    canTransfer: false,
    transferTool: null,
    filesTickets: true,
    // Receives a `handoffToHuman` PARAMETER (line ~600) but never invokes it
    // and exposes no transfer tool. Declared, dead, and it is exactly the kind
    // of thing that makes a grep-based guess wrong.
    note: 'Practice-wide message taker. Holds the line with the busy-team script.',
  },
  'after-hours': {
    canTransfer: false, transferTool: null, filesTickets: true,
    note: 'Legacy slug, 4 calls ever. NOT the after-hours line — that is no-ivr.',
  },
  tech: {
    canTransfer: false, transferTool: null, filesTickets: true,
    note: 'Clinical Tech Support queue. `_handoffToHuman: undefined` — a deliberate no-op.',
  },
  surgery: {
    canTransfer: false, transferTool: null, filesTickets: true,
    note: 'Surgery Coordination queue.',
  },
  optical: {
    canTransfer: false, transferTool: null, filesTickets: true,
    note: 'Optical queue.',
  },
  records: {
    canTransfer: false, transferTool: null, filesTickets: true,
    note: 'Medical Records queue.',
  },
  'appointment-confirmation': {
    canTransfer: false, transferTool: null, filesTickets: false,
    note: 'Outbound confirmation calls. Completes in 60-90s.',
  },

  // ── Lines that CAN reach a human ─────────────────────────────────────────
  'no-ivr': {
    canTransfer: true,
    transferTool: 'escalate_to_human',
    filesTickets: true,
    // The practice's real after-hours triage line, and the only agent in the
    // fleet with a transfer tool. Named `no-ivr` only because an IVR-selection
    // variant was tried first. Transfers for a provider's office, a hospital,
    // or a true eye emergency — nothing else (afterHoursEscalationGate).
    note: 'THE after-hours line. Transfers to the office queue in hours, on-call outside them.',
  },
  'dev-no-ivr': {
    canTransfer: true, transferTool: 'escalate_to_human', filesTickets: true,
    note: 'Dev variant of the after-hours line (noIvrAgentV2).',
  },
  'no-ivr-v2': {
    canTransfer: true, transferTool: 'escalate_to_human', filesTickets: true,
    note: 'Workflow variant of the after-hours line.',
  },
  pcp: {
    canTransfer: true, transferTool: 'handoff_to_pcp', filesTickets: true,
    note: 'Professional line. Transfers to the PCP desk; lunch closure downgrades to a task.',
  },
  'azul-scheduling': {
    canTransfer: true, transferTool: 'sage_handoff', filesTickets: true,
    note: 'Scheduling. Hands off when identity cannot be established.',
  },
};

/**
 * What an agent we have never heard of is assumed to be able to do.
 *
 * CONSERVATIVE ON PURPOSE, and the direction matters. `canTransfer: false`
 * means a new or misspelled slug is treated as a line that must NOT promise a
 * transfer — so the worst case is that it takes a message when it could have
 * connected someone, rather than promising a caller a person it cannot reach.
 * A broken promise on a medical line is the more expensive mistake.
 *
 * `filesTickets: true` for the same reason: pushing call data for an agent
 * that files nothing is a wasted no-op, while withholding it from one that
 * does means a staffer opens a ticket with no recording behind it.
 */
const UNKNOWN_AGENT: AgentCapability = {
  canTransfer: false,
  transferTool: null,
  filesTickets: true,
  note: 'Unregistered agent — conservative defaults applied.',
};

const warned = new Set<string>();

/** Look up an agent's capabilities. Never throws: this sits in the live call path. */
export function capabilitiesOf(agentSlug: string | null | undefined): AgentCapability {
  const slug = agentSlug ?? '';
  const found = AGENT_CAPABILITIES[slug];
  if (found) return found;
  // Warn ONCE per slug per process. An unregistered agent is a real gap that
  // someone should close, but a live call must not be slowed by log spam.
  if (slug && !warned.has(slug)) {
    warned.add(slug);
    console.warn(
      `[CAPABILITIES] '${slug}' is not in AGENT_CAPABILITIES — assuming it cannot transfer. ` +
        'Add an entry in src/config/agentCapabilities.ts.',
    );
  }
  return UNKNOWN_AGENT;
}

/** Can this agent connect the caller to a live human? */
export function canTransfer(agentSlug: string | null | undefined): boolean {
  return capabilitiesOf(agentSlug).canTransfer;
}

/** Does this agent file tickets worth attaching call data to? */
export function filesTickets(agentSlug: string | null | undefined): boolean {
  return capabilitiesOf(agentSlug).filesTickets;
}

/**
 * A line whose ONLY outcome is a ticket: it files, and it cannot connect
 * anyone. On these lines, holding the line with the busy-team script and
 * taking a message IS the correct behaviour however many times the caller
 * asks — and promising a transfer is a critical failure.
 *
 * Derived rather than declared, so it cannot disagree with the two facts it
 * is made of. That disagreement is precisely what TICKET_ONLY_AGENTS and
 * NO_TRANSFER_AGENTS had with each other.
 */
export function isTicketOnly(agentSlug: string | null | undefined): boolean {
  const c = capabilitiesOf(agentSlug);
  return c.filesTickets && !c.canTransfer;
}
