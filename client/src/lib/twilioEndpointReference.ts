/**
 * What the Twilio page's endpoint reference card says, kept here so it can be
 * tested without a browser.
 *
 * Until 2026-11-26 the card listed `/api/voice/inbound?agent=<slug>` (a
 * retired pattern no pipeline serves for a new call), a "SIP header routing"
 * path, and two hardcoded numbers, one of them labelled answering-service
 * when it carries the records lane on the runtime. Someone following it in
 * the Twilio console could move a live line onto the retired pipeline by hand.
 *
 * It now says only things that are true of the running code:
 * - a runtime lane is `https://<published host>/voice/<lane>` (server
 *   `POST /voice/:slug`, src/runtime/voiceRuntime.ts);
 * - the operator line's inbound Voice URL is
 *   `https://<published host>/api/voice/operator-line/inbound`, exactly
 *   (server/index.ts lets that path, and a few of the operator line's own
 *   callback paths, past the proxy; no trailing slash);
 * - a number is repointed in the Twilio console, and moving a live line is
 *   Wayne's decision (standing instruction 11).
 *
 * No phone number is written here. Which number points at which lane is a
 * fact about Twilio, read live from Twilio; this page only lists the lanes the
 * running build says it can answer (`GET /voice/health`), and says which host
 * that list came from, because a workspace (`*.replit.dev`) answers the same
 * request with its own build's lanes.
 */

/** The placeholder for the host. Never computed from the page's own URL:
 * a workspace (`*.replit.dev`) host answers too, but runs another build. */
export const PUBLISHED_HOST = '<published host>'

export const RUNTIME_URL_SHAPE = `https://${PUBLISHED_HOST}/voice/<lane>`

/** Exact, case-sensitive, no trailing slash (server/index.ts). */
export const OPERATOR_INBOUND_PATH = '/api/voice/operator-line/inbound'

export const OPERATOR_INBOUND_URL = `https://${PUBLISHED_HOST}${OPERATOR_INBOUND_PATH}`

/** The operator line's Voice fallback URL and its messaging URL: the two other
 * paths on that number that reach the voice runtime (server/index.ts lists
 * these, the inbound path, and the runtime's own callback paths). */
export const OPERATOR_FALLBACK_PATH = '/api/voice/operator-line/fallback'
export const OPERATOR_SMS_PATH = '/api/voice/operator-line/sms'

export const WHERE_TO_REPOINT =
  "This page does not change a number. Repoint a number in the Twilio console; moving a live line is Wayne's decision."

/** The part of `GET /voice/health` this card reads. */
export interface HealthLane {
  slug: string
  servable: boolean
  /** Set only on an outbound campaign with a demo and a live mode (NPX). */
  outboundMode?: 'demo' | 'live' | null
}

export interface VoiceHealthLanes {
  /** False when this process cannot run a call at all: every lane then
   * answers with the unavailable line (voiceWebhook.ts). */
  liveReady?: boolean
  /** Env var NAMES the runtime is missing, never values. */
  missing?: string[] | null
  marker?: string | null
  lanes?: HealthLane[] | null
}

export interface ListedLane {
  slug: string
  /** The Voice URL path for this lane. */
  path: string
  /** An outbound campaign: point only its caller-ID number here, which takes
   * calls back from the people the campaign rang. Its dialled calls carry
   * their own answer URL and need no number. */
  outbound: boolean
}

/** The runtime path for a lane. */
export function runtimePathFor(slug: string): string {
  return `/voice/${slug}`
}

/**
 * The lanes the running build says it can answer right now, in the order
 * `/voice/health` lists them. A lane it reports as not servable is left out,
 * because pointing a number at it would not be answered, and so is every lane
 * when the build says it is not live-ready. Null when the health report has no
 * lane list (an older build, or the roster failed).
 */
export function servableLanes(health: VoiceHealthLanes | null | undefined): ListedLane[] | null {
  const lanes = health?.lanes
  if (!Array.isArray(lanes)) return null
  if (health?.liveReady === false) return []
  const seen = new Set<string>()
  const out: ListedLane[] = []
  for (const lane of lanes) {
    if (!lane || lane.servable !== true || typeof lane.slug !== 'string') continue
    const slug = lane.slug.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || seen.has(slug)) continue
    seen.add(slug)
    out.push({
      slug,
      path: runtimePathFor(slug),
      outbound: lane.outboundMode === 'demo' || lane.outboundMode === 'live',
    })
  }
  return out
}

/**
 * Why this build cannot answer any call, when it says so: the env var names
 * `/voice/health` reports missing (names only). Null when it is live-ready or
 * does not say.
 */
export function notLiveReady(health: VoiceHealthLanes | null | undefined): string[] | null {
  if (health?.liveReady !== false) return null
  const missing = Array.isArray(health.missing) ? health.missing : []
  return missing.filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9_ ()]+$/.test(name))
}

/** A Replit workspace host: it answers `/voice/health` with its own build. */
export function isWorkspaceHost(host: string): boolean {
  const name = host.toLowerCase().split(':')[0]
  return name.endsWith('.replit.dev') || name.endsWith('.repl.co')
}
