/**
 * What a Twilio number's Voice URL points at, and why the Twilio page's
 * "Configure for agent" action may never change it.
 *
 * Measured 2026-11-26, before this was written:
 *
 * - The action wrote `https://<DOMAIN>/api/voice/<slug>/incoming`. No route
 *   on either pipeline serves that path. The old core serves
 *   `/api/voice/<slug>` (no `/incoming`); the runtime serves `/voice/<slug>`.
 *   So the write could only ever point a number at a 404, and every call to
 *   that number would fail (unless the number has a fallback URL set in
 *   Twilio, which was not checked).
 * - Ten numbers carried runtime calls in the 14 days to 2026-11-26 (the
 *   number's last four digits): 0771 pcp, 1218 and 8277 surgery, 1543 and
 *   2449 no-ivr, 3027 npx-outreach, 3213 si-assistant, 3692 optical, 5645
 *   records, 6683 tech. The Hub's `phone_endpoints` copy of their Voice URLs
 *   was last synced 2026-02-16 and still shows the old `/api/voice/...`
 *   paths, so the page cannot be trusted to say which line is live; the
 *   number's Voice URL must be read from Twilio itself.
 * - Five numbers point at a Twilio Studio flow (the practice's own phone
 *   menu). Writing the dead URL onto one of those breaks a main line, and it
 *   is not a runtime URL, so a guard on runtime URLs alone would not catch it.
 *
 * Standing instruction 11: repointing a number is Wayne's decision. So the
 * action refuses every number and changes nothing; the refusal says what the
 * number is pointed at now. Writing the runtime URL from the dashboard, with
 * a preview and a confirmation, is a separate decision left to him.
 *
 * `updatePhoneEndpointWebhook` (the admin-only update-webhook route, which
 * writes a URL the caller gives, and which no page or script calls) writes
 * to Twilio only when the number has no Voice URL. Four Codex rounds on #528
 * each found a URL that this module's copy of the server's routing read
 * differently from the real router (a longer path, another host, a mistyped
 * lane, a percent-encoded lane, a slash or case variant of the operator
 * line's path). So no write decision rests on that copy any more: a number
 * that has a Voice URL is not overwritten from the dashboard, whatever it
 * points at. `classifyVoiceUrl` only words the refusal (and says whether
 * the number has a Voice URL at all).
 */

/** What a Voice URL is answered by. */
export type VoiceUrlKind =
  /** A voice runtime address: exactly `/voice/<slug>`, or the operator
   * line's inbound webhook. Read from the path only, so the wording says
   * "a voice runtime address" and shows the URL, and never claims the number
   * reaches THIS deployment (Codex on #528, round 5). */
  | 'runtime'
  /** The retired SIP core, behind the `/api/voice` proxy. */
  | 'retired'
  /** Any other Voice URL: a Twilio Studio flow, another app, a broken URL.
   * A Voice URL being set does not prove it answers calls (a TwiML App on
   * the number takes precedence), so the wording only reports it. */
  | 'other'
  /** No Voice URL set. */
  | 'none';

export interface VoiceUrlClass {
  kind: VoiceUrlKind;
  /** For a runtime URL, the lane slug it names. */
  lane?: string;
}

/** The operator line's inbound webhook lives under `/api/voice` but is
 * served by the runtime: server/index.ts lets this exact path past the proxy
 * (case-sensitive, no trailing slash), so it is compared the same way. */
const OPERATOR_INBOUND_PATH = '/api/voice/operator-line/inbound';

function rawPathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** Express matches `/voice/:slug` case-insensitively and accepts ONE optional
 * trailing slash (`/voice/records/` routes, `/voice/records//` does not;
 * checked on Express 5). */
function foldedPath(raw: string): string {
  return raw.toLowerCase().replace(/\/$/, '') || '/';
}

/** Single-segment `/voice/<x>` paths the runtime mounts that are not a
 * number's webhook: `GET /voice/health`, the outbound dialler's prefix, the
 * media stream. */
const NOT_A_LANE = new Set(['health', 'outbound', 'stream']);

/**
 * The lane a number's Voice URL reaches on the runtime, or null. Only
 * `POST /voice/:slug` (one segment) and the operator line's inbound webhook
 * take a new call; `/voice/<slug>/after`, the outbound dialler's callbacks
 * and anything longer are continuations or 404s.
 *
 * This words a refusal; it decides nothing. It does not decode a
 * percent-encoded lane, check the slug against the registered lanes, or read
 * the host, and none of that can move a line, because a number with a Voice
 * URL is refused whatever this answers.
 */
function runtimeLaneOf(raw: string): string | null {
  if (raw === OPERATOR_INBOUND_PATH) return 'operator-line';
  const lane = /^\/voice\/([a-z0-9][a-z0-9-]*)$/.exec(foldedPath(raw));
  return lane && !NOT_A_LANE.has(lane[1]) ? lane[1] : null;
}

