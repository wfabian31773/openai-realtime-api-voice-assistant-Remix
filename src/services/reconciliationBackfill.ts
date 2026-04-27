import { db } from '../../server/db';
import { dailyReconciliation } from '../../shared/schema';
import { gte } from 'drizzle-orm';
import { orgBillingLedger } from './orgBillingLedger';

const BACKFILL_DAYS = 7;

export async function backfillMissingReconciliations(): Promise<void> {
  try {
    const today = new Date();
    const dates: string[] = [];
    for (let i = 1; i <= BACKFILL_DAYS; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const cutoff = dates[dates.length - 1];
    const existing = await db
      .select({ dateUtc: dailyReconciliation.dateUtc })
      .from(dailyReconciliation)
      .where(gte(dailyReconciliation.dateUtc, cutoff));

    const existingDates = new Set(existing.map(r => r.dateUtc));
    const missing = dates.filter(d => !existingDates.has(d));

    if (missing.length === 0) {
      console.log('[STARTUP] No missing reconciliation days found in the last 7 days');
      return;
    }

    console.log(`[STARTUP] Backfilling ${missing.length} missing reconciliation day(s): ${missing.join(', ')}`);

    for (const dateStr of missing.sort()) {
      try {
        const result = await orgBillingLedger.reconcileDay(dateStr);
        if (result.success) {
          console.log(`[STARTUP] Backfilled reconciliation for ${dateStr}: actual=$${result.actualUsd?.toFixed(2)}`);
        } else {
          console.warn(`[STARTUP] Backfill failed for ${dateStr}: ${result.error}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        console.warn(`[STARTUP] Backfill error for ${dateStr}:`, err);
      }
    }
  } catch (error) {
    console.error('[STARTUP] Error during reconciliation backfill:', error);
  }
}
