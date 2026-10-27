/**
 * The production dialler lock: the repo's own distributed lock
 * (src/services/distributedLock.ts), on the Hub's `distributed_locks` table.
 * Imported lazily inside `acquire` so nothing opens the database just by
 * importing the runtime — only a tick with dialling switched on does.
 */
import type { DialerLock } from "./scheduler";
import { OUTBOUND_LOCK_NAME } from "./scheduler";

/** Long enough for a tick, short enough that a dead instance frees it fast. */
const LOCK_TTL_SECONDS = 50;
const HOLDER = "outbound-dialer";

let acquiringOrHeld = false;

export const defaultDialerLock: DialerLock = {
  async acquire() {
    if (acquiringOrHeld) return false;
    acquiringOrHeld = true;
    try {
      const { distributedLockService } = await import("../../services/distributedLock");
      const result = await distributedLockService.acquireLock({
        lockName: OUTBOUND_LOCK_NAME,
        holderId: HOLDER,
        ttlSeconds: LOCK_TTL_SECONDS,
      });
      acquiringOrHeld = result.acquired;
      return result.acquired;
    } catch (error) {
      acquiringOrHeld = false;
      throw error;
    }
  },
  async release() {
    const { distributedLockService } = await import("../../services/distributedLock");
    try {
      await distributedLockService.releaseLock(OUTBOUND_LOCK_NAME, HOLDER);
    } finally {
      acquiringOrHeld = false;
    }
  },
};
