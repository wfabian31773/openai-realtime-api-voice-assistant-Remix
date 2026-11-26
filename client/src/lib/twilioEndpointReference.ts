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
 * It now says only three things, each true of the running code:
 * - a runtime lane is `https://<published host>/voice/<lane>` (server
 *   `POST /voice/:slug`, src/runtime/voiceRuntime.ts);
 * - the operator line is `https://<published host>/api/voice/operator-line/inbound`,
 *   the one `/api/voice` path the runtime answers (server/index.ts lets that
 *   exact path past the proxy, no trailing slash);
 * - a number is repointed in the Twilio console, and moving a live line is
 *   Wayne's decision (standing instruction 11).
 *
 * No phone number is written here. Which number points at which lane is a
 * fact about Twilio, read live from Twilio; this page only lists the lanes the
 * running build says it can answer (`GET /voice/health`).
 */

/** The placeholder for the host. Never computed from the page's own URL:
 * a workspace (`*.replit.dev`) host answers too, but runs another build. */
export const PUBLISHED_HOST = '<published host>'

export const RUNTIME_URL_SHAPE = `https://${PUBLISHED_HOST}/voice/<lane>`

/** Exact, case-sensitive, no trailing slash (server/index.ts). */
export const OPERATOR_INBOUND_PATH = '/api/voice/operator-line/inbound'

export const OPERATOR_INBOUND_URL = `https://${PUBLISHED_HOST}${OPERATOR_INBOUND_PATH}`

export const WHERE_TO_REPOINT =
  "This page does not change a number. Repoint a number in the Twilio console; moving a live line is Wayne's decision."

/** The part of `GET /voice/health` this card reads. */
export interface HealthLane {
  slug: string
  servable: boolean
}

export interface VoiceHealthLanes {
  lanes?: HealthLane[] | null
}

/** The runtime path for a lane. */
export function runtimePathFor(slug: string): string {
  return `/voice/${slug}`
}

/**
 * The lanes the running build says it can answer right now, in the order
 * `/voice/health` lists them. A lane it reports as not servable is left out,
 * because pointing a number at it would not be answered. Null when the health
 * report has no lane list (an older build, or the roster failed).
 */
export function servableLanes(health: VoiceHealthLanes | null | undefined): string[] | null {
  const lanes = health?.lanes
  if (!Array.isArray(lanes)) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const lane of lanes) {
    if (!lane || lane.servable !== true || typeof lane.slug !== 'string') continue
    const slug = lane.slug.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  return out
}
