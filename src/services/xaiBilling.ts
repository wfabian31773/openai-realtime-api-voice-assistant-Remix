/**
 * WHAT XAI ACTUALLY CHARGED, from xAI.
 *
 * Grok reports NO token usage on the wire — 0 of 18 calls carried a `usage`
 * object after the telemetry landed, and xAI's Voice Agent docs do not
 * document one on `response.done`. So per-call cost cannot come from
 * telemetry the way it does on the OpenAI core, where 172 of 184 rows report
 * it. It has to come from the bill.
 *
 * It can. xAI run a MANAGEMENT API, separate from the inference API, with
 * exactly the two things the operator described — a cost per day and the
 * flat rate:
 *
 *   base        https://management-api.x.ai
 *   auth        Authorization: Bearer <management key>
 *   key         xAI Console -> Settings -> Management Keys
 *               (a DIFFERENT credential from XAI_API_KEY, which cannot read
 *                billing; do not try to reuse it)
 *   team id     console.x.ai/team/default/settings/team
 *
 *   POST /v1/billing/teams/{team}/usage
 *        -> spend per day (TIME_UNIT_DAY), optionally grouped by model
 *   GET  /v1/billing/teams/{team}/postpaid/invoice/preview
 *        -> the live line items: unitType, unitPrice, numUnits, amount
 *
 * The invoice preview is the more interesting of the two, because
 * `unitPrice` is xAI's flat rate stated by xAI rather than transcribed from
 * a pricing page, and `numUnits` is HOW MANY UNITS THEY COUNTED — which is
 * the only way to find out whether they bill the duration Twilio reports.
 *
 * Published rates for grok-voice-think-fast-2.0, for comparison against what
 * comes back: "$0.08 / min audio" and, separately, "$0.004 / text input".
 * We have only ever counted the first.
 *
 * NOTHING HERE GUESSES. With no management key configured every call returns
 * `{ configured: false }` and the reconciler does nothing — a wrong cost
 * quietly replacing an honest estimate would be worse than the estimate.
 */

const DEFAULT_BASE_URL = "https://management-api.x.ai";

/** Injected so this module is testable without a network or a credential. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface XaiBillingConfig {
  baseUrl: string;
  managementKey: string;
  teamId: string;
}

export type XaiBillingSetup = { configured: true; config: XaiBillingConfig } | {
  configured: false;
  /** Which environment variables are missing, for an operator to act on. */
  missing: string[];
};

