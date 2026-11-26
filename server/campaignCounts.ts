/**
 * server/campaignCounts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The contact counts a runtime outbound campaign really has.
 *
 * `campaigns.total_contacts / completed_contacts / successful_contacts` are
 * kept by the old core's campaign executor and are never written for a
 * `runtime_outbound` campaign, so the Dashboard and the Campaigns page showed
 * NPX outreach at 0/0 while it held 1,472 contacts, had called 1,414 and
 * settled 192 as completed (measured 2026-11-26). For those campaigns the
 * three numbers are counted from campaign_contacts on every read:
 *   total      = contacts on the campaign
 *   completed  = contacts called at least once (`contacted`)
 *   successful = contacts whose outreach ended `completed`
 * Every other campaign keeps the columns as the executor wrote them.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const RUNTIME_CAMPAIGN_COUNTS_SQL = `
SELECT cc.campaign_id::text                                    AS campaign_id,
       count(*)::int                                           AS total,
       count(*) FILTER (WHERE cc.contacted)::int               AS contacted,
       count(*) FILTER (WHERE cc.outreach_status = 'completed')::int AS completed
  FROM campaign_contacts cc
  JOIN campaigns c ON c.id = cc.campaign_id
 WHERE c.campaign_type = 'runtime_outbound' AND c.deleted_at IS NULL
 GROUP BY cc.campaign_id`;

type CampaignLike = { id: string; campaignType?: string | null; totalContacts?: number | null; completedContacts?: number | null; successfulContacts?: number | null };

export async function withRuntimeCounts<T extends CampaignLike>(q: Queryable, campaigns: T[]): Promise<T[]> {
  if (!campaigns.some((c) => c.campaignType === 'runtime_outbound')) return campaigns;
  const { rows } = await q.query(RUNTIME_CAMPAIGN_COUNTS_SQL);
  const byId = new Map(rows.map((r) => [String(r.campaign_id), r]));
  return campaigns.map((c) => {
    if (c.campaignType !== 'runtime_outbound') return c;
    const r = byId.get(String(c.id));
    return {
      ...c,
      totalContacts: Number(r?.total ?? 0),
      completedContacts: Number(r?.contacted ?? 0),
      successfulContacts: Number(r?.completed ?? 0),
    };
  });
}
