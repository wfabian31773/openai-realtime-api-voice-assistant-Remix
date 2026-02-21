import type { Express, Request, Response } from 'express';
import { ticketingSyncService } from '../../../server/services/ticketingSyncService';

export function registerTicketingSyncRoutes(app: Express): void {
  app.get('/api/ticketing-sync/status', async (_req: Request, res: Response) => {
    try {
      const status = await ticketingSyncService.getSyncStatus();
      res.json({ success: true, ...status });
    } catch (error) {
      console.error('[TICKETING SYNC] Error getting status:', error);
      res.status(500).json({ success: false, error: 'Failed to get sync status' });
    }
  });

  app.post('/api/ticketing-sync/trigger', async (_req: Request, res: Response) => {
    try {
      const result = await ticketingSyncService.manualSync();
      
      if ('inProgress' in result) {
        return res.status(409).json({ 
          success: false, 
          inProgress: true,
          message: result.message 
        });
      }
      
      const results = result;
      const successCount = results.filter((r: { success: boolean }) => r.success).length;
      const failCount = results.filter((r: { success: boolean }) => !r.success).length;
      const exhaustedCount = results.filter((r: { retriesExhausted?: boolean }) => r.retriesExhausted).length;
      res.json({ 
        success: true, 
        message: `Synced ${successCount} calls, ${failCount} failed, ${exhaustedCount} gave up`,
        results 
      });
    } catch (error) {
      console.error('[TICKETING SYNC] Error triggering sync:', error);
      res.status(500).json({ success: false, error: 'Failed to trigger sync' });
    }
  });
  
  console.info('[ROUTES] Ticketing sync routes registered');
}
