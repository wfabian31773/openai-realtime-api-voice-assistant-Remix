/**
 * src/runtime/laneRegistry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Resolves a lane slug to an agent bound onto the voice runtime.
 *
 * It deliberately builds NO registry of its own. `src/config/agents.ts`
 * already holds every lane — id, factory, enabled, voice, language,
 * version — and the OpenAI SIP core routes through it today. A second
 * registry would be a second place for a lane to be enabled, and the first
 * time the two disagreed the answer to "is surgery live?" would depend on
 * which file you read. This module reads that one.
 *
 * So the chain, end to end, is:
 *
 *   slug -> agentRegistry.getAgentConfig(slug)   (the registry that exists)
 *        -> factory(handoff, metadata)           (the agent's own factory)
 *        -> bindAgent(agent, knowledge pack)     (instructions + tools, verbatim)
 *        -> GrokVoiceSession                     (the wire)
 *
 * and adding a lane is a registry entry plus a prompt — which is the claim
 * ADR-001 makes and this file is what makes it literally true.
 *
 * TWO THINGS THIS MODULE REFUSES TO DO.
 *
 * NO HANDOFF IS INVENTED. Every factory takes a handoff callback first
 * because the registry's shared shape passes one. Operator ruling,
 * 2026-08-12: only PCP and Scheduling SD transfer; every other agent has NO
 * transfer tool at all, not a disabled one, because "a tool the agent
 * cannot see is a promise it cannot make." The callback passed here
 * therefore rejects rather than pretending: if a lane's own factory wires
 * it to a tool, that lane's tool fails loudly instead of silently dropping
 * a caller who was told they were being transferred. The runtime does not
 * decide which lanes transfer — the agents do, in their own files.
 *
 * NO ENABLED FLAG IS SECOND-GUESSED. A disabled lane resolves to null and
 * the webhook answers with its controlled unavailable line. Whether a line
 * takes calls is Wayne's decision, recorded in the registry and in
 * CLAUDE.md's line-status table — never inferred here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { bindAgent, type BorrowableAgent, type BoundAgent } from "./agentBinding";
import { buildKnowledgePack } from "./knowledgePack";
import {
  loadGrokRuntimeVoiceConfig,
  pickLaneEnv,
  type GrokRuntimeVoiceConfig,
} from "./config";
import { normalizeSpokenLanguage } from "./language";

/** What the runtime needs from a lane's registry entry. Structurally a
 * subset of AgentConfig in src/config/agents.ts. */
export interface LaneConfig {
  id: string;
  enabled: boolean;
  factory: (...args: never[]) => unknown;
  voice?: string;
  language?: string;
  version?: string;
  agentType?: "inbound" | "outbound";
}

/**
 * Agent factories whose argument layout is NOT `(handoff, metadata)`.
 *
 * Most lanes share that shape, but not all, and calling one of these with
 * it silently mis-slots every argument (Codex review, PR #227). The
 * after-hours case is the worst: `metadata` lands in the
 * `recordPatientInfoCallback` slot, so the agent loses caller context AND
 * later tries to invoke that plain object — reporting `system_error` after
 * a ticket was already filed, which can draw a duplicate retry.
 *
 * The existing SIP transport handles this with an explicit per-slug switch
 * (voiceAgentRoutes.ts). This runtime does not reproduce those adapters —
 * `recordPatientInfoCallback` is a closure over request state and roughly
 * fifty lines of database logic, and a second implementation of it would be
 * a second behaviour to keep in step. So these lanes are REFUSED here, by
 * name, until an adapter is written deliberately. Refusing is the honest
 * failure: a caller hears the controlled unavailable line instead of
 * reaching an agent that has been built wrong.
 */
const NON_UNIFORM_FACTORY_LANES: Record<string, string> = {
  "after-hours": "createAfterHoursAgent(handoff, recordPatientInfoCallback, metadata)",
  "drs-scheduler":
    "createDRSSchedulerAgent(lookupPatient, markCompleted, computer, handoff, metadata)",
  "appointment-confirmation":
    "createAppointmentConfirmationAgent(getAppointment, confirm, reschedule, cancel, markConfirmed, handoff, metadata)",
  "fantasy-football": "createFantasyFootballAgent(metadata)",
};

/**
 * Why this runtime cannot serve a lane, or null when it can. Pure, so the
 * reason can be asserted and logged rather than discovered on a live call.
 */
