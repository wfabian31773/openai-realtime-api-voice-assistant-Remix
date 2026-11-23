/**
 * WHO THIS URGENT CALL GOES TO — the rotation, the post-op exception and the
 * escalation chain, decided once per call, bounded, and never throwing.
 *
 * The answer is a ChainPlan (the levels, in order, each with the number it
 * rings) and the PHI-free facts that explain it, which the escalation row and
 * the attempt log carry so "where each urgent call ended up" can be read back.
 *
 * WHEN THE ROTATION DOES NOT DECIDE, today's path stands (the one fixed
 * on-call number, HUMAN_AGENT_NUMBER):
 *   - the switch is off, or a lever is wrong (config.ts says why);
 *   - the on_call_* tables are not on the Hub yet, or cannot be read in time;
 *   - it is weekday daytime (Mon–Fri 08:00–16:59 Pacific), which the operator
 *     ruled is not on call ("Weekday daytime hours are not on-call");
 *   - the plan has no level at all (nobody entered for the week and no final
 *     director).
 * In TEST mode with empty tables a synthetic chain over the test numbers runs
 * instead, so the flow can be heard before the CSVs are imported.
 */
import {
  addDays,
  onCallAt,
  pacificMinute,
  planChain,
  type ChainPlan,
  type OnCallAnswer,
  type RotationData,
} from "./rotation";
import { decidePostOp, postOpRouteFor, type PostOpDecision } from "./postOp";
import type { OnCallConfig } from "./config";
import { testPhoneFor } from "./config";
import type { OnCallStore, Query, RoutingFacts } from "./store";

export type LegacyBecause =
  | "mode_off"
  | "store_unavailable"
  | "rotation_unreadable"
  | "weekday_daytime"
  | "no_levels";

export type RouteDecision =
  | { kind: "rotation"; plan: ChainPlan; routing: RoutingFacts; alertNote?: string }
  | { kind: "legacy"; because: LegacyBecause; routing?: RoutingFacts };

/** The whole routing step must answer inside this, so the dial is not held. */
export const ROUTING_BUDGET_MS = 2_500;
/** Of which the Console's post-op read may take. */
export const POST_OP_BUDGET_MS = 1_500;
/** The rotation is re-read at most this often. */
export const ROTATION_CACHE_MS = 60_000;

/**
 * The alert text for a notable rotation answer, so the provider or director
 * rung knows why they are the one being called. PHI-free.
 */
export function rotationNoteText(answer: Pick<OnCallAnswer, "note" | "provider">): string | undefined {
  switch (answer.note) {
    case undefined:
      return undefined;
    case "no_schedule_for_week":
      return "No on-call provider is entered for this week, so the chain went straight to the final director.";
    case "provider_missing":
      return "This week's on-call provider is not on file, so the chain went straight to the final director.";
    case "provider_inactive":
      return "This week's on-call provider is marked inactive, so the chain went straight to the final director.";
    case "override_provider_inactive":
    case "override_provider_missing": {
      const why = answer.note === "override_provider_inactive" ? "is marked inactive" : "is not on file";
      return answer.provider
        ? `The cover entered for this time ${why}, so this week's scheduled provider is being called.`
        : `The cover entered for this time ${why} and this week's scheduled provider cannot be rung either, so the chain went straight to the final director.`;
    }
  }
}

