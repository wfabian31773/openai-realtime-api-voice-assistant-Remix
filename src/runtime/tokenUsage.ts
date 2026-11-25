/**
 * WHAT THE CALL COST, ON THE RUNTIME.
 *
 * Asked by the operator on 2026-09-03: *"at what rate are we cacheing
 * tokens?"* The answer for the Grok runtime was that nobody could say. In the
 * seven and a half hours after the first cutover, 179 completed runtime calls
 * wrote NULL — not zero, null — to every token column on `call_logs`, while
 * the old core's 185 calls over the same window reported 80.1% of input TEXT
 * tokens served from cache, 47.3% of audio, 77.0% overall.
 *
 * Nothing in `src/runtime/` mentioned usage at all. So prompt size, which the
 * operator was actively asking about — *"grok requires minimal prompting, we
 * should not be near our ceilings"* — was not costable on the pipeline that
 * now answers most of the practice's calls.
 *
 * WHY THIS READS DEFENSIVELY INSTEAD OF DECLARING A SHAPE
 *
 * `wireTypes.ts` models `response.done` as `{ type: "response.done" }` with no
 * payload, and I have never seen what Grok actually puts on it. Writing an
 * interface from the OpenAI realtime docs and trusting it is how a silent
 * mis-parse gets shipped: the columns would stay null and look exactly like
 * they do today.
 *
 * So this reads whatever arrives, accepts the several spellings the realtime
 * APIs use for the same number, and — the important part — SAYS WHAT IT SAW.
 * `describeUsageShape` names the keys present on the first response of each
 * call, so one live call settles the schema question that no amount of reading
 * would. If Grok sends nothing at all, the marker says that too, and the gap
 * is the provider's rather than ours.
 */

export interface UsageTotals {
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  inputCachedTokens: number;
  inputCachedTextTokens: number;
  inputCachedAudioTokens: number;
}

export const ZERO_USAGE: UsageTotals = {
  inputTextTokens: 0,
  inputAudioTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
  inputCachedTokens: 0,
  inputCachedTextTokens: 0,
  inputCachedAudioTokens: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/**
 * The usage block, wherever the provider chose to hang it.
 *
 * Realtime implementations put it on `response.usage`; some put it at the top
 * level. Both are checked because guessing wrong costs the whole measurement
 * and checking both costs nothing.
 */
function usageBlock(event: unknown): Record<string, unknown> | undefined {
  const e = obj(event);
  if (!e) return undefined;
  return obj(obj(e.response)?.usage) ?? obj(e.usage);
}

/**
 * One response's usage, or null when the event carries none.
 *
 * Null and all-zero are DIFFERENT and the difference is the whole point: null
 * means the provider told us nothing, zero means it told us nothing was used.
 * Collapsing them is what makes a missing feed indistinguishable from a quiet
 * call, which is the state this module exists to end.
 */
export function readUsage(event: unknown): UsageTotals | null {
  const u = usageBlock(event);
  if (!u) return null;

  const inBlock = obj(u.input_token_details) ?? obj(u.input_tokens_details);
  const outBlock = obj(u.output_token_details) ?? obj(u.output_tokens_details);
  /**
   * NO BREAKDOWN, NO SPLIT (v273). xAI's `response.usage` carries only
   * `input_tokens`, `output_tokens` and `total_tokens` (every
   * `[TOKENS] usage reported` line in the deployment log of 2026-11-24..25),
   * and reading the text/audio split out of a block that has none returned
   * all zeros: "in 0 (text 0, audio 0), cached 0 = 0%, out 0" on every call.
   * A split nobody reported is unknown, not zero, so it is null here and the
   * columns stay NULL. The flat totals are read by `readResponseFacts`.
   */
  if (!inBlock && !outBlock) return null;
  const inDetails = inBlock ?? {};
  const outDetails = outBlock ?? {};
  const cachedDetails =
    obj(inDetails.cached_tokens_details) ?? obj(inDetails.cached_token_details) ?? {};

  const inputTextTokens = num(inDetails.text_tokens);
  const inputAudioTokens = num(inDetails.audio_tokens);
  const cachedText = num(cachedDetails.text_tokens);
  const cachedAudio = num(cachedDetails.audio_tokens);
  // The total is reported directly on most shapes; where it is not, the two
  // halves are the total. Never the other way round — a reported total that
  // disagrees with its parts is the provider's arithmetic, not ours to correct.
  const cachedTotal = num(inDetails.cached_tokens) || cachedText + cachedAudio;

  return {
    inputTextTokens,
    inputAudioTokens,
    outputTextTokens: num(outDetails.text_tokens),
    outputAudioTokens: num(outDetails.audio_tokens),
    inputCachedTokens: cachedTotal,
    inputCachedTextTokens: cachedText,
    inputCachedAudioTokens: cachedAudio,
  };
}

/**
 * The KEY NAMES on a usage block, for the marker. Never a value — these are
 * counts rather than content, but the habit of logging only shapes is what
 * keeps a log safe to read out loud.
 */
export function describeUsageShape(event: unknown): string {
  const u = usageBlock(event);
  if (!u) return "none";
  const parts: string[] = Object.keys(u).sort();
  const inDetails = obj(u.input_token_details) ?? obj(u.input_tokens_details);
  if (inDetails) parts.push(`input_token_details{${Object.keys(inDetails).sort().join(",")}}`);
  return parts.join(",");
}

/**
 * WHAT ELSE xAI PUTS ON `response.done` (v273). Probed on a test socket on
 * 2026-11-25 with synthetic text, and matching the deployment log's
 * `[TOKENS]` lines:
 *
 *   { "type": "response.done", "response_id": "<id>",
 *     "response": { "id": "<id>", "status": "completed", "status_details": null,
 *                   "output": [...],
 *                   "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 } },
 *     "usage": { "output_audio_seconds": 2.54, "billable_audio_seconds": 1 } }
 *
 * The top-level `usage` was never read: `usageBlock` takes `response.usage`
 * first. It holds the audio seconds, the unit xAI bills voice in, and the
 * cost section of CLAUDE.md has been asking since 2026-09-04 what xAI
 * counts. This reads them as they are and interprets nothing.
 */
export interface ResponseFacts {
  responseId: string | null;
  status: string | null;
  /** Why a response did not complete: `status_details.reason`, else its
   * error code, else its type. Short provider text, never call content. */
  statusReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  outputAudioSeconds: number | null;
  billableAudioSeconds: number | null;
}

/** A count the provider sent, or null when it sent none. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Short provider text, capped, or null. */
function shortText(v: unknown, max = 60): string | null {
  if (typeof v !== "string") return null;
  const flat = v.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max) : flat;
}

