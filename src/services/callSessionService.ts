import { db } from '../../server/db';
import { activeCallSessions, ActiveCallSession, InsertActiveCallSession } from '../../shared/schema';
import { eq, and, lt, or } from 'drizzle-orm';
import { withRetry } from '../../server/services/dbResilience';

const SESSION_TTL_MINUTES = 30; // Sessions expire after 30 minutes of inactivity
const DB_RETRY_CONFIG = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 1000, jitterMs: 100 };

/**
 * Hybrid call session service with in-memory L1 cache and PostgreSQL persistence.
 * 
 * Design rationale:
 * - In-memory cache provides <1ms lookups for real-time SIP handling
 * - PostgreSQL provides durability across server restarts/failovers
 * - Dual-write ensures consistency: writes go to both cache and DB
 * - Cache miss triggers DB lookup and cache population
 * - TTL-based cleanup prevents memory leaks
 */

// L1 Cache: In-memory maps for fast lookups (same structure as legacy)
const sessionCache = new Map<string, ActiveCallSession>(); // keyed by conferenceName
const openaiCallIdIndex = new Map<string, string>(); // openaiCallId → conferenceName
const twilioCallSidIndex = new Map<string, string>(); // twilioCallSid → conferenceName
const conferenceSidIndex = new Map<string, string>(); // conferenceSid → conferenceName

// Metrics for monitoring cache vs DB performance
let cacheHits = 0;
let cacheMisses = 0;
let dbWriteErrors = 0;

export class CallSessionService {
  /**
   * Update cache indexes when a session is added/updated
   */
  private updateCacheIndexes(session: ActiveCallSession): void {
    if (session.openaiCallId) {
      openaiCallIdIndex.set(session.openaiCallId, session.conferenceName);
    }
    if (session.twilioCallSid) {
      twilioCallSidIndex.set(session.twilioCallSid, session.conferenceName);
    }
    if (session.conferenceSid) {
      conferenceSidIndex.set(session.conferenceSid, session.conferenceName);
    }
    sessionCache.set(session.conferenceName, session);
  }

  /**
   * Remove session from cache and indexes
   */
  private removeFromCache(conferenceName: string): void {
    const session = sessionCache.get(conferenceName);
    if (session) {
      if (session.openaiCallId) openaiCallIdIndex.delete(session.openaiCallId);
      if (session.twilioCallSid) twilioCallSidIndex.delete(session.twilioCallSid);
      if (session.conferenceSid) conferenceSidIndex.delete(session.conferenceSid);
      sessionCache.delete(conferenceName);
    }
  }