/** One cached read of the rotation per process. */
export function createRotationCache(
  store: Pick<OnCallStore, "loadRotation">,
  now: () => number = Date.now,
): { get(): Promise<RotationData>; clear(): void } {
  let value: RotationData | null = null;
  let at = 0;
  let inflight: Promise<RotationData> | null = null;
  return {
    async get() {
      if (value && now() - at < ROTATION_CACHE_MS) return value;
      if (inflight) return inflight;
      inflight = store
        .loadRotation()
        .then((r) => {
          value = r;
          at = now();
          return r;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    clear() {
      value = null;
      at = 0;
    },
  };
}

function isEmpty(data: RotationData): boolean {
  return data.providers.length === 0 && data.schedule.size === 0;
}

/** The synthetic chain test mode runs on before the rotation is imported. */
export function syntheticTestPlan(config: OnCallConfig): ChainPlan {
  const roles = ["on_call", "region_director", "final"] as const;
  return {
    levels: roles.map((role, i) => ({
      role,
      providerId: -(i + 1),
      name: `Test level ${i + 1}`,
      phone: testPhoneFor(config, i),
    })),
    notes: ["synthetic_test_chain"],
  };
}

/** In test mode every level rings a test number, level by level. */
export function withTestPhones(plan: ChainPlan, config: OnCallConfig): ChainPlan {
  if (config.mode !== "test") return plan;
  return { ...plan, levels: plan.levels.map((l, i) => ({ ...l, phone: testPhoneFor(config, i) })) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
}

export interface RouteInput {
  at: Date;
  config: OnCallConfig;
  store: Pick<OnCallStore, "available" | "loadRotation">;
  rotation: { get(): Promise<RotationData> };
  /** The call's CERTAIN identity's person_id, or undefined. */
  personId: string | undefined;
  /** The Console query, or null when the Console is not configured. */
  consoleQuery: Query | null;
  budgetMs?: number;
}

function postOpFacts(d: PostOpDecision): RoutingFacts["postOp"] {
  if (d.route === "surgeon") {
    return { route: "surgeon", surgeryDate: d.surgeryDate, daysAgo: d.daysAgo, kept: d.kept };
  }
  return { route: "on_call", reason: d.reason, ...(d.surgeryDate ? { surgeryDate: d.surgeryDate } : {}) };
}

/**
 * Decide the route for one urgent call at `at`. Never throws; anything it
 * cannot read sends the call down today's path and says which part failed.
 */
export async function decideRoute(input: RouteInput): Promise<RouteDecision> {
  const { config, at } = input;
  if (config.mode === "off") return { kind: "legacy", because: "mode_off" };
  // One deadline for the whole decision: every wait gets only what is left of
  // it, so a slow store check and a slow rotation read cannot each spend the
  // full budget and hold the caller longer than the budget says.
  const deadline = Date.now() + (input.budgetMs ?? ROUTING_BUDGET_MS);
  const left = () => Math.max(0, deadline - Date.now());

  try {
    const available = await withTimeout(input.store.available(), left());
    if (available !== true) return { kind: "legacy", because: "store_unavailable" };

    const data = await withTimeout(input.rotation.get(), left());
    if (!data) return { kind: "legacy", because: "rotation_unreadable" };

    const answer = onCallAt(at, data);
    const base = {
      window: answer.window.reason,
      weekStartsOn: answer.weekStartsOn,
      source: answer.source,
    };
    if (!answer.window.onCall) {
      return {
        kind: "legacy",
        because: "weekday_daytime",
        routing: { ...base, reason: "on_call", notes: [] },
      };
    }

    if (config.mode === "test" && isEmpty(data)) {
      return {
        kind: "rotation",
        plan: syntheticTestPlan(config),
        routing: { ...base, reason: "test_synthetic", notes: ["synthetic_test_chain"] },
      };
    }

    const today = pacificMinute(at).date;
    const postOp = await postOpRouteFor({
      personId: input.personId,
      today,
      providers: data.providers,
      query: input.consoleQuery,
      budgetMs: Math.min(POST_OP_BUDGET_MS, left()),
      requireKept: config.requireKept,
    });

    const notes: string[] = [];
    if (answer.note) notes.push(answer.note);
    let first: Parameters<typeof planChain>[0] = null;
    let reason: RoutingFacts["reason"];
    if (postOp.route === "surgeon") {
      first = { role: "surgeon", provider: postOp.provider };
      reason = "post_op_surgeon";
    } else {
      first = answer.provider ? { role: "on_call", provider: answer.provider } : null;
      // "post_op_uncertain" means a recent surgery WAS found and its surgeon
      // could not be rung; a check that could not be made at all (no
      // confirmed patient, no Console) keeps the ordinary reason, and its
      // note still says so in the alert text.
      reason = postOp.surgeryDate
        ? "post_op_uncertain"
        : answer.window.reason === "holiday_daytime"
          ? "holiday_daytime"
          : "on_call";
    }
    const chain = planChain(first, data);
    notes.push(...chain.notes);
    const plan = withTestPhones({ levels: chain.levels, notes }, config);
    // The rotation's own note says why the person rung is who they are (an
    // empty week, a stale cover); on the surgeon route the rotation was not
    // used, so only the post-op note applies.
    const alertNote =
      [postOp.route === "surgeon" ? undefined : rotationNoteText(answer), postOp.note]
        .filter((n): n is string => Boolean(n))
        .join(" ") || undefined;
    const routing: RoutingFacts = {
      ...base,
      reason,
      postOp: postOpFacts(postOp),
      ...(alertNote ? { note: alertNote } : {}),
      notes,
    };
    if (plan.levels.length === 0) return { kind: "legacy", because: "no_levels", routing };
    return { kind: "rotation", plan, routing, ...(alertNote ? { alertNote } : {}) };
  } catch {
    return { kind: "legacy", because: "rotation_unreadable" };
  }
}

/** For tests and the seed check: the plan for a moment, with no post-op patient. */
export function planAt(at: Date, data: RotationData): ChainPlan {
  const a = onCallAt(at, data);
  return planChain(a.provider ? { role: "on_call", provider: a.provider } : null, data);
}

// Re-exported so the runner and tests have one import for the date helpers.
export { addDays, decidePostOp };