export function readResponseFacts(event: unknown): ResponseFacts {
  const e = obj(event) ?? {};
  const response = obj(e.response) ?? {};
  const inner = obj(response.usage) ?? {};
  const outer = obj(e.usage) ?? {};
  // A count from the response's own usage block first, then the top level:
  // the same preference `usageBlock` has always had.
  const either = (key: string) => count(inner[key]) ?? count(outer[key]);
  const details = obj(response.status_details);
  const error = obj(details?.error);
  return {
    responseId: shortText(response.id, 100) ?? shortText(e.response_id, 100),
    status: shortText(response.status, 30),
    statusReason:
      shortText(details?.reason) ?? shortText(error?.code) ?? shortText(details?.type),
    inputTokens: either("input_tokens"),
    outputTokens: either("output_tokens"),
    totalTokens: either("total_tokens"),
    outputAudioSeconds: either("output_audio_seconds"),
    billableAudioSeconds: either("billable_audio_seconds"),
  };
}

/**
 * One call's responses, as xAI reported them (v273). Every field is a sum or
 * a count; null means no response on the call reported that number at all,
 * which is different from a zero the provider sent.
 */
export interface ProviderUsageSummary {
  responses: number;
  /** Responses by `response.status` (`completed`, `cancelled`, …). */
  statuses: Record<string, number>;
  /** Responses that did not complete, by why (`statusReason`). */
  statusReasons: Record<string, number>;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  outputAudioSeconds: number | null;
  billableAudioSeconds: number | null;
  /** The last response's id, for a support ticket beside the conversation id. */
  lastResponseId: string | null;
}

/** At most this many distinct status or reason keys per call, so a provider
 * that puts something unexpected in the field cannot grow the row. */
const MAX_KEYS = 12;

function bump(map: Record<string, number>, key: string): void {
  if (key in map || Object.keys(map).length < MAX_KEYS) map[key] = (map[key] ?? 0) + 1;
}

function addTo(total: number | null, v: number | null): number | null {
  if (v === null) return total;
  // Seconds are fractional; two decimals is xAI's own precision on the probe.
  return Math.round(((total ?? 0) + v) * 100) / 100;
}

