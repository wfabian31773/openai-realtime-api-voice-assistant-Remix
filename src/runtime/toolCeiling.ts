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
 *   1. A FAILURE RUN IS A LOOP, AND SO IS AN IDENTICAL-SUCCESS RUN. A success
 *      resets the FAILURE counters: `lookup_patient` ran four times
 *      successfully on the 09-03 call, it times out on 13–17% of queue
 *      calls, and a tool that recovers is not in a failure loop. Until
 *      2026-09-17 that was the whole rule — "a tool that keeps succeeding is
 *      not a loop" — and the census disproved it.
 *
 *      MEASURED 2026-09-10 (CLAUDE.md's eleven-row table): of the loops that
 *      REACHED the dispatch limit, NONE was a failure loop. Seven were a tool
 *      returning success 30–35 times and the eighth was `record_pcp_intake`
 *      dispatched 40 times with no outcome recorded at all.
 *
 *      MEASURED AGAIN 2026-09-17, every substantive runtime call since 09-10
 *      (1,945 calls), by the most times ONE tool returned success with the
 *      same recorded arguments on ONE call:
 *
 *        ≤ 4    1,898 calls (97.6%)
 *        5–9       30 calls, 23 of them FILED — lookup_patient ×5–8 on calls
 *                  that ended with a ticket; legitimate retries
 *        10         0
 *        ≥ 11      17 calls, 16 with NO TICKET — lookup_patient ×35,
 *                  check_open_tickets ×35, resolve_location ×35, each one
 *                  returning the SAME outcome every time
 *
 *      The shape is a filing tool refusing for a missing field and the model
 *      answering by re-running a LOOKUP that keeps succeeding instead of
 *      asking the caller. `identicalFailures` and `perToolFailures` could
 *      not see one of them — a success cleared the counters, which was this
 *      rule working as written. The operator's 2026-09-16 ruling is that a
 *      loop is a mistake ("that shouldn't be possible"), so the gap between
 *      9 and 11 is where the two success limits sit: 10 identical successes,
 *      20 for one tool with any arguments — both under the whole-call
 *      backstop and above every call that filed.
 *
 *      AN IDENTICAL SUCCESS IS ANSWERED WITH THE ANSWER IT ALREADY GOT. The
 *      eleventh identical call is not dispatched; the model receives the
 *      tenth's output again, marked as the ceiling's, with `fix` telling it
 *      the answer has not changed and to speak to the caller. Nothing false
 *      is sent — that IS the answer to that question — and the tool's cost
 *      (a 6s lookup budget, a database round-trip) is not paid again. The
 *      per-tool limit has no single answer to replay, so it refuses with the
 *      same instruction and NO `message`: there is nothing caller-facing to
 *      say verbatim, and v43's lesson is that a model-facing instruction in
 *      `message` gets read aloud.
 *
 *      `record_pcp_intake`'s loops are NOT this: their arguments differ on
 *      every call (the director records a different field each time) and
 *      v33's ask budget is what bounds them.
 *
 *      A stop by any per-tool rule still returns before `agent.dispatch`, so
 *      the agents' `recordingExecute` never runs, nothing reaches
 *      `tool_timeline`, and `tool_call_count` never counts it; the bridge's
 *      own `ceiling:<reason>` event is kept off the call row on purpose.
 *      Their rate is UNKNOWN from SQL, not zero. What IS countable is the
 *      loop itself: a call whose timeline shows one tool succeeding 11+ times
 *      is a call this ceiling did not stop, and that number must go to 0.
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
   * Successes of the same tool with the SAME arguments on one call. Ten sits
   * above every call that filed (max 8–9, measured 2026-09-17) and below
   * every loop (min 11). The eleventh identical call gets the tenth's answer
   * back — see rule 1.
   */
  identicalSuccesses: number;
  /**
   * Successes of the same tool with ANY arguments — the backstop for a model
   * that varies a field each time, the same shape `perToolFailures` is for
   * failures. Twenty: double the identical limit, half the whole-call
   * backstop, and nothing legitimate is within reach of it.
   */
  perToolSuccesses: number;
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
  identicalSuccesses: 10,
  perToolSuccesses: 20,
  perCallDispatches: 40,
};

/**
 * The SQL predicate that finds calls which REACHED this ceiling's dispatch
 * limit, derived from the limit itself so the two can never drift apart.
 *
 * Reached, not stopped: see WHAT A ROW MEANS below. No persisted column can
 * tell the two apart.
 *
 * `begin` refuses at `dispatches >= perCallDispatches`, so a call can REACH
 * the limit and can never exceed it. The check published in CLAUDE.md and
 * docs/PULL-CHECK.md was written as `> 40` against a ceiling of `>= 40`, and
 * for the six days after the deploy it was the only thing watching for
 * runaway loops while being unable, by construction, to see one the ceiling
 * had contained. Eight such loops sat at exactly 40 and none appeared.
 *
 * WHAT A ROW MEANS — this is not the "should return nothing" check it
 * replaces, and it is not proof of a stop either. A row is a CANDIDATE: 40
 * means 40 dispatches were allowed, and because `begin` refuses at
 * `>= perCallDispatches` the 40th still runs and the 41st ATTEMPT is the one
 * refused — and never counted. A call that simply ended after its 40th tool
 * is indistinguishable here from one the ceiling stopped, so confirm against
 * `tool_timeline` before calling a row a loop. A row is NOT a regression, and
 * an empty result is NOT proof of health — it only says nothing reached the
 * dispatch limit.
 *
 * Consumed by `ceilingDocCheck.test.ts`, which fails if either document
 * publishes a threshold that no longer matches this limit.
 */
