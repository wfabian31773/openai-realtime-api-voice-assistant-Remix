/**
 * The one normalizer for a phone identity in this codebase.
 *
 * Moved here 2026-08-21 from `services/scheduleLookupService.ts`, which had
 * it first, so the queue tools could reuse it instead of writing a second
 * one. Pure and side-effect-free deliberately — `scheduleLookupService.ts`
 * imports `server/db` at module load, and the four queue tools' tests
 * already have to guard against exactly that (`vi.mock('../../server/db', ...)`
 * because a prior fix opened a DB client just by being imported). This file
 * imports nothing, so nothing that needs `normalizePhone` has to carry that
 * weight.
 *
 * Last ten digits, not all of them: a US number with its leading 1 is 11
 * digits, and slicing from the end drops exactly that digit rather than the
 * area code.
 *
 * Callers must gate length BEFORE calling this. It silently produces a
 * plausible-looking 10 digits from garbage input just as readily as from a
 * real number — a real number with a 3-digit extension welded on is still
 * "at least 10 digits" and slices to something that looks like a phone
 * number and isn't. See the ceiling check in the four queue tools
 * (`sharedPatientTools.ts` imports this and re-exports it for them): this
 * function assumes the implausible case, too few or too many digits, was
 * already refused.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}
