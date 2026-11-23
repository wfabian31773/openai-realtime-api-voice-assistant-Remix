/**
 * The post-op exception: a patient who had surgery in the last 7 days goes to
 * their surgeon, not the on-call provider.
 *
 * Operator, 2026-11-23: "if the patient had surgery in the past 7 days, route
 * to their surgeon instead. Get the surgery date and surgeon from the patient
 * console (icare-console) — no other source. If you can't determine it with
 * confidence, route to on-call and say so in the alert text."
 *
 * THE ONE SOURCE is the Console's schedule mirror, `si_appointment_facts`,
 * joined to `si_providers` for the rendering provider's NPI and name, read by
 * the patient's `person_id` from the call's CERTAIN identity (RULE ZERO step 3).
 * Nothing the caller said, nothing the model wrote, and no phone candidate
 * decides it. A call with no certain identity is not checked, and the alert
 * says so.
 *
 * WHAT "CONFIDENCE" MEANS HERE, rule by rule (each a test):
 *   - the surgery is one of SURGERY_EVENTS, dated today or up to 7 days ago in
 *     Pacific time (7 days ago routes to the surgeon, 8 to on-call);
 *   - it is not cancelled, and not moved unless it was kept (a kept row wins
 *     over its reschedule flag, NextGen Bible §2.1);
 *   - the most recent such date names exactly one surgeon;
 *   - that surgeon is in the on-call table, matched by NPI, else by first and
 *     last name, and is active.
 * Anything else goes to the on-call provider with a note in the alert text.
 *
 * NOT YET KEPT. NextGen marks a surgery kept days after it happens: measured
 * 2026-11-23, surgeries dated today 0 of 76 kept, 3 to 6 days ago 71 of 142,
 * 7 days ago 67 of 72. Requiring "kept" would send almost every patient in
 * their first post-op days, the ones most likely to call, to the general
 * on-call provider. So a booked surgery that is not cancelled or moved routes
 * to the surgeon, and the alert says it is not yet marked kept. Set
 * ON_CALL_POST_OP_REQUIRE_KEPT=1 to route those to on-call instead.
 */

import type { OnCallProvider } from "./rotation";
import { addDays } from "./rotation";

/**
 * NextGen event names that are an operation by one of our surgeons. Procedures
 * (YAG, SLT, injections) are not surgery, and "CoManaged Surgery" is an
 * operation done elsewhere, so none of those count.
 */
export const SURGERY_EVENTS: readonly string[] = [
  "Surgery",
  "Lasik Surgery",
  "Lasik Enhancement",
  "Bleph Procedure",
];

/** 0 to 7 days ago inclusive routes to the surgeon. */
export const POST_OP_WINDOW_DAYS = 7;

/** One surgery row from the Console, PHI-free (no patient fields). */
export interface SurgeryFact {
  /** YYYY-MM-DD, the appointment's own date (Pacific practice day). */
  date: string;
  eventName: string;
  kept: boolean | null;
  cancelled: boolean;
  rescheduled: boolean;
  providerNpi: string | null;
  providerName: string | null;
}

export type PostOpReason =
  | "no_identity"
  | "console_unavailable"
  | "no_recent_surgery"
  | "surgeon_unclear"
  | "surgeon_not_in_pool"
  | "surgeon_inactive"
  | "surgery_not_kept";

export type PostOpDecision =
  | {
      route: "surgeon";
      provider: OnCallProvider;
      surgeryDate: string;
      daysAgo: number;
      kept: boolean;
      /** Set when the surgery is not yet marked kept. */
      note?: string;
    }
  | {
      route: "on_call";
      reason: PostOpReason;
      /** Absent only for no_recent_surgery: nothing uncertain to say. */
      note?: string;
      surgeryDate?: string;
    };

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** The earliest date the query needs, for `today` (Pacific). */
export function windowStart(today: string): string {
  return addDays(today, -POST_OP_WINDOW_DAYS);
}

const TITLE = /^(dr|doctor)\.?\s+/i;

/**
 * "Dr. David M. Choi, MD" and "David Choi, M.D." are the same first and last
 * name. Drops a title, anything after the first comma (the degree), single
 * letters (initials) and punctuation; keeps the first and last word.
 */
export function nameKeyForMatch(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(",")[0].replace(TITLE, "");
  const words = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(md|do|od|mmd)$/.test(w));
  if (words.length < 2) return null;
  return `${words[0]} ${words[words.length - 1]}`;
}

