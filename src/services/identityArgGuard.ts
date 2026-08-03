/**
 * Identity argument guard — catch a mangled name or date BEFORE it is sent
 * to verification, and stop a failed value being reused unchanged.
 *
 * The call this exists for (2026-07-31, 817162bf, 12 minutes, no match,
 * handed off): Paula Kolterman said "8/29/1952". The transcript recorded it
 * correctly. The tool received "1929-09-19" — her digits reassembled, the
 * DAY (29) promoted into the year and the 19 from 1952 demoted to the day.
 * The first attempt also carried the surname "Haberkern", which she never
 * said: caller-ID pre-context had matched her number to a different Paula,
 * and the prompt instructs the agent to prefer that on-file spelling.
 *
 * The second attempt corrected the surname to the one she spelled and
 * RESENT THE SAME WRONG DATE, so it failed identically. Nothing in the
 * system compares what the caller said against what the tool is about to
 * be told, and nothing notices a retry that changed only one field.
 *
 * Pure functions plus one per-call attempt ledger — no I/O, no model
 * involvement. The transcript is the evidence and the caller's own words win.
 */

/** The caller's half of the transcript only. Lines are stored by the session
 *  layer as "CALLER: ..." / "AGENT: ...". Reading the whole thing would let
 *  the agent's own mis-heard read-back count as evidence that the caller said
 *  it — which is exactly the failure being guarded against. */
export function callerSpeech(transcript: string | undefined): string {
  if (!transcript) return '';
  return transcript
    .split('\n')
    .filter((l) => /^CALLER:/i.test(l.trim()))
    .map((l) => l.replace(/^\s*CALLER:\s*/i, ''))
    .join('\n');
}

export interface DobCheck {
  /** ISO date the model wants to send */
  iso: string;
  /** true when the transcript contains a spoken date that disagrees */
  conflict: boolean;
  /** the date we believe the caller actually said, ISO, when derivable */
  callerSaid?: string;
  /** why it was rejected — spoken to the model as a correction */
  reason?: string;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Dates the caller actually spoke, newest last, as ISO strings. Handles
 *  "8/29/1952", "8-29-52", "August 29 1952", "August 29th, 1952". */
export function spokenDates(callerText: string): string[] {
  const out: string[] = [];
  const numeric = /\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})\b/g;
  let m: RegExpExecArray | null;
  while ((m = numeric.exec(callerText)) !== null) {
    const mo = +m[1], da = +m[2];
    let yr = +m[3];
    if (m[3].length <= 2) yr = yr <= 29 ? 2000 + yr : 1900 + yr;
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) out.push(`${yr}-${pad(mo)}-${pad(da)}`);
  }
  const worded = new RegExp(
    `\\b(${Object.keys(MONTHS).join('|')})\\w*\\s+(\\d{1,2})(?:st|nd|rd|th)?[,\\s]+((?:19|20)\\d{2})\\b`, 'gi');
  while ((m = worded.exec(callerText)) !== null) {
    const mo = MONTHS[m[1].toLowerCase()];
    const da = +m[2], yr = +m[3];
    if (mo && da >= 1 && da <= 31) out.push(`${yr}-${pad(mo)}-${pad(da)}`);
  }
  return out;
}

/** Same three numbers, different arrangement — the scrambling signature.
 *  1929-09-19 vs 1952-08-29 do NOT share a multiset, so this is deliberately
 *  not the test; it is a secondary signal only. */
function sameDigits(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\D/g, '').split('').sort().join('');
  return norm(a) === norm(b);
}

/** Compare the DOB the model wants to send against what the caller said.
 *  Only flags a conflict when the caller demonstrably spoke a DIFFERENT
 *  date — silence or an underivable date is never treated as disagreement,
 *  because a false block on a correct date costs the caller the whole call. */
export function checkDob(iso: string, callerText: string): DobCheck {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { iso, conflict: true, reason: `"${iso}" is not a YYYY-MM-DD date.` };
  }
  const [y] = iso.split('-').map(Number);
  const yearNow = new Date().getUTCFullYear();
  if (y < 1900 || y > yearNow) {
    return { iso, conflict: true, reason: `Year ${y} is not a plausible date of birth.` };
  }
  // Only dates that could BE a birth date are evidence about one. Callers say
  // appointment dates constantly ("can you do 8/14?"), and treating one of
  // those as a contradicted DOB would block a perfectly good verification.
  const said = spokenDates(callerText).filter((d) => {
    const yr = Number(d.slice(0, 4));
    return yr >= 1900 && yr < yearNow;
  });
  if (said.length === 0) return { iso, conflict: false };
  // LATEST wins, not "appears anywhere". If the caller said a date and then
  // corrected it, sending the superseded one is the same defect in reverse —
  // the correction is the fact, and everything else in the prompt already
  // says to continue from the caller's correction.
  const latest = said[said.length - 1];
  if (latest === iso) return { iso, conflict: false };
  return {
    iso,
    conflict: true,
    callerSaid: latest,
    reason:
      `You are about to verify with date of birth ${iso}, but the caller said ${latest}` +
      `${sameDigits(iso, latest) ? ' — the same digits in a different order' : ''}. ` +
      `Use what they said.`,
  };
}

