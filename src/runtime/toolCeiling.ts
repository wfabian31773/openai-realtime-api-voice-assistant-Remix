/**
 * src/runtime/toolCeiling.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A ceiling on repeated FAILING tool dispatches within one call.
 *
 * WHY THIS EXISTS — one call, 2026-09-03 16:00:43 UTC, optical, the
 * fourteenth call after the runtime cutover:
 *
 *   file_optical_ticket  missingFields:["date_of_birth"]  × 110  in 144s
 *   file_optical_ticket  missingFields:["location"]       × 1
 *   lookup_patient       ok                               × 4
 *   resolve_location     2 fail, 1 ok
 *
 * The caller hung up with no ticket. 245 seconds, 118 tool calls.
 *
 * THE GATE WAS RIGHT AND THE MODEL WAS WRONG. `src/tools/opticalTools.ts`
 * refuses a filing with no date of birth and hands back `missing([...])`,
 * whose whole purpose is to be SPOKEN to the caller — the prompts teach the
 * agent to answer a missing-field envelope by asking. On the old core that
 * worked: across 2,972 queue calls in the fourteen days to 2026-09-03 the
 * highest tool-call count on ANY call is 24, and only four calls passed 20.
 * Grok answers the same envelope by calling the tool again, so the same
 * refusal that cost the old core one lost call costs this transport a
 * four-minute loop.
 *
 * So the ceiling belongs HERE, in the transport, not in the tools: it is a
 * property of the model on the other end of this socket, and every lane and
 * every tool is exposed to it — the loop above happened to be optical's
 * filing tool, but nothing about it is optical-specific.
 *
 * FOUR RULES THIS FILE KEEPS, each one load-bearing:
 *
 *   1. ONLY FAILURES COUNT, AND A SUCCESS RESETS. A tool that keeps
 *      succeeding is not a loop, and refusing one would break working
 *      behaviour — `lookup_patient` ran four times successfully on that same
 *      call, and it times out on 13–17% of queue calls, so legitimate
 *      retries are ordinary here. Only a run of consecutive failures is the
 *      pathology.
 *
 *   2. THE REFUSAL BORROWS THE TOOL'S OWN WORDS. When the ceiling stops a
 *      dispatch it replays the message the tool itself last returned, rather
 *      than inventing one. The tool knows what is missing and the prompts
 *      already know how to speak its envelope; this file has no business
 *      writing procedure (standing instruction 1).
 *
 *   3. IT NEVER LEAVES A TOOL CALL UNANSWERED. A refused dispatch still
 *      produces a result to send back. An unanswered call stalls the turn
 *      forever, which is a worse failure than the one being fixed.
 *
 *   4. NO ARGUMENTS ARE EVER LOGGED. Arguments hold names, dates of birth
 *      and callback numbers. They are used as an in-memory key and nothing
 *      else; the marker line names the tool and the count.
 */

/** How many times one thing may fail before the ceiling stops dispatching. */
export interface CeilingLimits {
  /**
   * Consecutive failures of the same tool with the SAME arguments. Three
   * leaves room for a genuine transient (a `lookup_patient` timeout) while
   * catching a model that is re-sending an identical payload.
   */
  identicalFailures: number;
  /**
   * Consecutive failures of the same tool with ANY arguments — the case
   * where the model varies one field each time and never speaks.
   */
  perToolFailures: number;
  /**
   * Total dispatches in one call, successes included. A backstop against a
   * loop that alternates between tools or between success and failure.
   * The old core's observed maximum over 2,972 queue calls is 24.
   */
  perCallDispatches: number;
}

export const DEFAULT_CEILING_LIMITS: CeilingLimits = {
  identicalFailures: 3,
  perToolFailures: 6,
  perCallDispatches: 40,
};

export type CeilingReason = "identical-args" | "same-tool" | "call-total";

export type CeilingVerdict =
  | { allow: true }
  | { allow: false; reason: CeilingReason; failures: number };

/**
 * The answer sent back to the model in place of a dispatch that was stopped.
 *
 * A type alias rather than an interface so it satisfies the transport's
 * `Record<string, unknown>` output parameter without a cast.
 */
export type CeilingRefusal = {
  success: false;
  /** Never true. The point of the ceiling is that retrying is the bug. */
  retryable: false;
  /** Marks this as the transport's answer, not the tool's. */
  ceiling: CeilingReason;
  /** What the agent should say or do — the tool's own words where we have them. */
  message: string;
};

/**
 * Stable JSON: object keys sorted at every depth, so `{a,b}` and `{b,a}`
 * are one key. Arrays keep their order — order is meaning in an array.
 *
 * Returns a string used ONLY as an in-memory map key. It is never logged,
 * never recorded on the call row and never sent anywhere.
 */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * The message to hand back when a dispatch is stopped.
 *
 * `lastOutput` is whatever the tool returned on its most recent failure,
 * already decoded. Where it carries a `message` — which every
 * `missing([...], "…")` refusal does — that is what the agent hears, because
 * it is the tool's own wording and the prompts are written against it. The
 * fallback is an instruction to the model, not a script for the caller: this
 * file does not put words in an agent's mouth.
 */
