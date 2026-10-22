/**
 * Stage C, step 3 — the measurement engine's metric DEFINITIONS.
 *
 * Every number the engine publishes is computed from the SQL in this file and
 * nothing else. The engine, not Claude, is authoritative for these numbers
 * (operator, 2026-10-22), so the definitions are code, and a change to any of
 * them is a new METHOD_VERSION: `definitions.test.ts` hashes the text below and
 * fails until both METHOD_VERSION and DEFINITIONS_HASH are bumped together.
 * The learning register's VERIFY gate refuses a value whose method_version does
 * not match the one a target was set against, so a silent change to a
 * definition cannot pass for a moved number.
 *
 * WHAT IS DELIBERATELY NOT HERE: any fleet-and-5Star combined rate. The two
 * systems measure different things (a ticket filed, an appointment booked) and
 * are published side by side, never summed.
 *
 * PHI: every statement returns counts, lane slugs, build markers and call SIDs
 * (the SIDs only to join across databases, never exported). No name, phone,
 * date of birth or transcript text leaves a statement — the transcript is
 * READ for one fact (did the caller speak) and only that boolean returns.
 */

/** Bump with DEFINITIONS_HASH whenever any text below changes. */
export const METHOD_VERSION = "learning-v1";
/** sha256 of definitionsText(), first 16 hex. definitions.test.ts pins it. */
export const DEFINITIONS_HASH = "39ae0af751d85493";

export const PACIFIC = "America/Los_Angeles";

/** The 5Star inbound line the Daybook measures. */
export const FIVESTAR_INBOUND_NUMBER = "+16266998484";
/** Lane names, from ai-bridge learning/vocab.json lane_groups. */
export const FIVESTAR_INBOUND_LANE = "drs-8484";

export type MetricId =
  | "remix.filed_rate"
  | "remix.filed_rate_independent"
  | "5star.submitted_rate_a"
  | "5star.booked_rate_a"
  | "5star.booked_rate_b";

export interface MetricDefinition {
  id: MetricId;
  repo: "Remix" | "5Star";
  /** True only when the numerator is read from a system the agent does not write. */
  independent: boolean;
  definition: string;
}

export const METRICS: readonly MetricDefinition[] = [
  {
    id: "remix.filed_rate",
    repo: "Remix",
    independent: false,
    definition:
      "Substantive calls (canonical CallSid, not outbound, duration >= 30, the call's own Pacific day from call_logs.created_at) " +
      "whose own call_logs row carries a non-blank ticket_number, over all substantive calls. Per lane (call_logs.agent_used) and build " +
      "(call_logs.runtime_marker; '' when absent). The write-back is the agent's own record, so this is NOT independent; " +
      "remix.filed_rate_independent is the Support Center reading of the same calls.",
  },
  {
    id: "remix.filed_rate_independent",
    repo: "Remix",
    independent: true,
    definition:
      "The same denominator as remix.filed_rate; the numerator is the calls the Support Center shows an AGENT filing for, folded per call " +
      "agent > UNKNOWN > staff (CLAUDE.md, the filing test). UNKNOWN calls are reported in unknown_count and never counted as filed or unfiled. " +
      "Unavailable until the read-only Support Center role exists (A1); the run notes say so.",
  },
  {
    id: "5star.submitted_rate_a",
    repo: "5Star",
    independent: false,
    definition:
      "5Star inbound calls on the DRS line (not simulated, the Pacific day of call_logs.created_at, notes 'DRS voice call%') that are substantive " +
      "(duration >= 30 and a CALLER: line) and whose notes carry core status REQUEST_SUBMITTED, over substantive. Per build (call_logs.build_id).",
  },
  {
    id: "5star.booked_rate_a",
    repo: "5Star",
    independent: true,
    definition:
      "Substantive calls with a booking that the Patient Console's NextGen mirror shows at the run's read time, over substantive. A booking is the " +
      "call's internal_bookings row (voice_agent_booking_attempts outcome booked/booked_drift, or notes 'Call ID: <call_logs.id>'). Booked: a " +
      "non-NPX row not cancelled locally whose mirror appointment (by NextGen id, else person + slot date + begin time) is not cancelled, or was " +
      "moved and the person still holds an uncancelled appointment on or after the call's day (operator 2026-10-11); an NPX row needs a firm " +
      "partner link (isFirmPartnerLink), a partner status in in_partner_schedule/awaiting_outcome/partner_reported_showed/partner_report_received, " +
      "and not cancelled locally. The mirror lags staff entry, so a day is re-read on later nights until it settles.",
  },
  {
    id: "5star.booked_rate_b",
    repo: "5Star",
    independent: true,
    definition:
      "The booked count of 5star.booked_rate_a over ASKED calls: substantive calls that passed consent (report_consent success), asked to cancel " +
      "(report_cancel_request), reached ASK_PREFERENCE/CONFIRM_LOCATION/OFFER_SLOTS/CONFIRM_SLOT/CONFIRM_REQUEST_SUBMITTED (sage_tool_calls step " +
      "fields only), or whose notes carry one of the terminal core statuses or those steps (the Daybook proxy).",
  },
] as const;