  /**
   * Create or update a call session with dual-write (cache + DB)
   * This is the primary entry point when a new call arrives
   */
  async upsertSession(conferenceName: string, data: Partial<InsertActiveCallSession>): Promise<ActiveCallSession> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000);
    const now = new Date();
    
    // Build the session object for cache
    const existingCached = sessionCache.get(conferenceName);
    const sessionData: ActiveCallSession = {
      id: existingCached?.id || 'pending', // Will be set by DB
      conferenceName,
      twilioCallSid: data.twilioCallSid ?? existingCached?.twilioCallSid ?? null,
      openaiCallId: data.openaiCallId ?? existingCached?.openaiCallId ?? null,
      conferenceSid: data.conferenceSid ?? existingCached?.conferenceSid ?? null,
      callLogId: data.callLogId ?? existingCached?.callLogId ?? null,
      callerNumber: data.callerNumber ?? existingCached?.callerNumber ?? null,
      calledNumber: data.calledNumber ?? existingCached?.calledNumber ?? null,
      callToken: data.callToken ?? existingCached?.callToken ?? null,
      agentSlug: data.agentSlug ?? existingCached?.agentSlug ?? null,
      state: data.state ?? existingCached?.state ?? 'initializing',
      openaiSessionEstablished: data.openaiSessionEstablished ?? existingCached?.openaiSessionEstablished ?? false,
      humanTransferInitiated: data.humanTransferInitiated ?? existingCached?.humanTransferInitiated ?? false,
      lastError: data.lastError ?? existingCached?.lastError ?? null,
      retryCount: data.retryCount ?? existingCached?.retryCount ?? 0,
      createdAt: existingCached?.createdAt ?? now,
      updatedAt: now,
      expiresAt,
    };
    
    // Write to cache immediately (L1 - fast path)
    this.updateCacheIndexes(sessionData);
    
    // Write to DB asynchronously (L2 - durable path)
    // Don't await - let DB write happen in background to minimize latency
    this.persistToDb(conferenceName, data, expiresAt).catch(error => {
      dbWriteErrors++;
      console.error(`[CALL SESSION] DB write failed for ${conferenceName} (cache still valid):`, error);
    });
    
    return sessionData;
  }

  /**
   * Persist session to database (background operation with retry)
   */
  private async persistToDb(conferenceName: string, data: Partial<InsertActiveCallSession>, expiresAt: Date): Promise<void> {
    await withRetry(async () => {
      const [session] = await db.insert(activeCallSessions)
        .values({
          conferenceName,
          ...data,
          expiresAt,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: activeCallSessions.conferenceName,
          set: {
            ...data,
            expiresAt,
            updatedAt: new Date(),
          },
        })
        .returning();
      
      // Update cache with real DB ID
      if (session) {
        this.updateCacheIndexes(session);
      }
    }, `persistSession(${conferenceName.slice(-8)})`, DB_RETRY_CONFIG);
  }

  /**
   * Get session by conference name (primary lookup)
   * Uses cache-first strategy with DB fallback
   */
  async getByConferenceName(conferenceName: string): Promise<ActiveCallSession | null> {
    // L1 cache hit
    const cached = sessionCache.get(conferenceName);
    if (cached) {
      cacheHits++;
      return cached;
    }
    
    // L2 DB fallback
    cacheMisses++;
    try {
      const [session] = await db.select()
        .from(activeCallSessions)
        .where(eq(activeCallSessions.conferenceName, conferenceName))
        .limit(1);
      
      if (session) {
        // Populate cache from DB
        this.updateCacheIndexes(session);
        console.info(`[CALL SESSION] Cache miss for ${conferenceName} - loaded from DB`);
      }
      return session || null;
    } catch (error) {
      console.error(`[CALL SESSION] DB lookup failed for ${conferenceName}:`, error);
      return null;
    }
  }

  /**
   * Get session by OpenAI call ID (uses index for fast lookup)
   */
  async getByOpenAICallId(openaiCallId: string): Promise<ActiveCallSession | null> {
    // Check index first
    const conferenceName = openaiCallIdIndex.get(openaiCallId);
    if (conferenceName) {
      cacheHits++;
      return sessionCache.get(conferenceName) || null;
    }
    
    // DB fallback
    cacheMisses++;
    try {
      const [session] = await db.select()
        .from(activeCallSessions)
        .where(eq(activeCallSessions.openaiCallId, openaiCallId))
        .limit(1);
      
      if (session) {
        this.updateCacheIndexes(session);
        console.info(`[CALL SESSION] Cache miss for openaiCallId ${openaiCallId} - loaded from DB`);
      }
      return session || null;
    } catch (error) {
      console.error(`[CALL SESSION] DB lookup failed for openaiCallId ${openaiCallId}:`, error);
      return null;
    }
  }

  /**
   * Get session by Twilio call SID
   */
  async getByTwilioCallSid(twilioCallSid: string): Promise<ActiveCallSession | null> {
    // Check index first
    const conferenceName = twilioCallSidIndex.get(twilioCallSid);
    if (conferenceName) {
      cacheHits++;
      return sessionCache.get(conferenceName) || null;
    }
    
    // DB fallback
    cacheMisses++;
    try {
      const [session] = await db.select()
        .from(activeCallSessions)
        .where(eq(activeCallSessions.twilioCallSid, twilioCallSid))
        .limit(1);
      
      if (session) {
        this.updateCacheIndexes(session);
        console.info(`[CALL SESSION] Cache miss for twilioCallSid ${twilioCallSid} - loaded from DB`);
      }
      return session || null;
    } catch (error) {
      console.error(`[CALL SESSION] DB lookup failed for twilioCallSid ${twilioCallSid}:`, error);
      return null;
    }
  }

  /**
   * Get session by conference SID
   */
  async getByConferenceSid(conferenceSid: string): Promise<ActiveCallSession | null> {
    // Check index first
    const conferenceName = conferenceSidIndex.get(conferenceSid);
    if (conferenceName) {
      cacheHits++;
      return sessionCache.get(conferenceName) || null;
    }
    
    // DB fallback
    cacheMisses++;
    try {
      const [session] = await db.select()
        .from(activeCallSessions)
        .where(eq(activeCallSessions.conferenceSid, conferenceSid))
        .limit(1);
      
      if (session) {
        this.updateCacheIndexes(session);
        console.info(`[CALL SESSION] Cache miss for conferenceSid ${conferenceSid} - loaded from DB`);
      }
      return session || null;
    } catch (error) {
      console.error(`[CALL SESSION] DB lookup failed for conferenceSid ${conferenceSid}:`, error);
      return null;
    }
  }

  /**
   * Get session by call log ID (DB lookup only - not indexed in cache)
   */
  async getByCallLogId(callLogId: string): Promise<ActiveCallSession | null> {
    try {
      const [session] = await db.select()
        .from(activeCallSessions)
        .where(eq(activeCallSessions.callLogId, callLogId))
        .limit(1);
      
      if (session) {
        this.updateCacheIndexes(session);
      }
      return session || null;
    } catch (error) {
      console.error(`[CALL SESSION] DB lookup failed for callLogId ${callLogId}:`, error);
      return null;
    }
  }

  /**
   * Update session state with automatic timestamp refresh (dual-write)
   */
  async updateState(conferenceName: string, state: string, additionalData?: Partial<InsertActiveCallSession>): Promise<ActiveCallSession | null> {
    // Update cache immediately
    const cached = sessionCache.get(conferenceName);
    if (cached) {
      const updated = {
        ...cached,
        state,
        ...additionalData,
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000),
      };
      this.updateCacheIndexes(updated);
    }
    
    // Persist to DB in background with retry
    const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000);
    withRetry(async () => {
      const [session] = await db.update(activeCallSessions)
        .set({
          state,
          ...additionalData,
          expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(activeCallSessions.conferenceName, conferenceName))
        .returning();
      if (session) {
        this.updateCacheIndexes(session);
      }
    }, `updateState(${conferenceName.slice(-8)})`, DB_RETRY_CONFIG)
      .catch(error => {
        dbWriteErrors++;
        console.error(`[CALL SESSION] DB update failed for ${conferenceName}:`, error);
      });
    
    console.info(`[CALL SESSION] Updated ${conferenceName}: state=${state}`);
    return sessionCache.get(conferenceName) || null;
  }

  /**
   * Mark session as having OpenAI connection established
   */
  async markOpenAIConnected(conferenceName: string): Promise<void> {
    await this.updateState(conferenceName, 'connected', {
      openaiSessionEstablished: true,
    });
  }

  /**
   * Mark session as transferred to human
   */
  async markHumanTransfer(conferenceName: string): Promise<void> {
    await this.updateState(conferenceName, 'transferring', {
      humanTransferInitiated: true,
    });
  }

  /**
   * Record an error on the session
   */
  async recordError(conferenceName: string, error: string): Promise<void> {
    const session = await this.getByConferenceName(conferenceName);
    await this.updateState(conferenceName, 'failed', {
      lastError: error.substring(0, 1000), // Truncate long errors
      retryCount: (session?.retryCount || 0) + 1,
    });
  }

  /**
   * Mark session as completed (call ended normally)
   */
  async markCompleted(conferenceName: string): Promise<void> {
    await this.updateState(conferenceName, 'completed');
  }

  /**
   * Delete session from cache and DB (for cleanup)
   */
  async deleteSession(conferenceName: string): Promise<void> {
    // Remove from cache immediately
    this.removeFromCache(conferenceName);
    
    // Remove from DB in background with retry
    withRetry(async () => {
      await db.delete(activeCallSessions)
        .where(eq(activeCallSessions.conferenceName, conferenceName));
    }, `deleteSession(${conferenceName.slice(-8)})`, DB_RETRY_CONFIG)
      .catch(error => {
        console.error(`[CALL SESSION] DB delete failed for ${conferenceName}:`, error);
      });
    
    console.info(`[CALL SESSION] Deleted session ${conferenceName}`);
  }

  /**
   * Delete session by Twilio CallSid - fallback cleanup when conference name unknown
   * This handles the case where termination events arrive before call mappings are registered
   */
  async deleteSessionByTwilioCallSid(twilioCallSid: string): Promise<ActiveCallSession | null> {
    // First look up the session to get conference name
    const session = await this.getByTwilioCallSid(twilioCallSid);
    if (!session) {
      console.debug(`[CALL SESSION] No session found for twilioCallSid ${twilioCallSid}`);
      return null;
    }

    // Remove from cache using conference name
    this.removeFromCache(session.conferenceName);
    
    // Remove from DB with retry
    await withRetry(async () => {
      await db.delete(activeCallSessions)
        .where(eq(activeCallSessions.twilioCallSid, twilioCallSid));
    }, `deleteByCallSid(${twilioCallSid.slice(-8)})`, DB_RETRY_CONFIG)
      .catch(error => {
        console.error(`[CALL SESSION] DB delete by twilioCallSid failed for ${twilioCallSid}:`, error);
      });
    
    console.info(`[CALL SESSION] Deleted session by twilioCallSid ${twilioCallSid} (conference: ${session.conferenceName})`);
    return session;
  }

  /**
   * Delete session by Conference SID - fallback cleanup when conference name unknown
   */
  async deleteSessionByConferenceSid(conferenceSid: string): Promise<ActiveCallSession | null> {
    // First look up the session to get conference name
    const session = await this.getByConferenceSid(conferenceSid);
    if (!session) {
      console.debug(`[CALL SESSION] No session found for conferenceSid ${conferenceSid}`);
      return null;
    }

    // Remove from cache using conference name
    this.removeFromCache(session.conferenceName);
    
    // Remove from DB with retry
    await withRetry(async () => {
      await db.delete(activeCallSessions)
        .where(eq(activeCallSessions.conferenceSid, conferenceSid));
    }, `deleteByConfSid(${conferenceSid.slice(-8)})`, DB_RETRY_CONFIG)
      .catch(error => {
        console.error(`[CALL SESSION] DB delete by conferenceSid failed for ${conferenceSid}:`, error);
      });
    
    console.info(`[CALL SESSION] Deleted session by conferenceSid ${conferenceSid} (conference: ${session.conferenceName})`);
    return session;
  }

  /**
   * Clean up expired sessions (run periodically)
   */
  async cleanupExpiredSessions(): Promise<number> {
    const now = new Date();
    const result = await db.delete(activeCallSessions)
      .where(
        and(
          lt(activeCallSessions.expiresAt, now),
          or(
            eq(activeCallSessions.state, 'completed'),
            eq(activeCallSessions.state, 'failed'),
            // Also clean up very old sessions regardless of state (1 hour)
            lt(activeCallSessions.createdAt, new Date(now.getTime() - 60 * 60 * 1000))
          )
        )
      )
      .returning();
    
    if (result.length > 0) {
      console.info(`[CALL SESSION] Cleaned up ${result.length} expired sessions`);
    }
    return result.length;
  }

  /**
   * Get all active sessions (for monitoring/debugging)
   */
  async getActiveSessions(): Promise<ActiveCallSession[]> {
    return db.select()
      .from(activeCallSessions)
      .where(
        and(
          or(
            eq(activeCallSessions.state, 'initializing'),
            eq(activeCallSessions.state, 'connected'),
            eq(activeCallSessions.state, 'transferring')
          )
        )
      );
  }

  /**
   * Legacy compatibility: Get conference name from OpenAI call ID
   * (Replaces callIDtoConferenceNameMapping)
   */
  async getConferenceNameByCallId(openaiCallId: string): Promise<string | undefined> {
    const session = await this.getByOpenAICallId(openaiCallId);
    return session?.conferenceName || undefined;
  }

  /**
   * Legacy compatibility: Get caller ID from conference name
   * (Replaces ConferenceNametoCallerIDMapping)
   */
  async getCallerByConferenceName(conferenceName: string): Promise<string | undefined> {
    const session = await this.getByConferenceName(conferenceName);
    return session?.callerNumber || undefined;
  }

  /**
   * Legacy compatibility: Get Twilio CallSid from conference name
   * (Replaces conferenceNameToTwilioCallSid)
   */
  async getTwilioCallSidByConferenceName(conferenceName: string): Promise<string | undefined> {
    const session = await this.getByConferenceName(conferenceName);
    return session?.twilioCallSid || undefined;
  }

  /**
   * Legacy compatibility: Get OpenAI call ID from conference name
   * (Replaces conferenceNameToCallID)
   */
  async getCallIdByConferenceName(conferenceName: string): Promise<string | undefined> {
    const session = await this.getByConferenceName(conferenceName);
    return session?.openaiCallId || undefined;
  }

  /**
   * Legacy compatibility: Get call log ID from conference SID
   * (Replaces conferenceSidToCallLogId)
   */
  async getCallLogIdByConferenceSid(conferenceSid: string): Promise<string | undefined> {
    const session = await this.getByConferenceSid(conferenceSid);
    return session?.callLogId || undefined;
  }

  /**
   * Synchronous lookup for conference name by OpenAI call ID (cache-only, no DB)
   * Use this for performance-critical real-time paths where DB latency is unacceptable
   */
  getConferenceNameByCallIdSync(openaiCallId: string): string | undefined {
    return openaiCallIdIndex.get(openaiCallId);
  }

  /**
   * Synchronous lookup for caller by conference name (cache-only, no DB)
   */
  getCallerByConferenceNameSync(conferenceName: string): string | undefined {
    return sessionCache.get(conferenceName)?.callerNumber || undefined;
  }

  /**
   * Synchronous lookup for Twilio CallSid by conference name (cache-only, no DB)
   */
  getTwilioCallSidByConferenceNameSync(conferenceName: string): string | undefined {
    return sessionCache.get(conferenceName)?.twilioCallSid || undefined;
  }

  /**
   * Synchronous lookup for OpenAI call ID by conference name (cache-only, no DB)
   */
  getCallIdByConferenceNameSync(conferenceName: string): string | undefined {
    return sessionCache.get(conferenceName)?.openaiCallId || undefined;
  }

  /**
   * Synchronous lookup for dialed number by conference name (cache-only, no DB)
   */
  getDialedNumberByConferenceNameSync(conferenceName: string): string | undefined {
    return sessionCache.get(conferenceName)?.calledNumber || undefined;
  }

  /**
   * Synchronous session lookup (cache-only, no DB)
   */
  getByConferenceNameSync(conferenceName: string): ActiveCallSession | undefined {
    return sessionCache.get(conferenceName);
  }

  /**
   * Load active sessions from DB into cache on startup
   * This is critical for surviving server restarts
   */
  async loadActiveSessionsFromDb(): Promise<number> {
    try {
      const sessions = await db.select()
        .from(activeCallSessions)
        .where(
          or(
            eq(activeCallSessions.state, 'initializing'),
            eq(activeCallSessions.state, 'connected'),
            eq(activeCallSessions.state, 'transferring')
          )
        );
      
      for (const session of sessions) {
        this.updateCacheIndexes(session);
      }
      
      console.info(`[CALL SESSION] Loaded ${sessions.length} active sessions from DB on startup`);
      return sessions.length;
    } catch (error) {
      console.error(`[CALL SESSION] Failed to load sessions from DB on startup:`, error);
      return 0;
    }
  }

  /**
   * Get metrics for monitoring
   */
  getMetrics(): { cacheHits: number; cacheMisses: number; dbWriteErrors: number; cachedSessions: number; hitRate: string } {
    const total = cacheHits + cacheMisses;
    const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) + '%' : 'N/A';
    return {
      cacheHits,
      cacheMisses,
      dbWriteErrors,
      cachedSessions: sessionCache.size,
      hitRate,
    };
  }

  /**
   * Reset metrics (for testing/monitoring)
   */
  resetMetrics(): void {
    cacheHits = 0;
    cacheMisses = 0;
    dbWriteErrors = 0;
  }
}

// Singleton instance
export const callSessionService = new CallSessionService();

// Start periodic cleanup (every 5 minutes)
setInterval(async () => {
  try {
    await callSessionService.cleanupExpiredSessions();
    // Log metrics periodically
    const metrics = callSessionService.getMetrics();
    if (metrics.cacheHits + metrics.cacheMisses > 0) {
      console.info(`[CALL SESSION] Metrics: hitRate=${metrics.hitRate}, cached=${metrics.cachedSessions}, errors=${metrics.dbWriteErrors}`);
      callSessionService.resetMetrics();
    }
  } catch (error) {
    console.error('[CALL SESSION] Cleanup error:', error);
  }
}, 5 * 60 * 1000);

// Export initialization function for server startup
export async function initializeCallSessionService(): Promise<void> {
  console.info('[CALL SESSION] Initializing call session service...');
  await callSessionService.loadActiveSessionsFromDb();
  console.info('[CALL SESSION] Call session service initialized');
}
