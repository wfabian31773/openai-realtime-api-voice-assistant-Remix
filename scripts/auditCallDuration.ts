/**
 * CALL DURATION AUDIT — is billed time actually conversation?
 *
 * Read-only. Answers three questions the sync logs cannot:
 *
 *   1. Is the ~600s clustering real? The `[DURATION FIX]` sweep only ever
 *      SELECTs `duration >= 550`, so every call it prints is long by
 *      construction. Judging the duration distribution from those lines is
 *      reading a filter's output as a population. This reports the real
 *      distribution over every completed call in the window.
 *
 *   2. How much billed time had nobody talking? call_logs already records
 *      first_transcript_delay_ms (head silence), post_transcript_tail_ms
 *      (tail silence) and transcript_window_seconds (first→last transcript),
 *      so dead air is measurable per call rather than inferred.
 *
 *   3. Which calls are worth looking at? Ranked by dead-air seconds and priced
 *      at the same rate the cost service bills, so the answer is in dollars.
 *
 * Usage:
 *   npx tsx scripts/auditCallDuration.ts [--days 7] [--agent azul-scheduling] [--top 15]
 */
import 'dotenv/config';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';
import { OPENAI_COST_CENTS_PER_SECOND } from '../src/services/callCostRates';
import { getMaxDurationMs } from '../src/services/callDurationPolicy';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DAYS = parseInt(arg('--days', '7'), 10);
const TOP = parseInt(arg('--top', '15'), 10);
const AGENT = arg('--agent', '');

/** Silence between two turns only counts as dead air past this. */
const GAP_THRESHOLD_S = 30;
/** A call within this much of its agent's ceiling was probably cut off. */
const NEAR_CAP_S = 30;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const secs = (s: number) => `${Math.round(s)}s`;

interface Row {
  id: string;
  agent_used: string | null;
  duration: number;
  total_turns: number | null;
  head_s: number | null;
  tail_s: number | null;
  talk_s: number | null;
  agent_outcome: string | null;
  who_hung_up: string | null;
  transferred: boolean | null;
  started: Date | null;
}