// ---------------------------------------------------------------------------
// SQL. Parameters are typed in the text (the v52 lesson: two bare parameters
// cannot be typed by the server).

/** Hub: substantive fleet calls of one Pacific day. $1 = day (date). */
export const REMIX_CALLS_SQL = `
SELECT call_sid,
       coalesce(nullif(btrim(agent_used), ''), 'unknown') AS lane,
       coalesce(nullif(btrim(%MARKER%), ''), '')           AS runtime_marker,
       (nullif(btrim(ticket_number), '') IS NOT NULL)      AS filed
FROM call_logs
WHERE call_sid ~* '^CA[0-9a-f]{32}$'
  AND coalesce(direction, 'inbound') <> 'outbound'
  AND duration >= 30
  AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE '${PACIFIC}')::date = $1::date`;

/** Support Center: provenance per call for a list of SIDs. $1 = text[]. */
export const SUPPORT_PROVENANCE_SQL = `
SELECT call_sid,
       bool_or(created_by_id IS NULL AND agent_used IS NOT NULL) AS any_agent,
       bool_or(created_by_id IS NULL AND agent_used IS NULL)     AS any_unknown
FROM tickets
WHERE call_sid ~* '^CA[0-9a-f]{32}$' AND call_sid = ANY($1::text[])
GROUP BY call_sid`;

const ASKED_STEPS = "ASK_PREFERENCE|CONFIRM_LOCATION|OFFER_SLOTS|CONFIRM_SLOT|CONFIRM_REQUEST_SUBMITTED";
const TERMINAL_CORE =
  "REQUEST_SUBMITTED|NO_ACCEPTABLE_LOCATION|NO_AVAILABLE_SLOTS|LOCATION_RANKING_UNAVAILABLE|AMBIGUOUS_SELECTION|CANCEL_REQUESTED";

/**
 * 5Star: the DRS inbound calls of one Pacific day, with the funnel flags.
 * created_at is a timestamp WITHOUT time zone holding UTC — the naive cast
 * read 108 calls on 2026-10-20 where the Daybook (and this) read 81/82.
 * $1 = day (date). %BUILD% is build_id or a NULL literal when the column is absent.
 */
export const FIVESTAR_CALLS_SQL = `
WITH c AS (
  SELECT id, provider_call_id AS sid, notes,
         coalesce(nullif(btrim(%BUILD%), ''), '') AS build,
         (coalesce(duration, 0) >= 30 AND coalesce(transcript, '') ~ 'CALLER:') AS substantive
  FROM call_logs
  WHERE direction = 'inbound'
    AND coalesce(simulated, false) = false
    AND to_phone = '${FIVESTAR_INBOUND_NUMBER}'
    AND notes LIKE 'DRS voice call%'
    AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE '${PACIFIC}')::date = $1::date
),
t AS (
  SELECT call_sid, tool_name, outcome,
         substring(response_excerpt from '"from":"([A-Z_]+)"') AS fr,
         substring(response_excerpt from '"to":"([A-Z_]+)"')   AS tt
  FROM sage_tool_calls
  WHERE call_sid IN (SELECT sid FROM c WHERE sid IS NOT NULL)
)
SELECT c.id, c.build, c.substantive,
       (c.notes ~ 'core: REQUEST_SUBMITTED') AS submitted,
       (EXISTS (SELECT 1 FROM t WHERE t.call_sid = c.sid AND (
             (t.tool_name = 'report_consent' AND t.outcome = 'success')
          OR t.tool_name = 'report_cancel_request'
          OR t.fr ~ '^(${ASKED_STEPS})$' OR t.tt ~ '^(${ASKED_STEPS})$'))
        OR c.notes ~ 'core: (${TERMINAL_CORE})'
        OR c.notes ~ 'step: (${ASKED_STEPS})') AS asked
FROM c`;

