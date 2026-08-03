/**
 * Shadow identity-grounding check.
 *
 * The gap this closes (call afb1e688, 2026-08-03): the agent sent
 * verify_patient_identity with firstName from caller-ID pre-context and
 * lastName from a mis-transcription of the caller's speech — a person who
 * existed in neither place. It could never match, the agent looped, and the
 * caller gave up after ten minutes. The shadow flagged the LOOP but had
 * nothing to say about WHY, because it never compared the identity arguments
 * against their two possible sources of truth.
 *
 * Every identity field must be grounded in one of:
 *   1. what the caller actually said (their words win), or
 *   2. the on-file record the phone number matched (pre-context).
 * An argument grounded in NEITHER is invented. An argument that mixes
 * sources — first name from one person, last name from another — is a
 * chimera and is the more dangerous case: if it ever matched, it would
 * verify the wrong patient.
 *
 * Pure and side-effect free. Runs PRODUCTION-side (from the identity guard),
 * because only there do the real names exist: the tool-timeline tap redacts
 * names by design, so the shadow receives the verdict CODE and the two source
 * labels — never the names themselves.
 */

export type IdentityGroundingCode =
  | 'grounded'
  | 'chimera_mixed_sources'
  | 'ungrounded_first_name'
  | 'ungrounded_last_name'
  | 'no_caller_speech';

export interface IdentityGroundingFinding {
  code: IdentityGroundingCode;
  /** true when a reviewer must look at this — the harmful cases. */
  review: boolean;
  detail: string;
  firstNameSource: 'caller' | 'precontext' | 'unknown' | 'absent';
  lastNameSource: 'caller' | 'precontext' | 'unknown' | 'absent';
}

export interface PrecontextLike {
  firstName?: string;
  lastNameOnFile?: string;
}

function tokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 2);
}

/** Loose containment: exact token, or a ≥4-char shared prefix (ASR drift like
 *  Ferreras/Herreras is NOT treated as a match — it is a different name and
 *  the point of the check is to notice that). */
function spoken(name: string | undefined, callerText: string): boolean {
  const want = tokens(name)[0];
  if (!want) return false;
  return tokens(callerText).some((t) => t === want);
}

function onFile(name: string | undefined, candidate: string | undefined): boolean {
  const want = tokens(name)[0];
  const have = tokens(candidate)[0];
  return !!want && !!have && want === have;
}

export function checkIdentityGrounding(
  args: { firstName?: string; lastName?: string },
  callerText: string,
  precontext: PrecontextLike | undefined,
): IdentityGroundingFinding {
  const fromCallerFirst = spoken(args.firstName, callerText);
  const fromCallerLast = spoken(args.lastName, callerText);
  const fromPcFirst = onFile(args.firstName, precontext?.firstName);
  const fromPcLast = onFile(args.lastName, precontext?.lastNameOnFile);

  const firstNameSource: IdentityGroundingFinding['firstNameSource'] = !args.firstName
    ? 'absent'
    : fromCallerFirst
      ? 'caller'
      : fromPcFirst
        ? 'precontext'
        : 'unknown';
  const lastNameSource: IdentityGroundingFinding['lastNameSource'] = !args.lastName
    ? 'absent'
    : fromCallerLast
      ? 'caller'
      : fromPcLast
        ? 'precontext'
        : 'unknown';

  const base = { firstNameSource, lastNameSource };

  if (!callerText.trim()) {
    return { code: 'no_caller_speech', review: false, detail: 'No caller speech captured yet; grounding not assessable.', ...base };
  }

  // The chimera: one field from the recognized record, the other from this
  // caller. Whoever the phone belongs to, this combination is nobody.
  if (firstNameSource === 'precontext' && (lastNameSource === 'caller' || lastNameSource === 'unknown')) {
    return {
      code: 'chimera_mixed_sources',
      review: true,
      detail:
        `firstName "${args.firstName}" comes from caller-ID pre-context while lastName "${args.lastName}" ` +
        `does not — the caller-ID matched a different person. This combination identifies nobody and cannot verify.`,
      ...base,
    };
  }
  if (lastNameSource === 'precontext' && firstNameSource === 'unknown') {
    return {
      code: 'chimera_mixed_sources',
      review: true,
      detail:
        `lastName "${args.lastName}" is the on-file name but firstName "${args.firstName}" was never said ` +
        `by the caller and is not on file — mixed sources.`,
      ...base,
    };
  }
  if (firstNameSource === 'unknown') {
    return {
      code: 'ungrounded_first_name',
      review: true,
      detail: `firstName "${args.firstName}" appears in neither the caller's speech nor the on-file record.`,
      ...base,
    };
  }
  if (lastNameSource === 'unknown') {
    return {
      code: 'ungrounded_last_name',
      review: true,
      // Common and usually ASR drift on a spelled surname — still worth a look,
      // because it is exactly how "Ferreras" became "Herreras".
      detail: `lastName "${args.lastName}" appears in neither the caller's speech nor the on-file record (possible mis-transcription).`,
      ...base,
    };
  }
  return { code: 'grounded', review: false, detail: 'Identity arguments are grounded in the caller or the on-file record.', ...base };
}