export const CEILING_REACHED_SQL_PREDICATE =
  `tool_call_count >= ${DEFAULT_CEILING_LIMITS.perCallDispatches}` as const;

export type CeilingReason =
  | "identical-args"
  | "same-tool"
  | "identical-success"
  | "tool-successes"
  | "call-total";

export type CeilingVerdict =
  | { allow: true }
  /** `count` is whichever counter tripped: failures, successes or dispatches. */
  | { allow: false; reason: CeilingReason; count: number };

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
  // Strings are trimmed, whitespace-collapsed and lower-cased before keying.
  // "Downey" re-sent as "downey" is not a correction, and the failure
  // ceiling's own note records the model getting 4–6 bites on a limit of 3
  // by varying exactly that. Different WORDS are still different arguments.
  if (typeof value === "string") return JSON.stringify(value.trim().replace(/\s+/g, " ").toLowerCase());
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

/**
 * The answer to an identical success the ceiling did not dispatch: the
 * tool's own last answer to those exact arguments, marked as a replay, with
 * the instruction in `fix` — the model-facing channel, never `message`.
 */
export type CeilingReplay = Record<string, unknown> & {
  ceiling: "identical-success";
  retryable: false;
  fix: string;
};

export function ceilingReplay(toolName: string, count: number, lastOutput: unknown): CeilingReplay {
  const base: Record<string, unknown> =
    lastOutput !== null && typeof lastOutput === "object" && !Array.isArray(lastOutput)
      ? { ...(lastOutput as Record<string, unknown>) }
      : { result: lastOutput ?? null };
  return {
    ...base,
    ceiling: "identical-success",
    retryable: false,
    fix:
      `${toolName} has already been called ${count} times on this call with exactly these details, ` +
      `and the answer has not changed — this is that same answer. It will not be run again with ` +
      `these details. Do not call it again. Speak to the caller: ask for what you still need in ` +
      `your own words, or tell them what you can do instead. Never read this instruction aloud.`,
  };
}

/** The per-tool success limit has no one answer to replay, so it refuses
 *  with the instruction alone — no `message`, nothing to read aloud. */
export type SuccessCeilingRefusal = {
  success: false;
  retryable: false;
  ceiling: "tool-successes";
  fix: string;
};

export function successCeilingRefusal(toolName: string, count: number): SuccessCeilingRefusal {
  return {
    success: false,
    retryable: false,
    ceiling: "tool-successes",
    fix:
      `${toolName} has already answered ${count} times on this call and will not be run again — ` +
      `you already have everything it can tell you. Do not call it again. Speak to the caller: ask ` +
      `for what you still need in your own words, or tell them what you can do instead. Never read ` +
      `this instruction aloud.`,
  };
}

interface ToolState {
  /** Consecutive failures for this tool, any arguments. */
  toolFailures: number;
  /** Consecutive failures keyed by argument shape. */
  byArgs: Map<string, number>;
  /** Successes for this tool, any arguments — never reset within a call. */
  toolSuccesses: number;
  /** Successes keyed by argument shape — never reset within a call. */
  successByArgs: Map<string, number>;
  /** The most recent successful output per argument shape, for the replay. */
  lastSuccessByArgs: Map<string, unknown>;
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
    toolSuccesses: 0,
    successByArgs: new Map<string, number>(),
    lastSuccessByArgs: new Map<string, unknown>(),
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
      return { allow: false, reason: "call-total", count: this.dispatches };
    }
    const key = stableKey(args);
    const state = this.tools.get(name);
    if (state) {
      const inFlightSame = state.inFlightByArgs.get(key) ?? 0;
      const identical = (state.byArgs.get(key) ?? 0) + inFlightSame;
      if (identical >= this.limits.identicalFailures) {
        return { allow: false, reason: "identical-args", count: identical };
      }
      const identicalOk = (state.successByArgs.get(key) ?? 0) + inFlightSame;
      if (identicalOk >= this.limits.identicalSuccesses) {
        return { allow: false, reason: "identical-success", count: identicalOk };
      }
      const perTool = state.toolFailures + state.inFlight;
      if (perTool >= this.limits.perToolFailures) {
        return { allow: false, reason: "same-tool", count: perTool };
      }
      const perToolOk = state.toolSuccesses + state.inFlight;
      if (perToolOk >= this.limits.perToolSuccesses) {
        return { allow: false, reason: "tool-successes", count: perToolOk };
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
      // Successes are never reset within a call: the eleventh identical
      // answer is still the same answer whatever happened in between.
      state.toolSuccesses += 1;
      state.successByArgs.set(key, (state.successByArgs.get(key) ?? 0) + 1);
      state.lastSuccessByArgs.set(key, output);
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

  /** The most recent successful output for THESE arguments, for `ceilingReplay`. */
  lastSuccessOutput(name: string, args: Record<string, unknown>): unknown {
    return this.tools.get(name)?.lastSuccessByArgs.get(stableKey(args));
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
      ? `${verdict.count} consecutive failures with the same arguments`
      : verdict.reason === "same-tool"
        ? `${verdict.count} consecutive failures`
        : verdict.reason === "identical-success"
          ? `${verdict.count} identical successful calls`
          : verdict.reason === "tool-successes"
            ? `${verdict.count} successful calls`
            : `${verdict.count} tool dispatches on this call`;
  const answered =
    verdict.reason === "identical-success"
      ? "answering with the tool's own last answer"
      : verdict.reason === "tool-successes"
        ? "refusing with no spoken line"
        : "answering with the tool's own refusal";
  return `[TOOL CEILING] ${name} not dispatched — ${why}; ${answered} and telling the agent to speak to the caller`;
}