/** 5Star: the bookings tied to a list of call_logs ids. $1 = text[]. */
export const FIVESTAR_BOOKINGS_SQL = `
WITH linked AS (
  SELECT DISTINCT a.call_log_id, a.internal_booking_id AS booking_id
  FROM voice_agent_booking_attempts a
  WHERE a.call_log_id = ANY($1::text[]) AND a.outcome IN ('booked', 'booked_drift')
    AND a.internal_booking_id IS NOT NULL
  UNION
  SELECT DISTINCT substring(b.notes from 'Call ID: ([A-Za-z0-9-]+)'), b.id
  FROM internal_bookings b
  WHERE substring(b.notes from 'Call ID: ([A-Za-z0-9-]+)') = ANY($1::text[])
)
SELECT l.call_log_id, b.id AS booking_id, b.status::text AS status,
       coalesce(b.appointment_source, '') AS source,
       b.nextgen_appointment_id,
       upper(p.person_id) AS person_id,
       to_char(b.slot_date, 'YYYY-MM-DD') AS slot_date,
       replace(left(coalesce(b.slot_begintime, ''), 5), ':', '') AS slot_time,
       b.npx_link_method, b.partner_link_needs_review, b.partner_outcome_status
FROM linked l
JOIN internal_bookings b ON b.id = l.booking_id
LEFT JOIN patients p ON p.id = b.patient_id`;

/**
 * Console: the mirror's view of a list of bookings. $1 = jsonb array of
 * {k, appointment_id, person_id, slot_date, slot_time, since}. Returns one row
 * per k that is booked at the read time.
 */
export const CONSOLE_BOOKED_SQL = `
WITH b AS (
  SELECT x->>'k' AS k,
         nullif(x->>'appointment_id', '') AS appointment_id,
         nullif(x->>'person_id', '')      AS person_id,
         (x->>'slot_date')::date          AS slot_date,
         x->>'slot_time'                  AS slot_time,
         (x->>'since')::date              AS since
  FROM jsonb_array_elements($1::jsonb) x
),
hit AS (
  SELECT b.k, b.person_id, b.since, f.is_cancelled, f.is_rescheduled
  FROM b
  JOIN LATERAL (
    SELECT f.is_cancelled, f.is_rescheduled
    FROM si_appointment_facts f
    WHERE (b.appointment_id ~* '^[0-9a-f-]{36}$' AND f.appointment_id = b.appointment_id::uuid)
       OR (b.person_id ~* '^[0-9a-f-]{36}$' AND f.person_id = b.person_id::uuid
           AND f.appointment_date = b.slot_date AND f.begin_time = b.slot_time)
    ORDER BY f.is_cancelled ASC
    LIMIT 1
  ) f ON true
)
SELECT h.k
FROM hit h
WHERE NOT coalesce(h.is_cancelled, false)
   OR (coalesce(h.is_rescheduled, false) AND h.person_id ~* '^[0-9a-f-]{36}$' AND EXISTS (
        SELECT 1 FROM si_appointment_facts g
        WHERE g.person_id = h.person_id::uuid
          AND NOT coalesce(g.is_cancelled, false)
          AND g.appointment_date >= h.since))`;

/** isFirmPartnerLink (5Star shared/partner-booking.ts), mirrored. */
export const FIRM_PARTNER_LINK_METHODS = ["external_ref", "npx_booking_id", "coordinator", "api_create", "auto_match"] as const;
export const NPX_BOOKED_STATUSES = [
  "in_partner_schedule",
  "awaiting_outcome",
  "partner_reported_showed",
  "partner_report_received",
] as const;

/** The text the definitions hash covers: every definition and every statement. */
export function definitionsText(): string {
  return [
    METHOD_VERSION,
    ...METRICS.map((m) => `${m.id}|${m.repo}|${m.independent}|${m.definition}`),
    REMIX_CALLS_SQL,
    SUPPORT_PROVENANCE_SQL,
    FIVESTAR_CALLS_SQL,
    FIVESTAR_BOOKINGS_SQL,
    CONSOLE_BOOKED_SQL,
    FIRM_PARTNER_LINK_METHODS.join(","),
    NPX_BOOKED_STATUSES.join(","),
  ].join("\n--\n");
}
