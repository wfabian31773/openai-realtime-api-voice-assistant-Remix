/**
 * WHICH LANES THIS DEPLOYMENT CAN ACTUALLY SERVE, AND WHY NOT.
 *
 * The operator, 2026-09-04: *"Let's also ensure that the runtime has
 * everything that we needed on there."* Until now the only way to answer
 * that was to point a phone number at a lane and listen — `laneSupportStatus`
 * has always been pure and always returned a reason, and nothing ever
 * surfaced it. `/voice/health` reported the transport and the credentials
 * and never once said "this lane is refused, here is the sentence why".
 *
 * IT DOES NOT REPORT WHAT TWILIO POINTS AT. The code cannot know that, and a
 * hardcoded list of which lanes are "live" is precisely the kind of fact
 * that rots and then gets quoted — the failure this project keeps writing
 * down. This reports only what the running process actually knows: for each
 * lane, can I serve a call on it right now, and if not, what is missing.
 *
 * TWO GATES, NOT ONE. A transfer-capable lane can pass `laneSupportStatus`
 * and still fail every transfer it attempts, because the transport being
 * armed and there being a NUMBER TO DIAL are separate things — pcp dials
 * PCP_HUMAN_AGENT_NUMBER, the no-ivr family dials HUMAN_AGENT_NUMBER, and a
 * deployment can have one and not the other. Codex caught that for the
 * top-level `transferReady` flag in PR #236; per lane it was still invisible,
 * which matters most for exactly the lane being prepared next.
 */
import { laneSupportStatus, type LaneSource } from "./laneRegistry";
import { transferDestinationStatus } from "./runtimeTransfer";

/**
 * The lanes worth reporting on: the four queues, the two after-hours agents,
 * pcp, and scheduling. Deliberately not every registered agent — the
 * outbound and novelty ones would be noise in a health check whose job is to
 * answer one question at a glance.
 */
export const REPORTED_LANES = [
  "optical",
  "surgery",
  "tech",
  "records",
  "answering-service",
  "no-ivr",
  "pcp",
  "azul-scheduling",
] as const;

/** Which env var holds the number a lane dials, when it dials one. */
const DESTINATION_ENV: Record<string, "clinical" | "pcp"> = {
  "no-ivr": "clinical",
  "no-ivr-v2": "clinical",
  "dev-no-ivr": "clinical",
  pcp: "pcp",
};

export interface LaneReadiness {
  slug: string;
  /** Registered in this build at all. A false here is a typo or a rename. */
  registered: boolean;
  /** This runtime would answer a call on this lane right now. */
  servable: boolean;
  /** The sentence explaining a false `servable`. Null when it is true. */
  blockedBy: string | null;
  /**
   * Servable, but its transfer would fail for want of a number to dial.
   * Not a refusal — the lane still answers, takes the request and files it.
   * Null when the lane never transfers, or when its destination is set.
   */
  transferWarning: string | null;
}

export function laneRoster(
  source: LaneSource,
  env: Record<string, string | undefined>,
  opts: { transferAvailable: boolean },
): LaneReadiness[] {
  const destinations = transferDestinationStatus(env);
  return REPORTED_LANES.map((slug) => {
    const config = source.getAgentConfig(slug);
    if (!config) {
      return {
        slug,
        registered: false,
        servable: false,
        blockedBy: `lane '${slug}' is not registered in this build`,
        transferWarning: null,
      };
    }
    /**
     * `resolveLane` returns null for a disabled lane BEFORE it ever calls
     * laneSupportStatus, and laneSupportStatus does not check the flag — so
     * the roster would advertise a deliberately switched-off lane as
     * servable, defeating the report at exactly the moment it matters
     * (Codex, PR #268 round 4). Checked first, for the same reason
     * resolveLane checks it first.
     */
    const blockedBy =
      config.enabled === false
        ? `lane '${slug}' is registered but disabled in the agent registry`
        : laneSupportStatus(config, { transferAvailable: opts.transferAvailable });
    const which = DESTINATION_ENV[slug];
    const destinationSet = which ? destinations[which] : true;
    return {
      slug,
      registered: true,
      servable: blockedBy === null,
      blockedBy,
      transferWarning:
        blockedBy === null && which && !destinationSet
          ? `lane '${slug}' is served and its transport is armed, but no destination is ` +
            `configured (${which === "pcp" ? "PCP_HUMAN_AGENT_NUMBER" : "HUMAN_AGENT_NUMBER"}) — ` +
            `every transfer it attempts will fail at resolveHandoffDestination`
          : null,
    };
  });
}

/**
 * The boot lines. One per lane, so the log answers "can this deployment
 * serve pcp?" without a call and without shell access — the same reason the
 * transfer's own availability is logged once at mount rather than discovered
 * live.
 */
export function formatLaneRoster(roster: LaneReadiness[]): string[] {
  const servable = roster.filter((l) => l.servable).map((l) => l.slug);
  const lines = [
    `[voice-runtime] lanes this deployment can serve (${servable.length}/${roster.length}): ` +
      (servable.length ? servable.join(", ") : "NONE"),
  ];
  for (const lane of roster) {
    if (lane.blockedBy) lines.push(`[voice-runtime]   ✗ ${lane.slug}: ${lane.blockedBy}`);
    else if (lane.transferWarning) lines.push(`[voice-runtime]   ! ${lane.transferWarning}`);
  }
  return lines;
}
