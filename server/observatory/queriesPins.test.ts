/**
 * Source pins for three Observatory numbers fixed 2026-11-26. queries.ts runs
 * against the live Hub pool, so the statements are read as text here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, 'queries.ts'), 'utf8');

describe('Observatory queries', () => {
  it('counts dropped calls, not twilio_error_code (never written; read 0 beside 539 drops in 7 days)', () => {
    expect(src).not.toMatch(/FILTER \(WHERE cl\.twilio_error_code/);
    expect(src).toContain(
      "COUNT(cl.id) FILTER (WHERE cl.runtime_outcome = 'provider_failure' OR cl.status = 'failed')::int AS dropped_calls",
    );
  });

  it('counts a call as live only while it is open and under 15 minutes old', () => {
    const live = src.slice(src.indexOf('AS active_now') - 260, src.indexOf('AS active_now'));
    expect(live).toContain("cl.status IN ('in_progress','ringing','initiated')");
    expect(live).toContain("cl.created_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '15 minutes'");
  });

  it('scores no adherence for a lane with no configured greeting, rather than 0%', () => {
    expect(src).toContain('CASE WHEN a.welcome_greeting IS NULL OR f.call_log_id IS NULL THEN NULL');
  });

  it('sends the Openings panel masked first lines only', () => {
    expect(src).toContain('aggregateOpenings(tops.rows)');
    expect(src).not.toMatch(/sampleOpeningSequences/);
    // The whole first line is read, so the mask runs before any cut.
    expect(src).toContain('LEFT(COALESCE(ct.final_transcript, ct.raw_transcript), 300) AS opening');
  });
});