export function readXaiBillingConfig(
  env: Record<string, string | undefined> = process.env,
): XaiBillingSetup {
  const managementKey = (env.XAI_MANAGEMENT_KEY ?? "").trim();
  const teamId = (env.XAI_TEAM_ID ?? "").trim();
  const missing: string[] = [];
  if (!managementKey) missing.push("XAI_MANAGEMENT_KEY");
  if (!teamId) missing.push("XAI_TEAM_ID");
  if (missing.length) return { configured: false, missing };
  return {
    configured: true,
    config: {
      baseUrl: (env.XAI_MANAGEMENT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      managementKey,
      teamId,
    },
  };
}

export type BillingResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * The request body for one day's spend. Kept as a pure function so the shape
 * xAI expect is pinned by a test rather than discovered in production —
 * `values` takes objects with an aggregation, not bare strings, and
 * `timeUnit` is the prefixed enum, not "DAY".
 */
export function buildDailyUsageRequest(day: string, timezone = "UTC"): unknown {
  return {
    analyticsRequest: {
      timeRange: {
        startTime: `${day} 00:00:00`,
        endTime: `${day} 23:59:59`,
        timezone,
      },
      timeUnit: "TIME_UNIT_DAY",
      values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
      groupBy: ["description"],
      filters: [],
    },
  };
}

export interface DailySpendLine {
  /** xAI's own label for the thing charged — usually the model name. */
  description: string;
  usd: number;
}

export interface DailySpend {
  day: string;
  /** Spend for the VOICE workload only — see `sumDailyUsage`. */
  totalUsd: number;
  /** The voice lines that made up the total. */
  lines: DailySpendLine[];
  /** Descriptions that were present and deliberately excluded, for the log. */
  ignored: DailySpendLine[];
}

/**
 * Which billing lines are this runtime's voice calls.
 *
 * Found by Codex on PR #268: the request sent `filters: []` and the parser
 * summed EVERY series, so a team that also runs text inference — grok-4, a
 * batch job, anything — would have had that spend allocated across the day's
 * phone calls. Those rows would then be marked reconciled at an inflated
 * price, which is the one outcome this whole module exists to avoid.
 *
 * Matched on the description rather than by a server-side filter because the
 * filter grammar is not documented and a filter we get subtly wrong returns
 * a 400 that reads as an outage. Matching what came back is checkable.
 *
 * Overridable because the model name is a moving target — it is already
 * per-lane settable through XAI_VOICE_MODEL.
 */
export function isVoiceBillingLine(description: string, needle = "grok-voice"): boolean {
  return description.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Sum a usage response into one day's spend.
 *
 * Separated from the fetch because the response is nested three deep and
 * getting it wrong reads as "xAI charged us nothing", which would silently
 * zero out every call it touches. `limitReached` is refused rather than
 * summed for the same reason: a truncated series is not a total, and the one
 * thing this module must never do is hand the reconciler a number that is
 * quietly too small.
 */
export function sumDailyUsage(
  day: string,
  payload: unknown,
  voiceNeedle = "grok-voice",
): BillingResult<DailySpend> {
  const root = payload as {
    timeSeries?: Array<{ groupLabels?: string[]; group?: string[]; dataPoints?: Array<{ values?: number[] }> }>;
    limitReached?: boolean;
  } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.timeSeries)) {
    return { ok: false, reason: "usage response had no timeSeries array" };
  }
  if (root.limitReached === true) {
    return { ok: false, reason: "xAI truncated the usage series (limitReached) — the total would be too low" };
  }
  const lines: DailySpendLine[] = [];
  /**
   * A series we RECOGNISED but could not read a number out of.
   *
   * Skipping its bad points and calling the result $0 turns a malformed or
   * truncated response into an authoritative free day — every call on it
   * written to zero and marked reconciled, permanently (Codex, PR #268
   * round 4). Silently dropping invalid points is right; silently dropping
   * ALL of them is not, so the two cases are separated here and the second
   * one refuses below.
   */
  const unreadable: string[] = [];
  for (const series of root.timeSeries) {
    const label = series.groupLabels?.[0] ?? series.group?.[0] ?? "(ungrouped)";
    let usd = 0;
    let sawNumber = false;
    for (const point of series.dataPoints ?? []) {
      const v = point.values?.[0];
      if (typeof v === "number" && Number.isFinite(v)) {
        usd += v;
        sawNumber = true;
      }
    }
    if (!sawNumber && isVoiceBillingLine(label, voiceNeedle)) unreadable.push(label);
    else lines.push({ description: label, usd });
  }
  if (unreadable.length > 0) {
    return {
      ok: false,
      reason:
        `xAI returned voice billing line(s) for ${day} with no readable amount ` +
        `(${unreadable.join(", ")}) — a response we cannot read is not a free day`,
    };
  }
  const voice = lines.filter((l) => isVoiceBillingLine(l.description, voiceNeedle));
  const ignored = lines.filter((l) => !isVoiceBillingLine(l.description, voiceNeedle));

  /**
   * NO VOICE LINE IS NOT ZERO. If the day had calls but xAI reports no voice
   * spend under a name we recognise, that is a model rename or a grouping
   * change — and allocating $0 across the day would mark every call
   * reconciled at nothing, silently. Refuse and name what DID come back.
   */
  if (voice.length === 0) {
    return {
      ok: false,
      reason:
        `xAI reported no billing line matching "${voiceNeedle}" for ${day}` +
        (ignored.length
          ? ` — the day's lines were: ${ignored.map((l) => l.description).join(", ")}`
          : " — the day had no billing lines at all"),
    };
  }

  return {
    ok: true,
    value: { day, totalUsd: voice.reduce((s, l) => s + l.usd, 0), lines: voice, ignored },
  };
}

async function post(
  config: XaiBillingConfig,
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<BillingResult<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.managementKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // The status, never the body: an error body from a billing endpoint can
      // echo account details, and this line goes to a shared log.
      return { ok: false, reason: `xAI management API returned HTTP ${res.status}` };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, reason: "xAI management API returned a body that was not JSON" };
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `xAI management API unreachable: ${error.message}` : "xAI management API unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One day's spend, or the reason it could not be read. Never throws. */
export async function fetchDailySpend(
  day: string,
  options: {
    setup?: XaiBillingSetup;
    fetchImpl?: FetchLike;
    timezone?: string;
    timeoutMs?: number;
    /** Substring identifying the voice model on a billing line. */
    voiceNeedle?: string;
  } = {},
): Promise<BillingResult<DailySpend>> {
  const setup = options.setup ?? readXaiBillingConfig();
  if (!setup.configured) {
    return {
      ok: false,
      reason:
        `xAI billing is not configured — set ${setup.missing.join(" and ")}. ` +
        `The management key is created at xAI Console -> Settings -> Management Keys ` +
        `and is NOT the same credential as XAI_API_KEY.`,
    };
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await post(
    setup.config,
    `/v1/billing/teams/${encodeURIComponent(setup.config.teamId)}/usage`,
    buildDailyUsageRequest(day, options.timezone ?? "UTC"),
    fetchImpl,
    options.timeoutMs ?? 15_000,
  );
  if (!res.ok) return res;
  return sumDailyUsage(day, res.value, options.voiceNeedle ?? "grok-voice");
}