/** Sums usage across a call's responses. */
export class CallUsage {
  private totals: UsageTotals = { ...ZERO_USAGE };
  /** True once any response reported usage at all. */
  private sawAny = false;
  /** The first shape seen, logged once so a live call settles the schema. */
  private describedOnce = false;
  private facts: ProviderUsageSummary = {
    responses: 0,
    statuses: {},
    statusReasons: {},
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    outputAudioSeconds: null,
    billableAudioSeconds: null,
    lastResponseId: null,
  };

  add(event: unknown): void {
    if (!this.describedOnce) {
      this.describedOnce = true;
      console.info(usageShapeMarker(describeUsageShape(event)));
    }
    this.addFacts(readResponseFacts(event));
    const u = readUsage(event);
    if (!u) return;
    this.sawAny = true;
    this.totals = {
      inputTextTokens: this.totals.inputTextTokens + u.inputTextTokens,
      inputAudioTokens: this.totals.inputAudioTokens + u.inputAudioTokens,
      outputTextTokens: this.totals.outputTextTokens + u.outputTextTokens,
      outputAudioTokens: this.totals.outputAudioTokens + u.outputAudioTokens,
      inputCachedTokens: this.totals.inputCachedTokens + u.inputCachedTokens,
      inputCachedTextTokens: this.totals.inputCachedTextTokens + u.inputCachedTextTokens,
      inputCachedAudioTokens: this.totals.inputCachedAudioTokens + u.inputCachedAudioTokens,
    };
  }

  /**
   * The totals, or undefined when the provider never reported any.
   *
   * Undefined leaves the columns NULL, which is the truthful record of "we were
   * told nothing" and keeps it distinguishable from a call that genuinely used
   * nothing. Writing zeros here would erase exactly the signal that found this.
   */
  result(): UsageTotals | undefined {
    return this.sawAny ? { ...this.totals } : undefined;
  }

  private addFacts(f: ResponseFacts): void {
    const s = this.facts;
    s.responses += 1;
    bump(s.statuses, f.status ?? "unknown");
    if (f.status !== "completed" && f.statusReason) bump(s.statusReasons, f.statusReason);
    s.inputTokens = addTo(s.inputTokens, f.inputTokens);
    s.outputTokens = addTo(s.outputTokens, f.outputTokens);
    s.totalTokens = addTo(s.totalTokens, f.totalTokens);
    s.outputAudioSeconds = addTo(s.outputAudioSeconds, f.outputAudioSeconds);
    s.billableAudioSeconds = addTo(s.billableAudioSeconds, f.billableAudioSeconds);
    if (f.responseId) s.lastResponseId = f.responseId;
  }

  /** The call's responses as xAI reported them, or undefined when no
   * response finished on the call at all (v273). */
  summary(): ProviderUsageSummary | undefined {
    const s = this.facts;
    if (s.responses === 0) return undefined;
    return { ...s, statuses: { ...s.statuses }, statusReasons: { ...s.statusReasons } };
  }
}

/**
 * DEPLOY MARKER, and the answer to a question reading the docs could not
 * settle. Prints once per call with the key names the provider actually sent,
 * so the first live call after the deploy says whether Grok reports usage and
 * under which spelling. "none" is a real answer and the one that would make
 * this the provider's gap rather than ours.
 */
export function usageShapeMarker(shape: string): string {
  return `[TOKENS] usage reported by the provider on this response: ${shape}`;
}

/** Printed at teardown (v273): what xAI reported for the whole call. */
export function providerUsageMarker(s: ProviderUsageSummary): string {
  const n = (v: number | null) => (v === null ? "none" : String(v));
  return (
    `[TOKENS] provider reported ${s.responses} response(s): ` +
    `tokens in ${n(s.inputTokens)} out ${n(s.outputTokens)} total ${n(s.totalTokens)}, ` +
    `audio out ${n(s.outputAudioSeconds)}s billable ${n(s.billableAudioSeconds)}s, ` +
    `statuses ${JSON.stringify(s.statuses)}`
  );
}

/** Printed at teardown, so the cache rate is readable per call in the log. */
export function usageSummaryMarker(u: UsageTotals): string {
  const input = u.inputTextTokens + u.inputAudioTokens;
  const pct = input > 0 ? Math.round((u.inputCachedTokens / input) * 1000) / 10 : 0;
  return (
    `[TOKENS] in ${input} (text ${u.inputTextTokens}, audio ${u.inputAudioTokens}), ` +
    `cached ${u.inputCachedTokens} = ${pct}%, out ${u.outputTextTokens + u.outputAudioTokens}`
  );
}
