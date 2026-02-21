import { EventEmitter } from 'events';
import { db } from '../../server/db';
import { sql } from 'drizzle-orm';
import { createLogger } from './structuredLogger';

const logger = createLogger('DISTRIBUTED_LOCK');

export interface LockResult {
  acquired: boolean;
  lockId?: string;
  holder?: string;
  expiresAt?: Date;
}

export interface DistributedLockOptions {
  lockName: string;
  holderId: string;
  ttlSeconds?: number;
  waitTimeoutMs?: number;
}

const DEFAULT_TTL_SECONDS = 300;
const INSTANCE_ID = `${process.env.HOSTNAME || 'local'}-${process.pid}-${Date.now()}`;

class DistributedLockService extends EventEmitter {
  private heldLocks = new Map<string, { lockId: string; refreshInterval: NodeJS.Timeout }>();

  constructor() {
    super();
  }

  async acquireLock(options: DistributedLockOptions): Promise<LockResult> {
    const { lockName, holderId, ttlSeconds = DEFAULT_TTL_SECONDS } = options;
    const fullHolderId = `${holderId}:${INSTANCE_ID}`;
    
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      const result = await db.execute(sql`
        INSERT INTO distributed_locks (lock_name, holder_id, acquired_at, expires_at)
        VALUES (${lockName}, ${fullHolderId}, ${now}, ${expiresAt})
        ON CONFLICT (lock_name) DO UPDATE SET
          holder_id = CASE 
            WHEN distributed_locks.expires_at < ${now} THEN ${fullHolderId}
            ELSE distributed_locks.holder_id
          END,
          acquired_at = CASE 
            WHEN distributed_locks.expires_at < ${now} THEN ${now}
            ELSE distributed_locks.acquired_at
          END,
          expires_at = CASE 
            WHEN distributed_locks.expires_at < ${now} THEN ${expiresAt}
            ELSE distributed_locks.expires_at
          END
        RETURNING holder_id, expires_at
      `);

      const row = (result.rows as any[])[0];
      const acquired = row?.holder_id === fullHolderId;

      if (acquired) {
        logger.info(`Lock acquired: ${lockName}`, { 
          lockName, 
          holderId: fullHolderId, 
          expiresAt: expiresAt.toISOString() 
        });

        const refreshInterval = setInterval(async () => {
          await this.refreshLock(lockName, fullHolderId, ttlSeconds);
        }, (ttlSeconds * 1000) / 2);

        this.heldLocks.set(lockName, { lockId: fullHolderId, refreshInterval });

        return { acquired: true, lockId: fullHolderId, expiresAt };
      } else {
        logger.debug(`Lock not acquired: ${lockName} (held by ${row?.holder_id})`, {
          lockName,
          holder: row?.holder_id,
        });
        return { 
          acquired: false, 
          holder: row?.holder_id, 
          expiresAt: row?.expires_at ? new Date(row.expires_at) : undefined 
        };
      }
    } catch (error) {
      logger.error(`Failed to acquire lock: ${lockName}`, { lockName, error: String(error) });
      return { acquired: false };
    }
  }

  private async refreshLock(lockName: string, holderId: string, ttlSeconds: number): Promise<boolean> {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      const result = await db.execute(sql`
        UPDATE distributed_locks 
        SET expires_at = ${expiresAt}
        WHERE lock_name = ${lockName} AND holder_id = ${holderId}
        RETURNING lock_name
      `);

      const refreshed = (result.rows as any[]).length > 0;
      if (refreshed) {
        logger.debug(`Lock refreshed: ${lockName}`, { lockName, expiresAt: expiresAt.toISOString() });
      } else {
        logger.warn(`Lock refresh failed - lock lost: ${lockName}`, { lockName, holderId });
        this.handleLockLost(lockName);
      }
      return refreshed;
    } catch (error) {
      logger.error(`Lock refresh error: ${lockName}`, { lockName, error: String(error) });
      this.handleLockLost(lockName);
      return false;
    }
  }

  private handleLockLost(lockName: string): void {
    const heldLock = this.heldLocks.get(lockName);
    if (heldLock) {
      clearInterval(heldLock.refreshInterval);
      this.heldLocks.delete(lockName);
    }
    this.emit('lock-lost', { lockName });
  }

  onLockLost(callback: (data: { lockName: string }) => void): void {
    this.on('lock-lost', callback);
  }

  async releaseLock(lockName: string, holderId?: string): Promise<boolean> {
    try {
      const heldLock = this.heldLocks.get(lockName);
      const fullHolderId = holderId ? `${holderId}:${INSTANCE_ID}` : heldLock?.lockId;

      if (heldLock) {
        clearInterval(heldLock.refreshInterval);
        this.heldLocks.delete(lockName);
      }

      if (!fullHolderId) {
        logger.warn(`Cannot release lock - no holder ID: ${lockName}`, { lockName });
        return false;
      }

      const result = await db.execute(sql`
        DELETE FROM distributed_locks 
        WHERE lock_name = ${lockName} AND holder_id = ${fullHolderId}
        RETURNING lock_name
      `);

      const released = (result.rows as any[]).length > 0;
      if (released) {
        logger.info(`Lock released: ${lockName}`, { lockName, holderId: fullHolderId });
      } else {
        logger.warn(`Lock release failed - not owned: ${lockName}`, { lockName, holderId: fullHolderId });
      }
      return released;
    } catch (error) {
      logger.error(`Failed to release lock: ${lockName}`, { lockName, error: String(error) });
      return false;
    }
  }

  async isLockHeld(lockName: string): Promise<{ held: boolean; holder?: string; expiresAt?: Date }> {
    try {
      const now = new Date();
      const result = await db.execute(sql`
        SELECT holder_id, expires_at FROM distributed_locks 
        WHERE lock_name = ${lockName} AND expires_at > ${now}
      `);

      const row = (result.rows as any[])[0];
      if (row) {
        return { 
          held: true, 
          holder: row.holder_id, 
          expiresAt: new Date(row.expires_at) 
        };
      }
      return { held: false };
    } catch (error) {
      logger.error(`Failed to check lock status: ${lockName}`, { lockName, error: String(error) });
      return { held: false };
    }
  }

  async cleanupExpiredLocks(): Promise<number> {
    try {
      const now = new Date();
      const result = await db.execute(sql`
        DELETE FROM distributed_locks WHERE expires_at < ${now}
        RETURNING lock_name
      `);
      const count = (result.rows as any[]).length;
      if (count > 0) {
        logger.info(`Cleaned up ${count} expired locks`);
      }
      return count;
    } catch (error) {
      logger.error('Failed to cleanup expired locks', { error: String(error) });
      return 0;
    }
  }

  releaseAllLocalLocks(): void {
    for (const [lockName, { refreshInterval }] of this.heldLocks) {
      clearInterval(refreshInterval);
      this.releaseLock(lockName).catch(() => {});
    }
    this.heldLocks.clear();
  }
}

export const distributedLockService = new DistributedLockService();

process.on('beforeExit', () => {
  distributedLockService.releaseAllLocalLocks();
});

process.on('SIGTERM', () => {
  distributedLockService.releaseAllLocalLocks();
});
