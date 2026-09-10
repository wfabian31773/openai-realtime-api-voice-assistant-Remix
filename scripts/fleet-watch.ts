/**
 * The fleet watcher — one read-only pass over the voice lanes.
 *
 *   npx tsx scripts/fleet-watch.ts            # today, UTC
 *   npx tsx scripts/fleet-watch.ts 2026-09-08 # a named day
 *
 * Reads nothing but `SELECT`. Writes nothing, anywhere.
 *
 * ---------------------------------------------------------------------------
 * TWO DATABASES, AND NOTHING JOINS THEM
 * ---------------------------------------------------------------------------
 * `call_logs` is in the Operations Hub (`pslzngjciiifowemrzza`) and `tickets`
 * is in the Support Center (`vsmcxhxeirkoobmjcrbn`). No single statement can
 * reach both, so this script pulls the agent-filed call SIDs from the Support
 * Center and intersects them with the Hub's calls in memory.
 *
 * The Hub connection is required (`SUPABASE_POOLER_URL`, else `DATABASE_URL`).
 * The Support Center connection is OPTIONAL — set `OBS_SUPPORT_DATABASE_URL`
 * to a read-only role there. Without it, every filing figure reports as
 * UNKNOWN and NEVER as zero. See rule 4 in `fleetWatch.logic.ts`: a rate we
 * could not measure being rendered as 0% is the shape of the 2026-09-03 error
 * that understated filing by a third.
 *
 * WHY THE LANE COMES FROM `call_logs.agent_used` AND NEVER FROM THE TICKET'S
 * COPY: on 2026-09-03 the ticket-side `agent_used` read `unknown` on 91 rows,
 * and grouping that day by it reported optical = 1 when optical filed 28. The
 * ticket's copy is for PROVENANCE ONLY (who made it); the call's own row is
 * what attributes a call to a lane.
 */
import pg from 'pg';
import {
  assessFleet,
  fleetFilingStopRun,
  foldCallsIntoWindows,
  formatPct,
  AFTER_HOURS_LANE,
  QUEUE_LANES,
  type CallRow,
  type LaneBaseline,
} from '../server/observatory/fleetWatch.logic';

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);

/** 30s is the substantive floor used by every published figure in /CLAUDE.md
 * and docs/observatory/STATE-OF-PLAY.md. Changing it makes this report
 * incomparable with all of them. */
const SUBSTANTIVE_SECONDS = 30;

/**
 * How many prior days form a lane's own barely-heard baseline.
 *
 * The baseline is COMPUTED, never hardcoded. A constant copied out of a
 * document goes stale silently — the failure the census rule in /CLAUDE.md
 * exists to prevent. Days with no traffic on a lane contribute nothing, so
 * weekends and holidays neither dilute nor inflate it.
 */
const BASELINE_DAYS = 7;

function readOnlyPool(url: string): pg.Pool {
  return new pg.Pool({
    connectionString: url.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, ''),
    max: 2,
    connectionTimeoutMillis: 15_000,
    ssl: { rejectUnauthorized: false },
    options: '-c default_transaction_read_only=on -c statement_timeout=60000',
  });
}

async function loadCalls(hub: pg.Pool): Promise<CallRow[]> {
  const { rows } = await hub.query(
    `
    SELECT c.call_sid,
           c.agent_used,
           coalesce(c.voice_provider,'old-core') AS pipeline,
           c.tool_call_count,
           -- total_turns counts something that is NOT transcript turns (it fell
           -- 16.1 -> 9.7 across the tech cutover while callers said MORE), so
           -- the caller lines are counted from the transcript itself.
           (length(coalesce(c.transcript,'')) -
            length(replace(coalesce(c.transcript,''),'CALLER:','')))/7 AS caller_lines,
           coalesce(g.dob, false) AS dob_refused
    FROM call_logs c
    LEFT JOIN LATERAL (
      SELECT bool_or(e->'outcome'->'missingFields' @> '["date_of_birth"]'::jsonb) AS dob
      FROM jsonb_array_elements(c.tool_timeline->'events') e
    ) g ON true
    WHERE c.created_at::date = $1
      AND c.duration >= $2
      AND c.agent_used IS NOT NULL
    ORDER BY c.created_at
    `,
    [day, SUBSTANTIVE_SECONDS],
  );
  return rows as CallRow[];
}

/** The filing authority from /CLAUDE.md, unchanged: canonical SIDs only,
 * agent provenance only, anchored on the CALL's day with the coalesce. */
async function loadFiledSids(support: pg.Pool): Promise<Set<string>> {
  const { rows } = await support.query(
    `
    SELECT DISTINCT call_sid
    FROM tickets
    WHERE call_sid ~* '^CA[0-9a-f]{32}$'
      AND created_by_id IS NULL
      AND agent_used IS NOT NULL
      AND coalesce(call_start_time, created_at)::date = $1
    `,
    [day],
  );
  return new Set(rows.map((r: { call_sid: string }) => r.call_sid));
}

/**
 * Each lane's own trailing barely-heard record, so a reading over the flat
 * watch level is only escalated when it is ALSO a move against that lane.
 *
 * Why this exists: on the watcher's first live tick (2026-09-09) surgery read
 * 26.4% and no-ivr 30.0%, both over the 25% level, and NEITHER was a move —
 * surgery's own runtime record is 37.2 / 27.5 / 21.6. A flat threshold fires
 * there and would page most days.
 */