export function ceilingMessage(toolName: string, lastOutput: unknown): string {
  if (lastOutput && typeof lastOutput === "object") {
    const rec = lastOutput as Record<string, unknown>;
    for (const field of ["message", "say", "error"]) {
      const v = rec[field];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }
  return (
    `${toolName} has failed repeatedly with the same information and will not ` +
    `be run again on this call. Do not call it again. Speak to the caller: ask ` +
    `for what is missing in your own words, or tell them what you can do instead.`
  );
}

export function ceilingRefusal(
  toolName: string,
  reason: CeilingReason,
  lastOutput: unknown,
): CeilingRefusal {
  return {
    success: false,
    retryable: false,
    ceiling: reason,
    message: ceilingMessage(toolName, lastOutput),
  };
}

interface ToolState {
  /** Consecutive failures for this tool, any arguments. */
  toolFailures: number;
  /** Consecutive failures keyed by argument shape. */
  byArgs: Map<string, number>;
  /** Dispatches begun and not yet settled, for this tool. */
  inFlight: number;
  /** Dispatches begun and not yet settled, keyed by argument shape. */
  inFlightByArgs: Map<string, number>;
  /** The most recent failing output, for its wording. */
  lastFailure: unknown;
}

function emptyState(): ToolState {
  return {
    toolFailures: 0,
    byArgs: new Map<string, number>(),
    inFlight: 0,
    inFlightByArgs: new Map<string, number>(),
    lastFailure: undefined,
  };
}

/**
 * One instance per call. Not shared, not global: the counters are per-call
 * state and a process-wide one would refuse the second caller for what the
 * first caller's model did.
 */
export class ToolCallCeiling {
  private readonly limits: CeilingLimits;
  private readonly tools = new Map<string, ToolState>();
  private dispatches = 0;

  constructor(limits: Partial<CeilingLimits> = {}) {
    this.limits = { ...DEFAULT_CEILING_LIMITS, ...limits };
  }

  /** Dispatches begun on this call, successes included. */
  get dispatchCount(): number {
    return this.dispatches;
  }

  /**
   * Decide whether this dispatch may run, and RESERVE it if so.
   *
   * IN-FLIGHT DISPATCHES COUNT. One model response can carry several tool
   * calls, and they all reach the transport before any of them has an
   * answer — so a ceiling that only counted settled failures would wave a
   * whole batch of identical calls through. The bridge test
   * "still asks the agent to speak" caught exactly that: four identical
   * calls arrived on one response and all four dispatched.
   *
   * Every `begin` that returns `allow: true` MUST be followed by a
   * `settle`, or the reservation is never released.
   */
  begin(name: string, args: Record<string, unknown>): CeilingVerdict {
    if (this.dispatches >= this.limits.perCallDispatches) {
      return { allow: false, reason: "call-total", failures: this.dispatches };
    }
    const key = stableKey(args);
    const state = this.tools.get(name);
    if (state) {
      const identical = (state.byArgs.get(key) ?? 0) + (state.inFlightByArgs.get(key) ?? 0);
      if (identical >= this.limits.identicalFailures) {
        return { allow: false, reason: "identical-args", failures: identical };
      }
      const perTool = state.toolFailures + state.inFlight;
      if (perTool >= this.limits.perToolFailures) {
        return { allow: false, reason: "same-tool", failures: perTool };
      }
    }
    const reserved = state ?? emptyState();
    reserved.inFlight += 1;
    reserved.inFlightByArgs.set(key, (reserved.inFlightByArgs.get(key) ?? 0) + 1);
    this.tools.set(name, reserved);
    this.dispatches += 1;
    return { allow: true };
  }

  /**
   * Release the reservation `begin` took and record what the dispatch did.
   *
   * A success clears this tool's failure counters entirely — including the
   * per-argument ones, because a tool that has just worked is not in a
   * failure loop. In-flight counts survive the clear: siblings of the
   * succeeding call are still out there and still hold their reservations.
   */
  settle(name: string, args: Record<string, unknown>, ok: boolean, output?: unknown): void {
    const key = stableKey(args);
    const state = this.tools.get(name) ?? emptyState();
    state.inFlight = Math.max(0, state.inFlight - 1);
    const stillOut = (state.inFlightByArgs.get(key) ?? 0) - 1;
    if (stillOut > 0) state.inFlightByArgs.set(key, stillOut);
    else state.inFlightByArgs.delete(key);

    if (ok) {
      state.toolFailures = 0;
      state.byArgs.clear();
      state.lastFailure = undefined;
    } else {
      state.toolFailures += 1;
      state.byArgs.set(key, (state.byArgs.get(key) ?? 0) + 1);
      state.lastFailure = output;
    }
    this.tools.set(name, state);
  }

  /** The most recent failing output for a tool, for `ceilingRefusal`. */
  lastFailureOutput(name: string): unknown {
    return this.tools.get(name)?.lastFailure;
  }
}

/**
 * The marker line. Invisible code needs a live counter (CLAUDE.md, "How to
 * tell whether a deploy actually took") and this one prints only when it
 * fires, which makes it both.
 *
 * No arguments in it — see rule 4.
 */
export function ceilingMarker(name: string, verdict: Extract<CeilingVerdict, { allow: false }>): string {
  const why =
    verdict.reason === "identical-args"
      ? `${verdict.failures} consecutive failures with the same arguments`
      : verdict.reason === "same-tool"
        ? `${verdict.failures} consecutive failures`
        : `${verdict.failures} tool dispatches on this call`;
  return `[TOOL CEILING] ${name} not dispatched — ${why}; answering with the tool's own refusal and telling the agent to speak to the caller`;
}