export function laneSupportStatus(config: LaneConfig): string | null {
  if (config.agentType && config.agentType !== "inbound") {
    return `lane '${config.id}' is an ${config.agentType} agent; this runtime answers inbound calls`;
  }
  const shape = NON_UNIFORM_FACTORY_LANES[config.id];
  if (shape) {
    return (
      `lane '${config.id}' uses a different factory argument layout — ${shape} — ` +
      "which this runtime does not model; it needs a per-lane adapter before it can be served"
    );
  }
  return null;
}

/** The registry surface this module reads. `agentRegistry` satisfies it;
 * tests substitute a fake so the whole agent tree is not imported. */
export interface LaneSource {
  getAgentConfig(id: string): LaneConfig | undefined;
}

/** Context the runtime hands the agent's factory. These are the same
 * metadata fields the SIP transport passes today, so an agent borrowed
 * here receives exactly what it receives there. */
export interface LaneCallMetadata {
  callSid: string;
  callId: string;
  callerPhone: string;
  dialedNumber: string;
  /** The call_logs row id, read through a getter by the agents that need
   * it: the row does not exist when the factory runs, and destructuring a
   * getter freezes `undefined` for the whole call. That bug is recorded in
   * answeringServiceAgent.ts and it is why this is a function. */
  callLogId?: () => string | undefined;
}

export interface ResolvedLane {
  slug: string;
  agent: BoundAgent;
  voice: GrokRuntimeVoiceConfig;
  /** The agent's own version string, for the call record and health. */
  version: string | null;
}

/** The handoff callback every factory's first parameter expects. It is a
 * rejection, not a no-op: see NO HANDOFF IS INVENTED above. */
async function refuseHandoff(): Promise<void> {
  throw new Error(
    "voice runtime: this transport performs no call transfer. A lane that " +
      "needs one must not offer the tool (operator ruling 2026-08-12).",
  );
}

/**
 * Resolve one lane. Returns null when the slug is unknown or the lane is
 * disabled — the caller answers with its controlled unavailable line
 * rather than guessing at a default agent. (The SIP core falls back to
 * no-ivr for an unmapped NUMBER; a slug that is not registered is a
 * misconfiguration, and answering it with someone else's agent is how a
 * surgery caller ends up talking to the optical prompt.)
 */
export async function resolveLane(
  slug: string,
  metadata: LaneCallMetadata,
  deps: { source: LaneSource; env?: Record<string, string | undefined> },
): Promise<ResolvedLane | null> {
  const config = deps.source.getAgentConfig(slug);
  if (!config || !config.enabled) return null;

  const unsupported = laneSupportStatus(config);
  if (unsupported) {
    // Refused BEFORE the factory is called: an agent constructed with
    // mis-slotted arguments is worse than one that never answered, because
    // it answers and then fails halfway through a patient's request.
    console.warn(`[voice-runtime] ${unsupported}`);
    return null;
  }

  // The factory's own shape, called exactly as the SIP transport calls it.
  const factory = config.factory as (
    handoff: () => Promise<void>,
    metadata: LaneCallMetadata,
  ) => unknown;
  const created = await factory(refuseHandoff, metadata);
  const agent = created as BorrowableAgent;

  const bound = bindAgent(agent, {
    // The knowledge pack leads, byte-identical on every call and every
    // lane, so the cache prefix is shared across the whole fleet before
    // the agent's own instructions make it lane-specific (ADR-001).
    instructionsPrefix: buildKnowledgePack(),
  });

  const env = deps.env ?? process.env;
  const voice = loadGrokRuntimeVoiceConfig(env, slug);
  return {
    slug,
    agent: bound,
    voice: {
      ...voice,
      // A lane that names its own voice or language in the registry keeps
      // it; the env override exists for the lanes that do not. The agents
      // record these as part of their identity and callers notice when a
      // familiar line changes voice.
      voiceName: pickLaneEnv(env, "XAI_VOICE_NAME", slug) ?? config.voice ?? voice.voiceName,
      language: normalizeSpokenLanguage(
        pickLaneEnv(env, "XAI_VOICE_LANGUAGE", slug) ?? config.language ?? voice.language,
      ),
    },
    version: config.version ?? null,
  };
}

/** The real registry, imported lazily so a health check or a unit test
 * never pulls the entire agent tree (and its database and OpenAI clients)
 * into the process. */
export async function defaultLaneSource(): Promise<LaneSource> {
  const { agentRegistry } = await import("../config/agents");
  return agentRegistry as unknown as LaneSource;
}