async function loadBaselines(hub: pg.Pool): Promise<Map<string, LaneBaseline>> {
  const { rows } = await hub.query(
    `
    SELECT agent_used AS lane,
           count(*) AS n,
           count(*) FILTER (
             WHERE (length(coalesce(transcript,'')) -
                    length(replace(coalesce(transcript,''),'CALLER:','')))/7 <= 1
           ) AS hits,
           min(created_at)::date AS from_day,
           max(created_at)::date AS to_day
    FROM call_logs
    WHERE created_at::date <  $1::date
      AND created_at::date >= $1::date - $2::int
      AND duration >= $3
      AND agent_used IS NOT NULL
    GROUP BY 1
    `,
    [day, BASELINE_DAYS, SUBSTANTIVE_SECONDS],
  );
  const out = new Map<string, LaneBaseline>();
  for (const r of rows as Array<{ lane: string; n: string; hits: string; from_day: string; to_day: string }>) {
    out.set(r.lane, {
      barelyHeardHits: Number(r.hits),
      barelyHeardN: Number(r.n),
      label: `${String(r.from_day).slice(5)}..${String(r.to_day).slice(5)}`,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const hubUrl = process.env.SUPABASE_POOLER_URL || process.env.DATABASE_URL;
  if (!hubUrl) {
    console.error('[fleet-watch] no SUPABASE_POOLER_URL or DATABASE_URL — cannot read call_logs.');
    process.exit(2);
  }
  const supportUrl = process.env.OBS_SUPPORT_DATABASE_URL;

  const hub = readOnlyPool(hubUrl);
  const support = supportUrl ? readOnlyPool(supportUrl) : null;

  try {
    const calls = await loadCalls(hub);
    let filed: Set<string> | null = null;
    if (support) {
      try {
        filed = await loadFiledSids(support);
      } catch (err) {
        // Rule 4: a failed read makes the rate UNKNOWN, never zero.
        console.error(`[fleet-watch] Support Center read failed (${(err as Error).message}) — filing reports as UNKNOWN.`);
        filed = null;
      }
    }

    const windows = foldCallsIntoWindows(calls, filed);
    const baselines = await loadBaselines(hub);
    // ONE filing-stop run for the fleet, over the four lanes the threshold was
    // measured on — not one per lane. See fleetFilingStopRun. (Codex, PR #277.)
    const filingStopRun = fleetFilingStopRun(calls, filed);
    const { findings, closedOffice } = assessFleet(windows, baselines, filingStopRun);

    console.log(`\n=== FLEET WATCH — ${day} (UTC), calls of ${SUBSTANTIVE_SECONDS}s or more ===`);
    if (!support) {
      console.log('filing: UNKNOWN — OBS_SUPPORT_DATABASE_URL is not set. Not zero: unmeasured.');
    }
    console.log(
      '\nlane            pipeline   subst.  filed        barely-heard  DOB-refused  ceiling  tool_count NULL',
    );
    for (const w of windows) {
      const filedCell = w.filed === null ? 'UNKNOWN     ' : `${String(w.filed).padStart(3)} ${formatPct(w.filed, w.substantive).padEnd(8)}`;
      console.log(
        [
          w.lane.padEnd(15),
          w.pipeline.padEnd(10),
          String(w.substantive).padStart(6),
          '  ' + filedCell,
          `${String(w.barelyHeard).padStart(3)} ${formatPct(w.barelyHeard, w.substantive).padEnd(7)}`,
          `${String(w.dobRefused).padStart(3)} ${formatPct(w.dobRefused, w.substantive).padEnd(7)}`,
          String(w.ceilingReached).padStart(6),
          String(w.toolCountNull).padStart(12),
        ].join(' '),
      );
    }

    const queueCalls = windows
      .filter((w) => (QUEUE_LANES as readonly string[]).includes(w.lane))
      .reduce((n, w) => n + w.substantive, 0);
    const afterHours = windows
      .filter((w) => w.lane === AFTER_HOURS_LANE)
      .reduce((n, w) => n + w.substantive, 0);
    console.log(`\nqueue lanes ${queueCalls} substantive · ${AFTER_HOURS_LANE} ${afterHours}${closedOffice ? '  (closed-office shape)' : ''}`);

    console.log('\n--- findings ---');
    if (findings.length === 0) {
      console.log('nothing to report.');
    }
    for (const f of findings) {
      console.log(`[${f.severity.toUpperCase()}] ${f.lane}: ${f.headline}`);
      console.log(`        ${f.detail.replace(/\s+/g, ' ')}`);
    }
    console.log(
      '\nReminders: tool_timeline is reliable for REFUSALS only (it drops ~35% of successful\n' +
      'filings, 100% on pcp). A single hour is never a spike. A row at the tool ceiling is the\n' +
      'ceiling working. Attribute lanes from call_logs.agent_used, never from the ticket copy.\n',
    );
  } finally {
    await hub.end();
    if (support) await support.end();
  }
}

main().catch((err) => {
  console.error('[fleet-watch]', err);
  process.exit(1);
});