/** Say what answers a Voice URL, by its path, for the refusal's wording. */
export function classifyVoiceUrl(url: string | null | undefined): VoiceUrlClass {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return { kind: 'none' };
  const raw = rawPathOf(trimmed);
  if (raw === null) return { kind: 'other' };
  const lane = runtimeLaneOf(raw);
  if (lane) return { kind: 'runtime', lane };
  const path = foldedPath(raw);
  if (path === '/api/voice' || path.startsWith('/api/voice/')) return { kind: 'retired' };
  return { kind: 'other' };
}

/** Why nothing was changed. */
export type PhoneLineRefusalReason =
  | 'runtime_line'
  | 'live_line'
  | 'no_voice_url'
  | 'voice_url_unreadable';

/** A refusal the routes return as-is: nothing was written to Twilio or to
 * our own table. */
export class PhoneLineRefusal extends Error {
  readonly status = 409;
  constructor(
    readonly reason: PhoneLineRefusalReason,
    message: string,
    readonly currentVoiceUrl: string | null,
    readonly wouldWrite: string | null,
  ) {
    super(message);
    this.name = 'PhoneLineRefusal';
  }

  body() {
    return {
      success: false,
      changed: false,
      reason: this.reason,
      message: this.message,
      currentVoiceUrl: this.currentVoiceUrl,
      wouldWrite: this.wouldWrite,
    };
  }
}

/** Is this thrown value a PhoneLineRefusal? Read by shape, not
 * `instanceof`: on Node 20 a dynamically imported module can be evaluated a
 * second time (the v78 and v90 outages), and then the route's copy of the
 * class is not the service's. */
export function isPhoneLineRefusal(error: unknown): error is PhoneLineRefusal {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PhoneLineRefusal' &&
    typeof (error as { body?: unknown }).body === 'function'
  );
}

const NOT_CHANGED = 'Nothing was changed, in Twilio or here.';
const WHERE_TO_REPOINT =
  'Repointing a number is done in the Twilio console, and moving a live line is Wayne\'s decision.';
const DEAD_PATH =
  'The URL this action writes (/api/voice/<agent>/incoming) is not served by either voice pipeline, so every call to the number would fail.';

/** The current Voice URL, as read from Twilio: a value (possibly empty), or
 * the read failed. */
export type LiveVoiceUrl = { ok: true; url: string | null } | { ok: false };

/**
 * "Configure for agent" never changes a number. This builds the refusal,
 * worded for what the number is pointed at now.
 */
export function configureForAgentRefusal(
  phoneNumber: string,
  current: LiveVoiceUrl,
  wouldWrite: string | null,
): PhoneLineRefusal {
  if (!current.ok) {
    return new PhoneLineRefusal(
      'voice_url_unreadable',
      `Could not read ${phoneNumber}'s current Voice URL from Twilio, so it was not checked. ${NOT_CHANGED}`,
      null,
      wouldWrite,
    );
  }
  const now = classifyVoiceUrl(current.url);
  switch (now.kind) {
    case 'runtime':
      return new PhoneLineRefusal(
        'runtime_line',
        `${phoneNumber} points at a voice runtime address (lane "${now.lane}"): ${current.url}. ` +
          `Configure for agent would move it to the retired pipeline. ${DEAD_PATH} ${NOT_CHANGED} ${WHERE_TO_REPOINT}`,
        current.url,
        wouldWrite,
      );
    case 'none':
      return new PhoneLineRefusal(
        'no_voice_url',
        `${phoneNumber} has no Voice URL. ${DEAD_PATH} ${NOT_CHANGED} ${WHERE_TO_REPOINT}`,
        null,
        wouldWrite,
      );
    default:
      return new PhoneLineRefusal(
        'live_line',
        `${phoneNumber} has a Voice URL set: ${current.url}. ${DEAD_PATH} ${NOT_CHANGED} ${WHERE_TO_REPOINT}`,
        current.url,
        wouldWrite,
      );
  }
}

/**
 * For a write of a URL the caller chose (update-webhook): the dashboard
 * writes a Voice URL only onto a number that has none. A number that answers
 * calls, or points at a broken URL, is repointed in the Twilio console.
 * Returns null when the write may go ahead.
 */
export function webhookWriteRefusal(
  phoneNumber: string,
  current: LiveVoiceUrl,
  target: string,
): PhoneLineRefusal | null {
  if (!current.ok) {
    return new PhoneLineRefusal(
      'voice_url_unreadable',
      `Could not read ${phoneNumber}'s current Voice URL from Twilio, so it was not checked. ${NOT_CHANGED}`,
      null,
      target,
    );
  }
  const now = classifyVoiceUrl(current.url);
  if (now.kind === 'none') return null;
  const where =
    now.kind === 'runtime'
      ? `${phoneNumber} points at a voice runtime address (lane "${now.lane}"): ${current.url}.`
      : `${phoneNumber} already has a Voice URL (${current.url}).`;
  return new PhoneLineRefusal(
    now.kind === 'runtime' ? 'runtime_line' : 'live_line',
    `${where} The dashboard writes a Voice URL only onto a number that has none. ${NOT_CHANGED} ${WHERE_TO_REPOINT}`,
    current.url,
    target,
  );
}