async function main(): Promise<void> {
  const agentFilter = AGENT ? sql`AND agent_used = ${AGENT}` : sql``;

  const { rows } = (await db.execute(sql`
    SELECT
      id,
      agent_used,
      duration,
      total_turns,
      first_transcript_delay_ms / 1000.0 AS head_s,
      post_transcript_tail_ms  / 1000.0 AS tail_s,
      transcript_window_seconds         AS talk_s,
      agent_outcome,
      who_hung_up,
      transferred_to_human AS transferred,
      start_time           AS started
    FROM call_logs
    WHERE status = 'completed'
      AND duration IS NOT NULL
      AND duration > 0
      AND start_time >= NOW() - ${`${DAYS} days`}::interval
      ${agentFilter}
    ORDER BY duration DESC
  `)) as unknown as { rows: Row[] };

  if (rows.length === 0) {
    console.log(`No completed calls in the last ${DAYS} days${AGENT ? ` for ${AGENT}` : ''}.`);
    return;
  }

  const durations = rows.map(r => r.duration).sort((a, b) => a - b);
  const pct = (p: number) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
  const total = durations.reduce((a, b) => a + b, 0);

  console.log(`\n=== DURATION DISTRIBUTION — ${rows.length} completed calls, last ${DAYS}d${AGENT ? `, agent=${AGENT}` : ''} ===\n`);
  console.log(`  mean ${secs(total / rows.length)}   p50 ${secs(pct(0.5))}   p90 ${secs(pct(0.9))}   p99 ${secs(pct(0.99))}   max ${secs(durations[durations.length - 1])}`);

  // The histogram is the actual answer to "are all my calls ~10 minutes?".
  // If mass sits in the low buckets, the sweep's log was selection bias.
  const buckets: [string, (d: number) => boolean][] = [
    ['0-60s     ', d => d <= 60],
    ['1-3m      ', d => d > 60 && d <= 180],
    ['3-5m      ', d => d > 180 && d <= 300],
    ['5-9m      ', d => d > 300 && d <= 540],
    ['9-11m ⚠︎  ', d => d > 540 && d <= 660],
    ['11-15m    ', d => d > 660 && d <= 900],
    ['15m+      ', d => d > 900],
  ];
  console.log('');
  for (const [label, test] of buckets) {
    const n = durations.filter(test).length;
    const share = (n / rows.length) * 100;
    console.log(`  ${label} ${String(n).padStart(5)}  ${share.toFixed(1).padStart(5)}%  ${'█'.repeat(Math.round(share / 2))}`);
  }
  console.log(`\n  (the 9-11m band is where the old 10-minute ceiling used to pile calls up)`);

  // ---- Dead air -----------------------------------------------------------
  // duration = head + talk-window + tail. Rows predating the telemetry have
  // nulls; count them separately rather than scoring them as zero dead air.
  const measured = rows.filter(r => r.talk_s != null);
  const unmeasured = rows.length - measured.length;

  const scored = measured.map(r => {
    const head = r.head_s ?? 0;
    const tail = r.tail_s ?? 0;
    // Edge silence is what the transcript window cannot account for. Clamp at
    // 0: the window and Twilio's duration come from different clocks, so tiny
    // negatives are rounding, not negative dead air.
    const edge = Math.max(0, r.duration - (r.talk_s ?? 0));
    return { ...r, head, tail, edge, deadPct: (edge / r.duration) * 100 };
  });

  const deadTotal = scored.reduce((a, r) => a + r.edge, 0);
  const billedTotal = scored.reduce((a, r) => a + r.duration, 0);

  console.log(`\n=== DEAD AIR (silence outside the first→last transcript window) ===\n`);
  if (unmeasured > 0) {
    console.log(`  ${unmeasured} of ${rows.length} calls predate turn telemetry and are excluded.\n`);
  }
  console.log(`  billed        ${secs(billedTotal)}  (${(billedTotal / 3600).toFixed(1)}h)`);
  console.log(`  dead air      ${secs(deadTotal)}  (${((deadTotal / billedTotal) * 100).toFixed(1)}% of billed time)`);
  console.log(`  OpenAI cost of that dead air: ${usd(deadTotal * OPENAI_COST_CENTS_PER_SECOND)}  over ${DAYS} days`);
  console.log(`  annualized:                   ${usd((deadTotal / DAYS) * 365 * OPENAI_COST_CENTS_PER_SECOND)}`);

  // ---- Silent calls -------------------------------------------------------
  // A long call with almost no turns is the shape the dead-air watchdog exists
  // to kill: the line stayed open while nothing was said.
  const silent = scored.filter(r => r.duration > 120 && (r.total_turns ?? 0) <= 3);
  console.log(`\n=== NEAR-SILENT CALLS (>2min billed, <=3 agent turns) ===\n`);
  if (silent.length === 0) {
    console.log('  None. The dead-air watchdog appears to be doing its job.');
  } else {
    console.log(`  ${silent.length} calls, ${secs(silent.reduce((a, r) => a + r.duration, 0))} billed, ` +
      `${usd(silent.reduce((a, r) => a + r.duration, 0) * OPENAI_COST_CENTS_PER_SECOND)} of OpenAI spend.`);
    for (const r of silent.slice(0, TOP)) {
      console.log(`    ${r.id}  ${secs(r.duration)}  turns=${r.total_turns ?? '?'}  agent=${r.agent_used ?? '?'}  outcome=${r.agent_outcome ?? '-'}`);
    }
  }

  // ---- Calls cut off by the ceiling --------------------------------------
  const nearCap = rows.filter(r => {
    const capS = getMaxDurationMs(r.agent_used ?? undefined) / 1000;
    return r.duration >= capS - NEAR_CAP_S;
  });
  console.log(`\n=== CALLS AT THEIR AGENT'S CEILING (within ${NEAR_CAP_S}s) ===\n`);
  if (nearCap.length === 0) {
    console.log('  None — no call is being force-terminated by the cap.');
  } else {
    console.log(`  ${nearCap.length} calls hit the ceiling. These were hung up mid-sentence, not concluded:\n`);
    for (const r of nearCap.slice(0, TOP)) {
      const capS = getMaxDurationMs(r.agent_used ?? undefined) / 1000;
      console.log(`    ${r.id}  ${secs(r.duration)}/${secs(capS)}  agent=${r.agent_used ?? '?'}  outcome=${r.agent_outcome ?? '-'}  transferred=${r.transferred ?? false}`);
    }
  }

  // ---- Worst offenders ----------------------------------------------------
  console.log(`\n=== TOP ${TOP} CALLS BY DEAD AIR ===\n`);
  console.log(`  ${'call'.padEnd(38)} ${'billed'.padStart(7)} ${'talk'.padStart(7)} ${'dead'.padStart(7)} ${'dead%'.padStart(6)}  turns  agent`);
  for (const r of [...scored].sort((a, b) => b.edge - a.edge).slice(0, TOP)) {
    console.log(
      `  ${r.id.padEnd(38)} ${secs(r.duration).padStart(7)} ${secs(r.talk_s ?? 0).padStart(7)} ` +
      `${secs(r.edge).padStart(7)} ${r.deadPct.toFixed(0).padStart(5)}%  ${String(r.total_turns ?? '?').padStart(5)}  ${r.agent_used ?? '?'}`
    );
  }

  // ---- Mid-call gaps ------------------------------------------------------
  // call_turns.since_prev_ms is recorded precisely for this. It only covers
  // calls logged after turn-level logging landed, so report coverage first.
  const { rows: gapRows } = (await db.execute(sql`
    SELECT
      t.call_log_id                                        AS id,
      COUNT(*)                                             AS long_gaps,
      SUM(t.since_prev_ms) / 1000.0                        AS gap_s,
      MAX(t.since_prev_ms) / 1000.0                        AS worst_gap_s
    FROM call_turns t
    JOIN call_logs c ON c.id = t.call_log_id
    WHERE c.start_time >= NOW() - ${`${DAYS} days`}::interval
      AND t.since_prev_ms > ${GAP_THRESHOLD_S * 1000}
      ${AGENT ? sql`AND c.agent_used = ${AGENT}` : sql``}
    GROUP BY t.call_log_id
    ORDER BY gap_s DESC
    LIMIT ${TOP}
  `)) as unknown as { rows: { id: string; long_gaps: number; gap_s: number; worst_gap_s: number }[] };

  console.log(`\n=== MID-CALL SILENCE (gaps > ${GAP_THRESHOLD_S}s between turns) ===\n`);
  if (gapRows.length === 0) {
    console.log(`  No qualifying gaps — either genuinely none, or call_turns has no rows for this window.`);
  } else {
    for (const g of gapRows) {
      console.log(`    ${g.id}  ${g.long_gaps} gaps  ${secs(g.gap_s)} total  worst ${secs(g.worst_gap_s)}`);
    }
  }

  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[AUDIT] Failed:', err);
    process.exit(1);
  });
