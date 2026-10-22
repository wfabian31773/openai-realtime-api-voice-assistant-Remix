/**
 * Pure helpers for the Daily Brief day picker. No database, no clock — so the
 * rules that decide WHICH stored day is shown, and which row is its
 * "yesterday", can be tested on their own.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar day written as YYYY-MM-DD (2026-02-30 is false). */
export function isValidBriefDate(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export type BriefDateParam =
  | { kind: 'latest' }
  | { kind: 'date'; date: string }
  | { kind: 'invalid'; message: string };

/**
 * Reads `?date=` off a request query. Absent or empty means the latest brief;
 * anything else must be exactly one valid YYYY-MM-DD.
 */
export function parseBriefDateParam(raw: unknown): BriefDateParam {
  if (raw === undefined || raw === '') return { kind: 'latest' };
  if (typeof raw !== 'string') return { kind: 'invalid', message: 'date must be a single YYYY-MM-DD value' };
  if (!isValidBriefDate(raw)) return { kind: 'invalid', message: `invalid date "${raw.slice(0, 32)}" — expected a real YYYY-MM-DD day` };
  return { kind: 'date', date: raw };
}

/**
 * The stored row immediately BEFORE the selected day — not before "today".
 * `rows` must be sorted ascending by `d` (YYYY-MM-DD compares lexically).
 */
export function pickYesterday<T extends { d: string }>(rows: T[], selectedDate: string): T | null {
  let found: T | null = null;
  for (const r of rows) {
    if (r.d < selectedDate) found = r;
    else break;
  }
  return found;
}

/** Thrown when a specific past day was asked for and no brief is stored for it. */
export class BriefNotFoundError extends Error {
  constructor(public readonly date: string) {
    super(`No stored daily brief for ${date}`);
    this.name = 'BriefNotFoundError';
  }
}
