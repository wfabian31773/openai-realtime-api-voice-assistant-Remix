/**
 * Filing quality for the Daybook — v191.
 *
 *   npx tsx scripts/filing-quality.ts <expectations.json> <tickets.json> [--from ISO --to ISO]
 *
 * Reads two exports and prints ONE JSON summary: every count, every rate with
 * its denominator, a per-lane table, and per-defect lists of CALL SIDs. It
 * never prints a name, a date of birth, a phone number, an email or a word of
 * a transcript. The input files DO hold those; keep them in the session
 * scratchpad, never in git, and delete them once the summary is read.
 *
 * Writes nothing, anywhere. The comparison itself is `src/services/filingQuality.ts`.
 *
 * ---------------------------------------------------------------------------
 * EXPORT 1 — the Operations Hub (pslzngjciiifowemrzza): what each call SHOULD
 * have filed, read from its transcript by the v191 worker.
 * ---------------------------------------------------------------------------
 *   SELECT f.call_sid, f.agent_used, f.call_started_at, c.runtime_outcome,
 *          c.ticket_number, f.expectation, f.skipped_reason
 *   FROM filing_expectations f
 *   LEFT JOIN call_logs c ON c.call_sid = f.call_sid
 *   WHERE f.call_started_at >= '<from>'::timestamptz
 *     AND f.call_started_at <  '<to>'::timestamptz;
 *
 * ---------------------------------------------------------------------------
 * EXPORT 2 — the Support Center (vsmcxhxeirkoobmjcrbn): what was filed. Agent
 * provenance only (no named human creator), canonical SIDs only. Archived and
 * merged tickets are INCLUDED: they were filings (a PCP withdrawal archives
 * one; a staffer's merge folds one into another). `filed_department_id` is
 * where the agent filed it: the ticket's own creation event (only
 * /submit-ticket writes one with a department), else the FIRST department
 * transfer's `fromDepartmentId`, else where it is now. A merge copies the
 * source's events onto the kept ticket with `mergedFromTicketId`, which is why
 * those are excluded. Measured 2026-11-05..06: 168 of 945 agent tickets were
 * moved after filing, every move by a named staff member.
 * ---------------------------------------------------------------------------
 *   SELECT t.call_sid, t.ticket_number,
 *          coalesce(
 *            (SELECT (e.payload->>'departmentId')::int FROM ticket_events e
 *              WHERE e.ticket_id = t.id AND e.event_type = 'ticket.created'
 *                AND e.payload->>'mergedFromTicketId' IS NULL
 *              ORDER BY e.id LIMIT 1),
 *            (SELECT (e.payload->>'fromDepartmentId')::int FROM ticket_events e
 *              WHERE e.ticket_id = t.id AND e.event_type = 'department_transferred'
 *                AND e.payload->>'mergedFromTicketId' IS NULL
 *              ORDER BY e.occurred_at, e.id LIMIT 1),
 *            t.department_id) AS filed_department_id,
 *          t.department_id, t.priority::text AS priority, t.location_id, t.provider_id,
 *          t.patient_first_name, t.patient_last_name,
 *          t.patient_birth_month, t.patient_birth_day, t.patient_birth_year,
 *          t.patient_phone, t.patient_email,
 *          t.records_requestor_type, t.records_request_pathway, t.records_requestor_name,
 *          t.pcp_caller_name, t.pcp_caller_organization, t.pcp_caller_callback_number, t.pcp_caller_email,
 *          (t.merged_into_id IS NOT NULL) AS merged,
 *          coalesce(t.archive_reason LIKE 'Operator ruling 2026-10-19:%', false) AS withdrawn,
 *          t.created_at
 *   FROM tickets t
 *   WHERE t.call_sid ~* '^CA[0-9a-f]{32}$'
 *     AND t.created_by_id IS NULL AND t.agent_used IS NOT NULL
 *     AND coalesce(t.call_start_time, t.created_at) >= '<from>'::timestamp - interval '1 day'
 *     AND coalesce(t.call_start_time, t.created_at) <  '<to>'::timestamp + interval '1 day';
 *
 * The ticket window is a day wider on each side on purpose: a call near
 * midnight can file after it (the outbox retries), and tickets for calls
 * outside the expectation window are simply not matched.
 */
import { readFileSync } from "node:fs";
import { compareFiling, summarise, type ExpectationRow, type TicketRow } from "../src/services/filingQuality";
import { FILING_EXPECTATION_PROMPT_VERSION } from "../src/services/filingExpectation";

function load<T>(path: string): T[] {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of rows`);
  return parsed as T[];
}

/** The expectation column may arrive as an object or as JSON text, depending on the export tool. */
function asObject(v: unknown): ExpectationRow["expectation"] {
  if (v && typeof v === "object") return v as ExpectationRow["expectation"];
  if (typeof v === "string" && v.trim()) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

export function run(expectationsPath: string, ticketsPath: string, window?: { from?: string; to?: string }) {
  const expectations = load<ExpectationRow>(expectationsPath).map((r) => ({ ...r, expectation: asObject(r.expectation) }));
  // A ticket the PCP hang-up rule withdrew (v100) is no filing.
  const tickets = load<TicketRow>(ticketsPath).filter((t) => !t.withdrawn);
  const byCall = new Map<string, TicketRow[]>();
  const byNumber = new Map<string, TicketRow>();
  for (const t of tickets) {
    const key = (t.call_sid ?? "").trim();
    if (key) (byCall.get(key) ?? byCall.set(key, []).get(key)!).push(t);
    if (t.ticket_number) byNumber.set(t.ticket_number.trim(), t);
  }
  // A ticket's call_sid can be a later call's (the app folds a callback onto
  // the open ticket and re-stamps it), so a call also owns the ticket its own
  // write-back names.
  const ticketsFor = (row: ExpectationRow): TicketRow[] => {
    const own = [...(byCall.get(row.call_sid) ?? [])];
    const written = row.ticket_number ? byNumber.get(row.ticket_number.trim()) : undefined;
    if (written && !own.includes(written)) own.push(written);
    return own;
  };
  // A call nobody spoke on is not a filing question at all (ruling-correct).
  const heard = expectations.filter((row) => row.skipped_reason !== "no_caller_line");
  const comparisons = heard.map((row) => compareFiling(row, ticketsFor(row)));
  return {
    window: window ?? null,
    promptVersion: FILING_EXPECTATION_PROMPT_VERSION,
    ...summarise(comparisons),
  };
}

const isMain = process.argv[1] && /filing-quality\.ts$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const [expectationsPath, ticketsPath] = args.filter((a) => !a.startsWith("--"));
  if (!expectationsPath || !ticketsPath) {
    console.error("usage: npx tsx scripts/filing-quality.ts <expectations.json> <tickets.json> [--from ISO --to ISO]");
    process.exit(2);
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = run(expectationsPath, ticketsPath, { from: flag("--from"), to: flag("--to") });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
