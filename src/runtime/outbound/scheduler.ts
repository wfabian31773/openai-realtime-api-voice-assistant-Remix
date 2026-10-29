/**
 * src/runtime/outbound/scheduler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The clock that drives every outbound campaign. Once a minute: take the
 * fleet-wide dialler lock, find every registered outbound lane whose
 * campaign is switched on, and run one tick of each (./dialer.ts).
 *
 * Started by the voice runtime ONLY when RUNTIME_OUTBOUND_DIALING=1. With
 * the switch off nothing here runs — no timer, no lock, no query.
 *
 * AND ONLY ON A PROCESS THAT CAN TAKE THE CALL IT PLACES. Two things are
 * checked before anybody is claimed (outboundPrerequisiteMissing): a public
 * host Twilio can post the answer and the status back to, and a runtime that
 * is live-ready. A call placed without either still rings a person and
 * spends one of their attempts — Twilio refuses an empty callback URL only
 * after the attempt row exists, and a not-live-ready process can only tell
 * the person who answered that it is unavailable (Codex round 2, #357).
 *
 * ONE DIALLER AT A TIME. The atomic claim already guarantees a person is
 * never rung twice by two processes; the lock is what keeps a campaign's
 * concurrency honest when the deployment runs more than one instance, and it
 * is held only for the length of a tick. A tick that cannot get the lock
 * does nothing; the instance that holds it is dialling.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { OPERATOR_SLUG } from "../../plugin/operatorLine";
import type { LaneSource } from "../laneRegistry";
import type { OutboundLanePolicy } from "./campaign";
import { computeRuntimeReadiness } from "../readiness";
import { campaignEnabled, outboundDialingEnabled } from "./campaign";
import { runCampaignTick, type DialerDeps, type TickResult } from "./dialer";

export const OUTBOUND_TICK_MS = 60 * 1000;
export const OUTBOUND_LOCK_NAME = "runtime-outbound-dialer";

export interface DialerLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export interface SchedulerDeps extends Omit<DialerDeps, "store" | "twilio"> {
  laneSource: () => Promise<LaneSource>;
  /** Lazily built: the store opens the Hub pool, the client reads Twilio creds. */
  store: () => Promise<DialerDeps["store"]>;
  twilio: () => Promise<DialerDeps["twilio"]>;
  lock: DialerLock;
  /** The slugs of the registry's outbound lanes (agentRegistry.getOutboundAgents). */
  slugs: () => Promise<string[]>;
}

/** Why this process must not dial at all, or null when it may. Names
 * only, never a value — the same rule as /voice/health. */
export function outboundPrerequisiteMissing(
  deps: Pick<SchedulerDeps, "env" | "host">,
): string | null {
  if (!deps.host) return "no public host (DOMAIN, REPLIT_DOMAINS or REPLIT_DEV_DOMAIN)";
  const readiness = computeRuntimeReadiness(deps.env);
  if (!readiness.liveReady) return `runtime not live-ready (missing: ${readiness.missing.join(", ")})`;
  return null;
}

/** The outbound lanes whose campaigns may dial right now, with their policy. */
export async function enabledCampaigns(
  deps: Pick<SchedulerDeps, "laneSource" | "slugs" | "env">,
): Promise<Array<{ slug: string; policy: OutboundLanePolicy }>> {
  const source = await deps.laneSource();
  const out: Array<{ slug: string; policy: OutboundLanePolicy }> = [];
  for (const slug of await deps.slugs()) {
    // Operator calls are immediate free-form goals: NO daily cap or peak window.
    // Never send this lane through campaign scheduling, even if its env is set.
    if (slug === OPERATOR_SLUG) continue;
    const config = source.getAgentConfig(slug);
    if (!config?.enabled || config.agentType !== "outbound" || !config.outbound) continue;
    if (!campaignEnabled(config.outbound, deps.env)) continue;
    out.push({ slug, policy: config.outbound });
  }
  return out;
}

/** One pass over every enabled campaign, under the lock. Never throws. */
export async function runOutboundTick(deps: SchedulerDeps): Promise<TickResult[]> {
  if (!outboundDialingEnabled(deps.env)) return [];
  if (outboundPrerequisiteMissing(deps)) return [];
  const campaigns = await enabledCampaigns(deps).catch(() => []);
  if (campaigns.length === 0) return [];
  if (!(await deps.lock.acquire().catch(() => false))) return [];
  try {
    const [store, twilio] = await Promise.all([deps.store(), deps.twilio()]);
    const results: TickResult[] = [];
    for (const { slug, policy } of campaigns) {
      results.push(await runCampaignTick(slug, policy, { ...deps, store, twilio }));
    }
    return results;
  } catch (error) {
    (deps.log ?? console.log)(
      `[outbound] tick could not start — ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  } finally {
    await deps.lock.release().catch(() => undefined);
  }
}

/** Start the minute clock. Returns the stop function. */
export function startOutboundScheduler(deps: SchedulerDeps, intervalMs = OUTBOUND_TICK_MS): () => void {
  if (!outboundDialingEnabled(deps.env)) return () => undefined;
  const missing = outboundPrerequisiteMissing(deps);
  if (missing) {
    (deps.log ?? console.log)(`[outbound] dialler NOT started — ${missing}; nothing will be dialled`);
    return () => undefined;
  }
  let running = false;
  // One per scheduler, so a confirmed callback route is trusted for a while
  // and a wrong one is logged once rather than every minute.
  const routeCache = deps.routeCache ?? new Map();
  // And when each live-fed campaign last refreshed its queue (v107).
  const sourceRefreshedAt = deps.sourceRefreshedAt ?? new Map<string, number>();
  const timer = setInterval(() => {
    if (running) return; // a slow tick is never overlapped by the next
    running = true;
    void runOutboundTick({ ...deps, routeCache, sourceRefreshedAt }).finally(() => {
      running = false;
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