function npiKey(npi: string | null | undefined): string | null {
  const digits = (npi ?? "").replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

/** The pool provider a Console surgeon is, by NPI first, else by name. */
export function matchSurgeon(
  fact: Pick<SurgeryFact, "providerNpi" | "providerName">,
  providers: readonly OnCallProvider[],
): OnCallProvider | null {
  const npi = npiKey(fact.providerNpi);
  if (npi) {
    const byNpi = providers.find((p) => npiKey(p.npi) === npi);
    if (byNpi) return byNpi;
  }
  const key = nameKeyForMatch(fact.providerName);
  if (!key) return null;
  const byName = providers.filter((p) => nameKeyForMatch(p.fullName) === key);
  // Two pool rows with one name: not confident.
  return byName.length === 1 ? byName[0] : null;
}

function surgeonId(f: SurgeryFact): string | null {
  return npiKey(f.providerNpi) ?? nameKeyForMatch(f.providerName);
}

function counts(f: SurgeryFact): boolean {
  if (!SURGERY_EVENTS.includes(f.eventName)) return false;
  if (f.cancelled) return false;
  if (f.rescheduled && f.kept !== true) return false;
  return true;
}

function label(name: string | null): string {
  return name?.trim() || "an unnamed surgeon";
}

export interface PostOpOptions {
  /** Route a booked surgery not yet marked kept to on-call (default false). */
  requireKept?: boolean;
}

/**
 * The decision, from the Console rows for one patient and today's Pacific date.
 * Pure: no clock, no database.
 */
export function decidePostOp(
  facts: readonly SurgeryFact[],
  today: string,
  providers: readonly OnCallProvider[],
  options: PostOpOptions = {},
): PostOpDecision {
  const inWindow = facts.filter((f) => {
    if (!counts(f)) return false;
    const ago = daysBetween(f.date, today);
    return ago >= 0 && ago <= POST_OP_WINDOW_DAYS;
  });
  if (inWindow.length === 0) return { route: "on_call", reason: "no_recent_surgery" };

  const latest = inWindow.reduce((d, f) => (f.date > d ? f.date : d), inWindow[0].date);
  const onLatest = inWindow.filter((f) => f.date === latest);
  const ids = new Set(onLatest.map(surgeonId));
  if (ids.size !== 1 || ids.has(null)) {
    const names = [...new Set(onLatest.map((f) => label(f.providerName)))].join(" and ");
    return {
      route: "on_call",
      reason: "surgeon_unclear",
      surgeryDate: latest,
      note: `Post-op check: the surgery on ${latest} does not name one surgeon (${names}), so this went to the on-call provider.`,
    };
  }

  const fact = onLatest[0];
  const surgeon = matchSurgeon(fact, providers);
  if (!surgeon) {
    return {
      route: "on_call",
      reason: "surgeon_not_in_pool",
      surgeryDate: latest,
      note: `Post-op check: surgery on ${latest} with ${label(fact.providerName)}, who is not in the on-call list, so this went to the on-call provider.`,
    };
  }
  if (!surgeon.active) {
    return {
      route: "on_call",
      reason: "surgeon_inactive",
      surgeryDate: latest,
      note: `Post-op check: surgery on ${latest} with ${surgeon.fullName}, who is marked inactive in the on-call list, so this went to the on-call provider.`,
    };
  }
  const kept = onLatest.some((f) => f.kept === true);
  if (!kept && options.requireKept) {
    return {
      route: "on_call",
      reason: "surgery_not_kept",
      surgeryDate: latest,
      note: `Post-op check: surgery on ${latest} with ${surgeon.fullName} is booked but not marked kept in NextGen, so this went to the on-call provider.`,
    };
  }
  return {
    route: "surgeon",
    provider: surgeon,
    surgeryDate: latest,
    daysAgo: daysBetween(latest, today),
    kept,
    ...(kept
      ? {}
      : { note: `Post-op: surgery on ${latest} is booked but not yet marked kept in NextGen.` }),
  };
}

/** The note for a call whose patient was never confirmed. */
export const NO_IDENTITY_NOTE =
  "Post-op check: the patient was not confirmed on the call, so a recent surgery could not be checked.";

/** The note when the Console could not be read in time. */
export const CONSOLE_UNAVAILABLE_NOTE =
  "Post-op check: the patient console did not answer, so a recent surgery could not be checked.";

type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** The Console read, one patient, the window ending today. 0.7 ms on the Console (2026-11-23). */
export const POST_OP_SQL = `
  select to_char(f.appointment_date, 'YYYY-MM-DD') as date,
         f.event_name, f.is_kept, f.is_cancelled, f.is_rescheduled,
         p.npi, p.nextgen_name
    from public.si_appointment_facts f
    left join public.si_providers p on p.provider_id = f.rendering_provider_id
   where f.person_id = $1::uuid
     and f.appointment_date between $2::date and $3::date
     and f.event_name = any($4::text[])
   order by f.appointment_date desc
   limit 20`;

export async function readSurgeryFacts(
  query: Query,
  personId: string,
  today: string,
): Promise<SurgeryFact[]> {
  const { rows } = await query(POST_OP_SQL, [personId, windowStart(today), today, SURGERY_EVENTS]);
  return rows.map((r) => ({
    date: String(r.date),
    eventName: String(r.event_name ?? ""),
    kept: r.is_kept === null || r.is_kept === undefined ? null : Boolean(r.is_kept),
    cancelled: Boolean(r.is_cancelled),
    rescheduled: Boolean(r.is_rescheduled),
    providerNpi: r.npi ?? null,
    providerName: r.nextgen_name ?? null,
  }));
}

/**
 * The whole check for one call: identity, Console read (bounded), decision.
 * Never throws; an unknown answer routes to on-call with its note.
 */
export async function postOpRouteFor(input: {
  personId: string | undefined;
  today: string;
  providers: readonly OnCallProvider[];
  query: Query | null;
  budgetMs: number;
  requireKept?: boolean;
}): Promise<PostOpDecision> {
  if (!input.personId) return { route: "on_call", reason: "no_identity", note: NO_IDENTITY_NOTE };
  if (!input.query) return { route: "on_call", reason: "console_unavailable", note: CONSOLE_UNAVAILABLE_NOTE };
  let timer: NodeJS.Timeout | undefined;
  try {
    const facts = await Promise.race([
      readSurgeryFacts(input.query, input.personId, input.today),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), input.budgetMs);
      }),
    ]);
    if (facts === null) return { route: "on_call", reason: "console_unavailable", note: CONSOLE_UNAVAILABLE_NOTE };
    return decidePostOp(facts, input.today, input.providers, { requireKept: input.requireKept });
  } catch {
    return { route: "on_call", reason: "console_unavailable", note: CONSOLE_UNAVAILABLE_NOTE };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