/** Name tokens, uppercased, punctuation stripped. Handles both carrier
 *  formats — "KOLTERMAN,PAULA" and "JO WARD" — without having to know which
 *  is which, because we only ever ask "does this surname appear at all?". */
function nameTokens(raw: string): string[] {
  return raw
    .replace(/^\[Lookup\]\s*/i, '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 2);
}

/** Does the carrier's subscriber name contradict the surname the person-base
 *  matched to this phone number?
 *
 *  On 817162bf the carrier said KOLTERMAN,PAULA and the pre-context said
 *  Haberkern. The carrier was right; the pre-context had matched the number
 *  to a different patient, and the prompt told the agent to prefer the
 *  on-file spelling over anything the caller said. So it verified a name the
 *  caller never uttered.
 *
 *  A disagreement does NOT mean the carrier is right — CNAM routinely carries
 *  a spouse, a parent, or a stale account holder. It means the pre-context
 *  surname is no longer trustworthy enough to put in the model's mouth, so we
 *  drop it and let the caller supply their own. The cost of a false
 *  disagreement is one extra question; the cost of a false agreement is a
 *  12-minute call verified against the wrong person. */
export function surnameDisagrees(
  onFileLastName: string | undefined,
  carrierName: string | undefined,
): boolean {
  if (!onFileLastName || !carrierName) return false;
  const surname = nameTokens(onFileLastName)[0];
  const carrier = nameTokens(carrierName);
  if (!surname || carrier.length === 0) return false;
  // Business/unregistered lines carry no personal name — not a disagreement.
  if (/\b(WIRELESS|CALLER|UNKNOWN|TOLL|FREE|CELL|PHONE|LLC|INC)\b/.test(carrier.join(' '))) {
    return false;
  }
  const agrees = carrier.some(
    (t) => t === surname || (t.length >= 4 && surname.length >= 4 && (t.startsWith(surname) || surname.startsWith(t))),
  );
  return !agrees;
}

export interface RetryCheck {
  blocked: boolean;
  reason?: string;
}

/** A retry after a no-match must change something the CALLER re-supplied.
 *  Resending a field that already failed, unchanged and unconfirmed, cannot
 *  succeed — it is the loop that produced a 12-minute call on 2026-07-31. */
export function checkRetry(
  prev: { lastName?: string; dateOfBirth?: string } | undefined,
  next: { lastName?: string; dateOfBirth?: string },
): RetryCheck {
  if (!prev) return { blocked: false };
  const sameName = (prev.lastName ?? '').toLowerCase() === (next.lastName ?? '').toLowerCase();
  const sameDob = (prev.dateOfBirth ?? '') === (next.dateOfBirth ?? '');
  if (sameName && sameDob) {
    return {
      blocked: true,
      reason:
        'This is the exact same name and date of birth that just failed. Nothing about the record has ' +
        'changed, so it cannot match now. Ask the caller to confirm the ONE you have not re-checked — ' +
        'read the date of birth back to them digit by digit — or hand off with patient_identity_uncertain.',
    };
  }
  if (sameDob && !sameName) {
    return {
      blocked: false,
      reason:
        'NOTE: you corrected the name but are resending the SAME date of birth that already failed. ' +
        'If this attempt also fails, the date is the suspect field — read it back to the caller before trying again.',
    };
  }
  return { blocked: false };
}

// ── Per-call attempt ledger ──────────────────────────────────────────────
// The only state in this module: what identity was last sent for a call, so
// checkRetry has a "prev" to compare against. Released from the same cleanup
// path as the loop guard.

interface Attempt {
  lastName?: string;
  firstName?: string;
  dateOfBirth?: string;
}

const attempts = new Map<string, Attempt>();
/** Verification attempts that actually reached the service, per call. */
const attemptCounts = new Map<string, number>();

/** After this many real verification attempts, stop trying and hand off.
 *  Call afb1e688 (2026-08-03) burned four attempts and ten minutes on a
 *  name that could never match; the caller was swearing by minute three. */
export const MAX_IDENTITY_ATTEMPTS = 3;

/**
 * Did the model invent a first name the caller never said?
 *
 * Call afb1e688 (2026-08-03): caller-ID pre-context matched the phone to
 * "Wayne Fabian". The caller said "Ferreras, Pedro". The model sent
 * firstName "Wayne" (from pre-context) with lastName "Herreras" (a
 * mis-transcription of what the caller said) — a person who does not
 * exist, assembled from two different people. It could never match, so the
 * agent looped until the caller gave up.
 *
 * The rule: once the caller states a first name, THEIR word wins. Pre-context
 * is only a hint for a caller who hasn't said anything yet.
 */
export function firstNameContradicted(
  sentFirstName: string | undefined,
  callerText: string,
): { conflict: boolean; callerSaid?: string } {
  if (!sentFirstName) return { conflict: false };
  const sent = nameTokens(sentFirstName)[0];
  if (!sent) return { conflict: false };
  const said = callerText.toUpperCase();
  // The caller said it at some point → not a contradiction, whatever else
  // is in the transcript.
  if (new RegExp(`\\b${sent}\\b`).test(said)) return { conflict: false };

  // The caller never said it. Only call that a conflict when they clearly
  // offered a DIFFERENT first name, so a silent/garbled caller doesn't trip it.
  const introduced =
    callerText.match(/\b(?:my name is|this is|i'?m|it'?s|name'?s)\s+([A-Za-z]{2,})/i) ??
    // "Ferreras, Pedro" / "Ferreras Pedro" — surname-first, as spoken here.
    callerText.match(/\b([A-Za-z]{2,})\s*,\s*([A-Za-z]{2,})\b/);
  if (!introduced) return { conflict: false };
  const candidate = (introduced[2] ?? introduced[1] ?? '').toUpperCase();
  if (!candidate || candidate === sent) return { conflict: false };
  return { conflict: true, callerSaid: candidate };
}

export function releaseIdentityGuard(callId: string | undefined): void {
  if (callId) {
    attempts.delete(callId);
    attemptCounts.delete(callId);
  }
}

/** Exposed for tests. */
export function lastIdentityAttempt(callId: string): Attempt | undefined {
  return attempts.get(callId);
}

export interface IdentityGuardVerdict {
  /** true → do NOT call the service; return `instruction` to the model. */
  blocked: boolean;
  /** Corrective text for the model — spoken as a tool result, not to the caller. */
  instruction?: string;
  /** Non-blocking warning appended to the tool result. */
  note?: string;
  /** Args to actually send, with a caller-contradicted DOB left untouched —
   *  we never silently rewrite an identity field; we make the model redo it. */
  telemetry: {
    dobConflict: boolean;
    retryBlocked: boolean;
    firstNameConflict?: boolean;
    attemptsExhausted?: boolean;
  };
}

/** The single gate in front of verify_patient_identity. */
export function guardIdentityArgs(
  callId: string | undefined,
  args: { lastName?: string; firstName?: string; dateOfBirth?: string },
  transcript: string | undefined,
): IdentityGuardVerdict {
  const said = callerSpeech(transcript);
  const prev = callId ? attempts.get(callId) : undefined;
  const soFar = callId ? attemptCounts.get(callId) ?? 0 : 0;

  // Stop the call from dying by a thousand retries. Three real attempts is
  // already more than a person tolerates (afb1e688: four attempts, ten
  // minutes, caller swearing).
  if (soFar >= MAX_IDENTITY_ATTEMPTS) {
    return {
      blocked: true,
      instruction:
        `${MAX_IDENTITY_ATTEMPTS} verification attempts have already failed on this call. Do NOT try again ` +
        `and do NOT ask for the name or date of birth another time. Say: "I'm not able to find you in the ` +
        `system, and I don't want to keep you any longer — let me get you to someone who can sort this out." ` +
        `Then call sage_handoff with reason patient_identity_uncertain.`,
      telemetry: { dobConflict: false, retryBlocked: true, attemptsExhausted: true },
    };
  }

  // The caller's own first name beats caller-ID pre-context, always.
  const fn = firstNameContradicted(args.firstName, said);
  if (fn.conflict) {
    return {
      blocked: true,
      instruction:
        `You are sending firstName "${args.firstName}", but the caller said their first name is ` +
        `"${fn.callerSaid}". The number we recognized belongs to someone else — a first name from ` +
        `caller-ID combined with a last name from this caller is a person who does not exist and can ` +
        `never match. Resend with firstName "${fn.callerSaid}" and the last name THEY gave.`,
      telemetry: { dobConflict: false, retryBlocked: false, firstNameConflict: true },
    };
  }

  const dob = args.dateOfBirth ? checkDob(String(args.dateOfBirth), said) : { conflict: false } as DobCheck;
  if (dob.conflict) {
    // Do NOT record the attempt: it never reached the service, so it is not
    // a thing that "already failed" — recording it would make the corrected
    // retry look like a repeat and block it too.
    return {
      blocked: true,
      instruction:
        `${dob.reason} Do not verify yet. Read the date of birth back to the caller — ` +
        `"just to make sure I have it right, that's <month>, <day>, <year>?" — and use the one they confirm.`,
      telemetry: { dobConflict: true, retryBlocked: false },
    };
  }

  const retry = checkRetry(prev, args);
  if (retry.blocked) {
    return {
      blocked: true,
      instruction: retry.reason,
      telemetry: { dobConflict: false, retryBlocked: true },
    };
  }

  if (callId) {
    attempts.set(callId, { ...args });
    attemptCounts.set(callId, soFar + 1);
  }
  const lastChance = soFar + 1 >= MAX_IDENTITY_ATTEMPTS;
  const note = lastChance
    ? `${retry.reason ? retry.reason + ' ' : ''}This is verification attempt ${soFar + 1} of ` +
      `${MAX_IDENTITY_ATTEMPTS}. If it fails, do NOT ask again — hand off with patient_identity_uncertain.`
    : retry.reason;
  return {
    blocked: false,
    ...(note ? { note } : {}),
    telemetry: { dobConflict: false, retryBlocked: false },
  };
}
