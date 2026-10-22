/**
 * Production FleetReader. Reads call_logs and campaign_contacts only.
 * Never returns a phone number, body or transcript.
 */

import type { FleetDayRow, FleetReader, RecentOutcome } from "./reads";
import type { SqlExec } from "./sqlStore";

export function createSqlFleetReader(exec: SqlExec): FleetReader {
  return {
    async fleetToday(day) {
      try {
        const rows = await exec(
          `SELECT COALESCE(agent_used, 'unknown') AS slug,
                  COUNT(*)::int AS calls,
                  COUNT(*) FILTER (WHERE ticket_number IS NOT NULL)::int AS filed
             FROM call_logs
            WHERE created_at::date = $1::date
            GROUP BY 1
            ORDER BY 1`,
          [day],
        );
        return rows.map((r) => ({
          slug: String(r.slug),
          calls: Number(r.calls),
          filed: Number(r.filed),
          outcomes: {},
        })) as FleetDayRow[];
      } catch {
        return [];
      }
    },
    async recentOutcomes(limit) {
      try {
        const rows = await exec(
          `SELECT agent_used AS slug,
                  runtime_outcome AS outcome,
                  duration,
                  (ticket_number IS NOT NULL) AS filed,
                  start_time
             FROM call_logs
            WHERE call_sid ~* '^CA[0-9a-f]{32}$'
            ORDER BY created_at DESC
            LIMIT $1`,
          [limit],
        );
        return rows.map((r) => ({
          slug: String(r.slug ?? ""),
          outcome: r.outcome == null ? null : String(r.outcome),
          durationSeconds: r.duration == null ? null : Number(r.duration),
          filed: Boolean(r.filed),
          startedAt: r.start_time ? new Date(String(r.start_time)).toISOString() : null,
        })) as RecentOutcome[];
      } catch {
        return [];
      }
    },
    async outboundQueued(campaignKey) {
      try {
        const rows = await exec(
          `SELECT COUNT(*)::int AS n
             FROM campaign_contacts cc
             JOIN campaigns c ON c.id = cc.campaign_id
            WHERE c.name = $1
              AND cc.outreach_status IN ('pending', 'no_answer', 'voicemail', 'callback_scheduled')`,
          [campaignKey],
        );
        return Number(rows[0]?.n ?? 0);
      } catch {
        return 0;
      }
    },
  };
}
