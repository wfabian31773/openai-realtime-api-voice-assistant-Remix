import { EventEmitter } from 'events';
import { db } from '../../server/db';
import { callLogs } from '../../shared/schema';
import { eq, sql, and } from 'drizzle-orm';
import { createLogger } from './structuredLogger';
import { getTwilioClient } from '../lib/twilioClient';
import { callSessionService } from './callSessionService';
import { twilioInsightsService } from './twilioInsightsService';

export type CallState = 'initiated' | 'ringing' | 'in_progress' | 'ending' | 'completed' | 'failed';

/**
 * Max call duration by agent type.
 *
 * These are a COST BACKSTOP against orphaned sessions, not a conversation
 * budget. When one fires, Twilio hangs up on whoever is mid-sentence — there
 * is no warning to the caller and no graceful wrap-up.
 *
 * Raised 2026-07-27 after staff reported calls dropping mid-call. Durations
 * were piling up against the old 10-minute ceiling — 601, 601, 601, 602, 602,
 * 602, 602, 605, 609 seconds — and the no-ivr calls cut at 602s all recorded
 * `agent_outcome: inconclusive` with no transfer, i.e. a real caller was
 * dropped with their business unfinished. azul-scheduling averages 272s, so
 * 10 minutes was only ~2x the mean: far too tight for a distribution with a
 * long tail (identity checks, elderly callers, interpreter-paced calls).
 *
 * Note the old per-agent values were not actually taking effect. An
 * answering-service call ran 609s against a nominal 420s cap, which means
 * agentSlug did not reach scheduleMaxDurationTimeout and it fell through to
 * DEFAULT. Every agent was really running on the 10-minute default. Every
 * agent now has an explicit entry and DEFAULT is aligned, so a missing slug
 * degrades to a sane ceiling rather than a surprise one.
 */
const AGENT_MAX_DURATION_MS: Record<string, number> = {
  'appointment-confirmation': 3 * 60 * 1000,  // 3 min — outbound, completes in 60-90s; unchanged
  'after-hours':             15 * 60 * 1000,  // 15 min — triage, can involve on-call escalation
  'answering-service':       15 * 60 * 1000,  // 15 min — was nominally 7, never actually applied
  'no-ivr':                  15 * 60 * 1000,  // 15 min — explicit; previously fell through to DEFAULT
  'azul-scheduling':         20 * 60 * 1000,  // 20 min — identity + search + book, longest tail of any agent
  'pcp':                     15 * 60 * 1000,  // 15 min — professional intake + possible live handoff
};
const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000; // 15 min — unknown/new agents

/**
 * Absolute ceiling for the startup sweep and the DB reconciler, both of which
 * force-terminate calls older than this REGARDLESS of the per-agent cap.
 *
 * Derived rather than hardcoded, because it silently overrides everything
 * above it. It sat at a literal 10 minutes while azul-scheduling was nominally
 * allowed 10 — so the reconciler could cut a call at the exact moment the
 * agent was still entitled to run, and raising the per-agent value alone would
 * have changed nothing. Keeping it a function of the map means the two cannot
 * drift apart again.
 */
const ABSOLUTE_MAX_CALL_DURATION_MS =
  Math.max(DEFAULT_MAX_DURATION_MS, ...Object.values(AGENT_MAX_DURATION_MS)) + 5 * 60 * 1000;

export function getMaxDurationMs(agentSlug?: string): number {
  if (agentSlug && agentSlug in AGENT_MAX_DURATION_MS) {
    return AGENT_MAX_DURATION_MS[agentSlug];
  }
  return DEFAULT_MAX_DURATION_MS;
}

export interface CallRecord {
  callLogId: string;
  twilioCallSid?: string;
  openAiCallId?: string;
  conferenceSid?: string;
  state: CallState;
  startTime: Date;
  lastActivity: Date;
  transcriptLines: string[];
  agentSlug?: string;
  from?: string;
  to?: string;
  transferredToHuman: boolean;
  staleWarningLogged?: boolean; // Only log stale warning once
  firstTranscriptAt?: Date;
  lastTranscriptAt?: Date;
  terminationSignals: {
    twilioStatusCallback?: boolean;
    conferenceEnded?: boolean;
    openAiSessionEnded?: boolean;
    participantLeft?: boolean;
  };
}

const logger = createLogger('CALL_COORDINATOR');

// Buffered termination signal - stored when hangup arrives before call is registered
interface BufferedTerminationSignal {
  type: 'twilio_status' | 'conference_end' | 'participant_left' | 'openai_session_end';
  status?: string;
  label?: string;
  receivedAt: Date;
}

class CallLifecycleCoordinator extends EventEmitter {
  private activeCalls = new Map<string, CallRecord>();
  private callIdMappings = new Map<string, string>(); // Maps various IDs to primary callLogId
  private cleanupTimeouts = new Map<string, NodeJS.Timeout>();
  private pendingMappings = new Map<string, string[]>(); // openAiCallId → [externalIds to map when registered]
  private pendingTranscripts = new Map<string, string[]>(); // externalId → [transcript lines to flush when registered]
  private bufferedTerminations = new Map<string, BufferedTerminationSignal[]>(); // callSid/conferenceSid → buffered termination events
  
  private readonly FORCE_CLEANUP_DELAY_MS = 30000; // 30 seconds after first termination signal
  private readonly OPENAI_ONLY_CLEANUP_DELAY_MS = 10000; // 10 seconds when only OpenAI session-end signal exists
  private readonly STALE_CALL_THRESHOLD_MS = 120000; // 2 minutes without activity = stale
  private readonly DEFAULT_MAX_CALL_DURATION_MS = ABSOLUTE_MAX_CALL_DURATION_MS; // 25 min — must exceed every per-agent cap
  private readonly PENDING_TRANSCRIPT_TIMEOUT_MS = 60000; // Clean up pending transcripts after 60 seconds
  private readonly BUFFERED_TERMINATION_TIMEOUT_MS = 60000; // Buffer termination signals for up to 60 seconds (extended from 30s)
  private maxDurationTimeouts = new Map<string, NodeJS.Timeout>();

  constructor() {
    super();
    this.startStaleCallDetector();
    this.startDatabaseReconciler();
    logger.info('Initialized');
  }

  registerCall(params: {
    callLogId: string;
    twilioCallSid?: string;
    openAiCallId?: string;
    conferenceSid?: string;
    agentSlug?: string;
    from?: string;
    to?: string;
  }): CallRecord {
    const record: CallRecord = {
      callLogId: params.callLogId,
      twilioCallSid: params.twilioCallSid,
      openAiCallId: params.openAiCallId,
      conferenceSid: params.conferenceSid,
      state: 'in_progress',
      startTime: new Date(),
      lastActivity: new Date(),
      transcriptLines: [],
      agentSlug: params.agentSlug,
      from: params.from,
      to: params.to,
      transferredToHuman: false,
      terminationSignals: {},
    };

    this.activeCalls.set(params.callLogId, record);
    
    if (params.twilioCallSid) {
      this.callIdMappings.set(params.twilioCallSid, params.callLogId);
    }
    if (params.openAiCallId) {
      this.callIdMappings.set(params.openAiCallId, params.callLogId);
    }
    if (params.conferenceSid) {
      this.callIdMappings.set(params.conferenceSid, params.callLogId);
    }

    logger.callStarted({
      callId: params.callLogId,
      agentSlug: params.agentSlug,
      callerPhone: params.from,
    });

    // Schedule adaptive max duration timeout based on agent type
    this.scheduleMaxDurationTimeout(params.callLogId, params.twilioCallSid, params.agentSlug);

    // Process any pending mappings that were queued before registration
    if (params.openAiCallId && this.pendingMappings.has(params.openAiCallId)) {
      const pending = this.pendingMappings.get(params.openAiCallId)!;
      logger.debug(`Processing pending mappings`, { callId: params.callLogId, count: pending.length });
      for (const externalId of pending) {
        this.addMapping(externalId, params.callLogId);
      }
      this.pendingMappings.delete(params.openAiCallId);
    }

    // Flush any pending transcripts that arrived before registration
    this.flushPendingTranscripts(params.callLogId, params.openAiCallId, params.twilioCallSid);

    // CRITICAL: Process any buffered termination signals that arrived before registration
    // This handles the race condition where caller hangs up very quickly
    this.processBufferedTerminations(params.callLogId, params.twilioCallSid, params.conferenceSid);

    return record;
  }

  /**
   * Process buffered termination signals that arrived before call registration.
   * This handles fast hangup where Twilio events arrive before registerCall completes.
   */
  private processBufferedTerminations(callLogId: string, twilioCallSid?: string, conferenceSid?: string): void {
    const idsToCheck = [twilioCallSid, conferenceSid].filter(Boolean) as string[];
    
    for (const externalId of idsToCheck) {
      if (this.bufferedTerminations.has(externalId)) {
        const signals = this.bufferedTerminations.get(externalId)!;
        logger.info(`Processing ${signals.length} buffered termination signals`, { 
          callId: callLogId, 
          externalId,
          signals: signals.map(s => s.type) 
        });
        
        const record = this.activeCalls.get(callLogId);
        if (record) {
          for (const signal of signals) {
            switch (signal.type) {
              case 'twilio_status':
                record.terminationSignals.twilioStatusCallback = true;
                break;
              case 'conference_end':
                record.terminationSignals.conferenceEnded = true;
                break;
              case 'participant_left':
                record.terminationSignals.participantLeft = true;
                break;
              case 'openai_session_end':
                record.terminationSignals.openAiSessionEnded = true;
                break;
            }
          }
          
          // Immediately check if we can finalize
          this.checkTermination(callLogId);
        }
        
        this.bufferedTerminations.delete(externalId);
      }
    }
  }

  addMapping(externalId: string, callLogId: string): void {
    this.callIdMappings.set(externalId, callLogId);
    const record = this.activeCalls.get(callLogId);
    if (record) {
      if (externalId.startsWith('rtc_')) {
        record.openAiCallId = externalId;
      } else if (externalId.startsWith('CA')) {
        record.twilioCallSid = externalId;
      } else if (externalId.startsWith('CF')) {
        record.conferenceSid = externalId;
      }
    }
  }

  /**
   * Queue a mapping to be added when the call is registered.
   * This handles the race condition where webhooks arrive before the call is registered.
   * @param openAiCallId The OpenAI call ID that will be used to register the call
   * @param externalId The external ID (Twilio CallSid, conf name, etc.) to map when registered
   */
  queuePendingMapping(openAiCallId: string, externalId: string): void {
    if (!this.pendingMappings.has(openAiCallId)) {
      this.pendingMappings.set(openAiCallId, []);
    }
    this.pendingMappings.get(openAiCallId)!.push(externalId);
    logger.debug(`Queued pending mapping: ${externalId} → ${openAiCallId}`, { openAiCallId, externalId });
  }

  getCallByAnyId(id: string): CallRecord | undefined {
    const callLogId = this.callIdMappings.get(id) || id;
    return this.activeCalls.get(callLogId);
  }

  /** externalId → callLogId resolved straight from the database (see appendViaDbBySid). */
  private dbResolvedTranscriptIds = new Map<string, string>();

  /**
   * Cross-instance fallback: in-memory registration does not survive the
   * OpenAI session landing on a different instance than the Twilio webhook
   * (2026-08-07: command-center live transcripts froze at line 1 — every
   * later line sat in pendingTranscripts for 60s and was dropped). A Twilio
   * CallSid always resolves against call_logs.call_sid, and the append is
   * an atomic SQL concat so two instances can never clobber each other.
   */
  private async appendViaDbBySid(externalId: string, line: string): Promise<boolean> {
    try {
      let resolvedId = this.dbResolvedTranscriptIds.get(externalId);
      if (!resolvedId) {
        const rows = await db
          .select({ id: callLogs.id })
          .from(callLogs)
          .where(eq(callLogs.callSid, externalId))
          .limit(1);
        if (!rows.length) return false;
        resolvedId = rows[0].id;
        if (this.dbResolvedTranscriptIds.size > 2000) this.dbResolvedTranscriptIds.clear();
        this.dbResolvedTranscriptIds.set(externalId, resolvedId);
      }
      await db
        .update(callLogs)
        .set({ transcript: sql`COALESCE(${callLogs.transcript} || E'\n', '') || ${line}` })
        .where(eq(callLogs.id, resolvedId));
      return true;
    } catch (error) {
      logger.error(`DB-fallback transcript append failed`, { externalId, error: String(error) });
      return false;
    }
  }

  async appendTranscript(callLogIdOrExternalId: string, line: string): Promise<void> {
    const callLogId = this.callIdMappings.get(callLogIdOrExternalId) || callLogIdOrExternalId;
    const record = this.activeCalls.get(callLogId);

    if (!record) {
      // A Twilio CallSid resolves via the database even when this instance
      // never registered the call — prefer that over buffer-and-drop.
      if (/^CA[0-9a-fA-F]{32}$/.test(callLogIdOrExternalId)) {
        const appended = await this.appendViaDbBySid(callLogIdOrExternalId, line);
        if (appended) return;
      }
      // Buffer transcript lines that arrive before call is registered
      // This happens when OpenAI sends transcript events before Twilio webhook completes
      if (!this.pendingTranscripts.has(callLogIdOrExternalId)) {
        this.pendingTranscripts.set(callLogIdOrExternalId, []);
        logger.info(`Buffering early transcript for unregistered call`, { externalId: callLogIdOrExternalId });
        
        // Clean up pending transcripts after timeout to prevent memory leaks
        setTimeout(() => {
          if (this.pendingTranscripts.has(callLogIdOrExternalId)) {
            const pending = this.pendingTranscripts.get(callLogIdOrExternalId);
            logger.warn(`Dropping ${pending?.length || 0} buffered transcript lines - call never registered`, { 
              externalId: callLogIdOrExternalId 
            });
            this.pendingTranscripts.delete(callLogIdOrExternalId);
          }
        }, this.PENDING_TRANSCRIPT_TIMEOUT_MS);
      }
      this.pendingTranscripts.get(callLogIdOrExternalId)!.push(line);
      return;
    }

    record.transcriptLines.push(line);
    const now = new Date();
    if (!record.firstTranscriptAt) {
      record.firstTranscriptAt = now;
    }
    record.lastTranscriptAt = now;
    record.lastActivity = new Date();

    try {
      const currentTranscript = record.transcriptLines.join('\n');
      await db
        .update(callLogs)
        .set({ 
          transcript: currentTranscript,
        })
        .where(eq(callLogs.id, callLogId));
      
      if (record.transcriptLines.length % 5 === 0) {
        logger.debug(`Persisted transcript lines`, { callId: callLogId, lines: record.transcriptLines.length });
      }
    } catch (error) {
      logger.error(`Failed to persist transcript`, { callId: callLogId, error: String(error) });
    }
  }

  private async flushPendingTranscripts(
    callLogId: string, 
    openAiCallId?: string, 
    twilioCallSid?: string
  ): Promise<void> {
    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    // Check all possible IDs that might have buffered transcripts
    const idsToCheck = [callLogId, openAiCallId, twilioCallSid].filter(Boolean) as string[];
    
    for (const id of idsToCheck) {
      if (this.pendingTranscripts.has(id)) {
        const bufferedLines = this.pendingTranscripts.get(id)!;
        if (bufferedLines.length > 0) {
          logger.info(`Flushing ${bufferedLines.length} buffered transcript lines`, { 
            callId: callLogId, 
            bufferedFrom: id 
          });
          
          // Add buffered lines to the record
          record.transcriptLines.push(...bufferedLines);
          
          // Persist to database
          try {
            const currentTranscript = record.transcriptLines.join('\n');
            await db
              .update(callLogs)
              .set({ transcript: currentTranscript })
              .where(eq(callLogs.id, callLogId));
          } catch (error) {
            logger.error(`Failed to persist flushed transcript`, { callId: callLogId, error: String(error) });
          }
        }
        this.pendingTranscripts.delete(id);
      }
    }
  }

  handleTwilioStatusCallback(callSid: string, status: string): void {
    let callLogId = this.callIdMappings.get(callSid);
    
    // ENHANCED FALLBACK: If mapping is missing, try direct lookup via callSessionService
    // This handles race conditions where mapping wasn't established before callback arrived
    if (!callLogId) {
      // Try async lookup - fire and forget but also handle synchronously if possible
      this.resolveCallLogIdAndProcess(callSid, status);
      return;
    }
    
    this.processTerminationForCall(callLogId, callSid, status);
  }
  
  /**
   * Attempt to resolve callLogId via callSessionService when mapping is missing.
   * This is an async fallback that tries harder to match termination signals.
   */
  private async resolveCallLogIdAndProcess(callSid: string, status: string): Promise<void> {
    try {
      // Try to find the session by Twilio CallSid
      const session = await callSessionService.getByTwilioCallSid(callSid);
      
      if (session?.callLogId) {
        logger.info(`Resolved callLogId via callSessionService lookup`, {
          twilioCallSid: callSid,
          callLogId: session.callLogId,
          status,
          event: 'fallback_mapping_resolved',
        });
        
        // Add the mapping for future lookups
        this.callIdMappings.set(callSid, session.callLogId);
        
        // Process the termination normally
        this.processTerminationForCall(session.callLogId, callSid, status);
        return;
      }
    } catch (error) {
      logger.error(`Failed to resolve callLogId via fallback lookup`, { 
        twilioCallSid: callSid, 
        error: String(error) 
      });
    }
    
    // Original fallback path: buffer the signal and trigger cleanup
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
      logger.warn(`Twilio termination for unknown call - buffering signal`, { 
        twilioCallSid: callSid, 
        status,
        action: 'buffering_termination'
      });
      this.bufferTerminationSignal(callSid, { type: 'twilio_status', status, receivedAt: new Date() });
      
      // Also trigger fallback cleanup via callSessionService
      this.fallbackCleanupByCallSid(callSid, status);
    } else {
      logger.debug(`Twilio status for unknown call (non-terminal)`, { twilioCallSid: callSid, status });
    }
  }
  
  /**
   * Process a termination signal for a known call.
   * Extracted to allow both direct and resolved paths to use the same logic.
   */
  private processTerminationForCall(callLogId: string, callSid: string, status: string): void {

    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    logger.callStateTransition(callLogId, record.state, status, { twilioCallSid: callSid, event: 'twilio_status' });

    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
      // CRITICAL: Cancel the max duration timeout - Twilio is the source of truth
      // The call has ended via Twilio, so we don't need our safety timeout anymore
      this.cancelMaxDurationTimeout(callLogId);
      
      logger.info(`Twilio confirmed call ended - canceling safety timeout`, {
        callId: callLogId,
        twilioCallSid: callSid,
        twilioStatus: status,
        event: 'twilio_authoritative_termination',
      });
      
      record.terminationSignals.twilioStatusCallback = true;
      this.checkTermination(callLogId);
    }
  }

  /**
   * Buffer a termination signal that arrived before call registration.
   * These signals are processed when registerCall is called with matching IDs.
   */
  private bufferTerminationSignal(externalId: string, signal: BufferedTerminationSignal): void {
    if (!this.bufferedTerminations.has(externalId)) {
      this.bufferedTerminations.set(externalId, []);
      
      // Auto-cleanup after timeout to prevent memory leaks
      setTimeout(() => {
        if (this.bufferedTerminations.has(externalId)) {
          const signals = this.bufferedTerminations.get(externalId);
          logger.warn(`Dropping ${signals?.length || 0} buffered termination signals - call never registered`, { 
            externalId 
          });
          this.bufferedTerminations.delete(externalId);
        }
      }, this.BUFFERED_TERMINATION_TIMEOUT_MS);
    }
    this.bufferedTerminations.get(externalId)!.push(signal);
    logger.debug(`Buffered termination signal`, { externalId, type: signal.type, status: signal.status });
  }

  /**
   * Fallback cleanup when termination arrives for unknown call.
   * Uses callSessionService to find and clean up the session by Twilio CallSid.
   * 
   * SAFETY: Only deletes session if it's not actively established (openaiSessionEstablished=false)
   * to prevent race conditions where session cleanup runs before call fully registers.
   */
  private async fallbackCleanupByCallSid(callSid: string, status: string): Promise<void> {
    try {
      // First check if the session indicates active call - skip cleanup if so
      const session = await callSessionService.getByTwilioCallSid(callSid);
      if (!session) {
        logger.debug(`Fallback cleanup: no session found for CallSid`, { twilioCallSid: callSid });
        return;
      }

      // GUARD: Skip cleanup if session is in any active or progressing state
      // Only proceed with cleanup for terminal states or very old sessions
      const activeStates = ['initializing', 'connecting', 'connected', 'transferring'];
      const sessionAgeMs = session.createdAt ? Date.now() - new Date(session.createdAt).getTime() : 0;
      const SESSION_MIN_AGE_FOR_FALLBACK_MS = 10000; // Only fallback cleanup sessions older than 10s
      const sessionState = session.state || 'unknown';
      
      if (activeStates.includes(sessionState) && sessionAgeMs < SESSION_MIN_AGE_FOR_FALLBACK_MS) {
        logger.info(`Fallback cleanup skipped: session is in active state and too recent`, {
          twilioCallSid: callSid,
          conferenceName: session.conferenceName,
          state: sessionState,
          sessionAgeMs,
          minAgeMs: SESSION_MIN_AGE_FOR_FALLBACK_MS,
        });
        return;
      }

      // Safe to cleanup - session is in terminal state OR old enough that it's likely stale
      await callSessionService.deleteSessionByTwilioCallSid(callSid);
      logger.info(`Fallback cleanup: removed active session by CallSid`, {
        twilioCallSid: callSid,
        conferenceName: session.conferenceName,
        callLogId: session.callLogId,
        status,
        sessionState: session.state,
      });
      
      // Also update the call_logs record if we have a callLogId
      if (session.callLogId) {
        await this.fallbackFinalizeCallLog(session.callLogId, status);
      }
    } catch (error) {
      logger.error(`Fallback cleanup by CallSid failed`, { callSid, error: String(error) });
    }
  }

  /**
   * Fallback finalize call log when we only have the callLogId but no active record.
   * This marks the call as completed in the database.
   * 
   * IDEMPOTENT: Only updates if status is still 'in_progress' to prevent overwriting
   * a call that was already finalized through the normal path.
   */
  private async fallbackFinalizeCallLog(callLogId: string, status: string): Promise<void> {
    const finalStatus = ['completed', 'busy', 'no-answer'].includes(status) ? 'completed' : 'failed';
    try {
      // IDEMPOTENT: Only update if call is still in_progress to avoid overwriting
      // a call that was already finalized through the normal cleanup path
      const result = await db
        .update(callLogs)
        .set({
          status: finalStatus,
          endTime: new Date(),
        })
        .where(
          and(
            eq(callLogs.id, callLogId),
            eq(callLogs.status, 'in_progress')
          )
        )
        .returning({ id: callLogs.id });
      
      if (result.length > 0) {
        logger.info(`Fallback finalized call log`, { callId: callLogId, status: finalStatus });
      } else {
        logger.debug(`Fallback finalize skipped - call already finalized`, { callId: callLogId });
      }
    } catch (error) {
      logger.error(`Fallback call log finalization failed`, { callLogId, error: String(error) });
    }
  }

  handleConferenceEnd(conferenceSid: string): void {
    const callLogId = this.callIdMappings.get(conferenceSid);
    if (!callLogId) {
      logger.warn(`Conference end for unknown conference - attempting fallback cleanup`, { conferenceSid });
      
      // Buffer the termination signal for late registration
      this.bufferTerminationSignal(conferenceSid, { type: 'conference_end', receivedAt: new Date() });
      
      // Trigger fallback cleanup via callSessionService
      this.fallbackCleanupByConferenceSid(conferenceSid);
      return;
    }
    this.handleConferenceEndByCallLogId(callLogId);
  }

  /**
   * Fallback cleanup when conference-end arrives for unknown conference.
   * Uses callSessionService to find and clean up the session by ConferenceSid.
   * 
   * SAFETY: Only deletes session if it's not actively established (openaiSessionEstablished=false)
   * to prevent race conditions where session cleanup runs before call fully registers.
   */
  private async fallbackCleanupByConferenceSid(conferenceSid: string): Promise<void> {
    try {
      // First check if the session indicates active call - skip cleanup if so
      const session = await callSessionService.getByConferenceSid(conferenceSid);
      if (!session) {
        logger.debug(`Fallback cleanup: no session found for ConferenceSid`, { conferenceSid });
        return;
      }

      // GUARD: Skip cleanup if session is in any active or progressing state
      // Only proceed with cleanup for terminal states or very old sessions
      const activeStates = ['initializing', 'connecting', 'connected', 'transferring'];
      const sessionAgeMs = session.createdAt ? Date.now() - new Date(session.createdAt).getTime() : 0;
      const SESSION_MIN_AGE_FOR_FALLBACK_MS = 10000; // Only fallback cleanup sessions older than 10s
      const sessionState = session.state || 'unknown';
      
      if (activeStates.includes(sessionState) && sessionAgeMs < SESSION_MIN_AGE_FOR_FALLBACK_MS) {
        logger.info(`Fallback cleanup skipped: session is in active state and too recent`, {
          conferenceSid,
          conferenceName: session.conferenceName,
          state: sessionState,
          sessionAgeMs,
          minAgeMs: SESSION_MIN_AGE_FOR_FALLBACK_MS,
        });
        return;
      }

      // Safe to cleanup - session is in terminal state OR old enough that it's likely stale
      await callSessionService.deleteSessionByConferenceSid(conferenceSid);
      logger.info(`Fallback cleanup: removed active session by ConferenceSid`, {
        conferenceSid,
        conferenceName: session.conferenceName,
        callLogId: session.callLogId,
        sessionState: session.state,
      });
      
      // Also update the call_logs record if we have a callLogId
      if (session.callLogId) {
        await this.fallbackFinalizeCallLog(session.callLogId, 'completed');
      }
    } catch (error) {
      logger.error(`Fallback cleanup by ConferenceSid failed`, { conferenceSid, error: String(error) });
    }
  }

  handleConferenceEndByCallLogId(callLogId: string): void {
    const record = this.activeCalls.get(callLogId);
    if (!record) {
      logger.warn(`Conference end - call not found`, { callId: callLogId });
      return;
    }

    logger.callStateTransition(callLogId, record.state, 'conference_ended', { event: 'conference_ended' });
    record.terminationSignals.conferenceEnded = true;
    this.checkTermination(callLogId);
  }

  handleParticipantLeft(identifier: string, label?: string): void {
    const callLogId = this.callIdMappings.get(identifier);
    if (!callLogId) return;
    this.handleParticipantLeftByCallLogId(callLogId, label);
  }

  handleParticipantLeftByCallLogId(callLogId: string, label?: string): void {
    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    if (label === 'customer') {
      logger.callStateTransition(callLogId, record.state, 'customer_left', { event: 'participant_left', label });
      record.terminationSignals.participantLeft = true;
      this.checkTermination(callLogId);
    }
  }

  handleOpenAiSessionEnded(openAiCallId: string): void {
    const callLogId = this.callIdMappings.get(openAiCallId);
    if (!callLogId) {
      logger.warn(`OpenAI session ended for unknown call`, { openAiCallId });
      return;
    }

    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    logger.callStateTransition(callLogId, record.state, 'openai_session_ended', { event: 'openai_ended' });
    record.terminationSignals.openAiSessionEnded = true;
    this.checkTermination(callLogId);
  }

  private checkTermination(callLogId: string): void {
    const record = this.activeCalls.get(callLogId);
    if (!record || record.state === 'completed' || record.state === 'failed') return;

    const signals = record.terminationSignals;
    const signalCount = Object.values(signals).filter(Boolean).length;

    logger.debug(`Termination check`, {
      callId: callLogId,
      signalCount,
      currentState: record.state,
      twilioCallback: signals.twilioStatusCallback,
      conferenceEnded: signals.conferenceEnded,
      openAiEnded: signals.openAiSessionEnded,
      participantLeft: signals.participantLeft,
    });

    if (signalCount >= 2 || signals.twilioStatusCallback) {
      logger.info(`Sufficient termination signals - finalizing call`, { callId: callLogId, signalCount });
      this.finalizeCall(callLogId, 'completed');
    } else if (signalCount >= 1 && !this.cleanupTimeouts.has(callLogId)) {
      const cleanupDelayMs = signals.openAiSessionEnded && signalCount === 1
        ? this.OPENAI_ONLY_CLEANUP_DELAY_MS
        : this.FORCE_CLEANUP_DELAY_MS;
      logger.debug(`First termination signal - scheduling forced cleanup`, { 
        callId: callLogId, 
        delayMs: cleanupDelayMs 
      });
      const timeout = setTimeout(() => {
        const currentRecord = this.activeCalls.get(callLogId);
        if (currentRecord && currentRecord.state !== 'completed' && currentRecord.state !== 'failed') {
          logger.warn(`Forced cleanup triggered`, { callId: callLogId });
          this.finalizeCall(callLogId, 'completed');
        }
      }, cleanupDelayMs);
      this.cleanupTimeouts.set(callLogId, timeout);
    }
  }

  async finalizeCall(callLogId: string, finalStatus: 'completed' | 'failed'): Promise<void> {
    // CRITICAL: Cancel the max duration timeout to prevent duplicate processing
    // This ensures Twilio remains the source of truth
    this.cancelMaxDurationTimeout(callLogId);
    
    const record = this.activeCalls.get(callLogId);
    if (!record) {
      logger.warn(`Cannot finalize - call not found`, { callId: callLogId });
      return;
    }

    if (record.state === 'completed' || record.state === 'failed') {
      logger.debug(`Call already finalized`, { callId: callLogId, state: record.state });
      return;
    }

    record.state = finalStatus === 'completed' ? 'completed' : 'failed';
    const endTime = new Date();
    const localDuration = Math.floor((endTime.getTime() - record.startTime.getTime()) / 1000);

    logger.callEnded({
      callId: callLogId,
      duration: localDuration,
      endReason: finalStatus,
    });

    try {
      const transcript = record.transcriptLines.join('\n');
      
      /**
       * ALWAYS WRITE OUR OWN MEASURED DURATION — corrected 2026-08-14.
       *
       * This used to defer entirely to Twilio whenever a callSid existed
       * (`record.twilioCallSid ? undefined : localDuration`), on the
       * reasonable assumption that Twilio knows how long its own call was.
       *
       * For conference calls it does not. The operator pulled
       * CA04e33c56cfe458d6b26070ceee675aba in the Twilio console:
       *
       *     Status     No Answer
       *     Duration   0 sec
       *     Start/End  18:11:29 / 18:11:29   (identical)
       *     Stir/Shaken  Failed-C-Diverted
       *
       * That call carried FIVE conversational turns. Its TwiML is
       * `<Dial><Conference>conf_CA04e33c…</Conference></Dial>` — the
       * conversation happens inside the conference, and on a diverted
       * (Nextiva-forwarded) leg Twilio can finalise the parent call resource
       * as no-answer/0 while the media session ran normally.
       *
       * 45 of 534 after-hours calls in 7 days (8.4%) landed this way: 0-3
       * second durations on calls with 5-12 turns. Everything downstream
       * reads that column — cost per minute, the graders, the dashboard.
       *
       * localDuration is measured from OUR start to OUR finalize, so it is
       * always a real number for a real conversation. Twilio reconciliation
       * still runs afterwards and may refine it; it just may no longer
       * replace a measured conversation with a zero.
       */
      /**
       * THE TWO GRADERS THAT HAVE NEVER ONCE PRODUCED A SIGNAL.
       *
       * `gradeLatency` reads firstTranscriptDelayMs and `gradeTailSafety` reads
       * postTranscriptTailMs. Both columns were NULL on all 2,203 calls in the
       * fleet — every agent, since the day the columns were added — so both
       * graders returned "No … data available" and scored 0.5, forever. Two of
       * fifteen checks pinned at half marks is a flat ~6.7% off the rubric of
       * every call we have ever scored, and it is nobody's agent behaviour.
       *
       * The values were never missing. They were computed immediately below
       * this, in SECONDS, for a log message, and thrown away. All that was
       * missing was the write.
       *
       * MILLISECONDS, because that is the unit the graders' thresholds are in
       * (<=2000 excellent, <=4000 acceptable). Writing the log line's seconds
       * would have scored every call in the fleet as instant — a worse lie than
       * the missing data, because it looks like a measurement.
       */
      const firstTranscriptDelayMs = record.firstTranscriptAt
        ? Math.max(0, record.firstTranscriptAt.getTime() - record.startTime.getTime())
        : null;
      const postTranscriptTailMs = record.lastTranscriptAt
        ? Math.max(0, endTime.getTime() - record.lastTranscriptAt.getTime())
        : null;
      const transcriptWindowSeconds = record.firstTranscriptAt && record.lastTranscriptAt
        ? Math.max(0, Math.floor((record.lastTranscriptAt.getTime() - record.firstTranscriptAt.getTime()) / 1000))
        : null;

      const updateData: Record<string, any> = {
          status: finalStatus,
          endTime,
          duration: localDuration,
          localDurationSeconds: localDuration,
          transcript: transcript || null,
          firstTranscriptDelayMs,
          postTranscriptTailMs,
          transcriptWindowSeconds,
      };
      
      if (record.transferredToHuman) {
        updateData.transferredToHuman = true;
      }
      
      await db
        .update(callLogs)
        .set(updateData)
        .where(eq(callLogs.id, callLogId));

      logger.info(`Call finalized in database`, { 
        callId: callLogId, 
        duration: localDuration, 
        transcriptLines: record.transcriptLines.length,
        firstTranscriptDelaySec: record.firstTranscriptAt
          ? Math.max(0, Math.floor((record.firstTranscriptAt.getTime() - record.startTime.getTime()) / 1000))
          : null,
        transcriptWindowSec: record.firstTranscriptAt && record.lastTranscriptAt
          ? Math.max(0, Math.floor((record.lastTranscriptAt.getTime() - record.firstTranscriptAt.getTime()) / 1000))
          : null,
        postTranscriptTailSec: record.lastTranscriptAt
          ? Math.max(0, Math.floor((endTime.getTime() - record.lastTranscriptAt.getTime()) / 1000))
          : null,
        transferred: record.transferredToHuman,
      });

      this.emit('call-ended', {
        callLogId,
        status: finalStatus,
        duration: localDuration,
        transcript,
        twilioCallSid: record.twilioCallSid,
        transferredToHuman: record.transferredToHuman,
      });

      // CRITICAL: Fetch Twilio Insights immediately after call ends
      // This gets carrier info, who hung up, cost, and other Twilio data
      // We delay 10 seconds to give Twilio time to process the insights
      if (record.twilioCallSid) {
        const callSid = record.twilioCallSid;
        const callId = callLogId;
        setTimeout(async () => {
          try {
            logger.info(`Fetching Twilio Insights for completed call`, { callId, twilioCallSid: callSid });
            const success = await twilioInsightsService.fetchAndSaveInsights(callId, callSid);
            if (success) {
              logger.info(`Twilio Insights saved for call`, { callId, twilioCallSid: callSid });
            } else {
              logger.warn(`Failed to fetch Twilio Insights - will be retried by backfill job`, { callId });
            }
          } catch (error) {
            logger.error(`Error fetching Twilio Insights`, { callId, error: String(error) });
          }
        }, 10000); // 10 second delay for Twilio to process
      }

      // TICKET CREATION VERIFICATION
      // Check if non-escalated calls with sufficient duration have tickets
      // This catches cases where the AI said "submitted" without calling create_ticket
      if (!record.transferredToHuman && finalStatus === 'completed') {
        const callId = callLogId;
        setTimeout(async () => {
          try {
            const [callRecord] = await db
              .select({ ticketNumber: callLogs.ticketNumber, agentUsed: callLogs.agentUsed, duration: callLogs.duration })
              .from(callLogs)
              .where(eq(callLogs.id, callId))
              .limit(1);

            const finalizedDuration = Number(callRecord?.duration || 0);
            
            // Only warn for no-ivr agent calls (the main inbound agent)
            if (callRecord && callRecord.agentUsed === 'no-ivr' && !callRecord.ticketNumber && finalizedDuration >= 45) {
              logger.warn(`[MISSING TICKET] Call completed without ticket creation - patient request may be lost`, {
                callId,
                duration: finalizedDuration,
                agentUsed: callRecord.agentUsed,
                event: 'missing_ticket_warning',
              });
            }
          } catch (verifyError) {
            logger.debug(`Failed to verify ticket creation`, { callId, error: String(verifyError) });
          }
        }, 5000); // Check 5 seconds after finalization
      }

      // Delete the active call session from the database
      // This is critical to prevent stale sessions from persisting
      for (const [key, value] of this.callIdMappings.entries()) {
        if (value === callLogId && key.startsWith('conf_')) {
          try {
            await callSessionService.deleteSession(key);
            logger.info(`Deleted active call session`, { conferenceName: key, callId: callLogId });
          } catch (sessionError) {
            logger.warn(`Failed to delete call session`, { conferenceName: key, error: String(sessionError) });
          }
          break;
        }
      }

    } catch (error) {
      logger.error(`Failed to finalize call`, { callId: callLogId, error: String(error) });
    }

    const timeout = this.cleanupTimeouts.get(callLogId);
    if (timeout) {
      clearTimeout(timeout);
      this.cleanupTimeouts.delete(callLogId);
    }

    setTimeout(() => {
      this.activeCalls.delete(callLogId);
      for (const [key, value] of this.callIdMappings.entries()) {
        if (value === callLogId) {
          this.callIdMappings.delete(key);
        }
      }
      logger.debug(`Cleaned up call from memory`, { callId: callLogId });
    }, 60000);
  }

  markTransferred(callLogIdOrExternalId: string): void {
    const callLogId = this.callIdMappings.get(callLogIdOrExternalId) || callLogIdOrExternalId;
    const record = this.activeCalls.get(callLogId);
    if (record) {
      record.transferredToHuman = true;
      logger.handoffCompleted({ callId: callLogId, success: true });
      return;
    }
    // A miss used to be silent, which made it invisible that a bridged call
    // was still holding a live duration cap. The consequence lands ~20
    // minutes later as a call cut off mid-conversation, with nothing in the
    // logs connecting the two.
    logger.warn(`markTransferred found no active call — duration cap NOT released`, {
      callId: callLogIdOrExternalId,
      resolvedTo: callLogId,
      event: 'mark_transferred_miss',
    });
  }

  private scheduleMaxDurationTimeout(callLogId: string, twilioCallSid?: string, agentSlug?: string): void {
    // Clear any existing timeout for this call
    const existingTimeout = this.maxDurationTimeouts.get(callLogId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const maxDurationMs = getMaxDurationMs(agentSlug);

    const timeout = setTimeout(async () => {
      const record = this.activeCalls.get(callLogId);

      // A STALE LOCAL RECORD IS NOT EVIDENCE THE CALL ENDED.
      //
      // This used to return here whenever the record was missing or not
      // 'in_progress', on the assumption that our bookkeeping knew. It does
      // not: cancelMaxDurationTimeout() clears this timer on every clean
      // finalize, so the timer FIRING AT ALL means we never saw the call end.
      // Giving up at that exact moment is giving up on the only calls that
      // need it.
      //
      // 2026-08-03/04: eight answering-service calls ran past their 15-minute
      // cap. The longest was 11,584s — three hours and sixteen minutes — with
      // five conversational turns on it. The line sat open, billing, long
      // after anyone stopped talking. Twilio still had the call up the whole
      // time; only our record had gone stale.
      //
      // So: no record, or a record in an unexpected state, and we hold a
      // CallSid → still ask Twilio to end it. Terminating an already-finished
      // call is a no-op; leaving a live one up costs hours.
      if (!record || record.state !== 'in_progress') {
        const orphanSid = record?.twilioCallSid || twilioCallSid;
        if (orphanSid) {
          logger.warn(
            `Max duration reached with no live local record — asking Twilio to end it anyway`,
            { callId: callLogId, twilioCallSid: orphanSid, agentSlug, state: record?.state ?? 'no_record',
              event: 'max_duration_orphan' },
          );
          try {
            const client = await getTwilioClient();
            await client.calls(orphanSid).update({ status: 'completed' });
          } catch (error) {
            // Already finished is the expected case and not worth an error.
            logger.info(`Orphan termination returned an error (call likely already ended)`, {
              callId: callLogId, twilioCallSid: orphanSid, error: String(error),
            });
          }
        }
        this.maxDurationTimeouts.delete(callLogId);
        return;
      }

      // Skip if transferred to human - let human handle call duration
      if (record.transferredToHuman) {
        logger.info(`Max duration timeout skipped - call transferred to human`, { callId: callLogId });
        this.maxDurationTimeouts.delete(callLogId);
        return;
      }

      const callSid = record.twilioCallSid || twilioCallSid;
      const maxMinutes = Math.round(maxDurationMs / 60000);
      logger.warn(`REQUESTING Twilio to terminate call - exceeded ${maxMinutes} minute maximum duration`, {
        callId: callLogId,
        twilioCallSid: callSid,
        agentSlug,
        durationSeconds: Math.floor((Date.now() - record.startTime.getTime()) / 1000),
        event: 'max_duration_exceeded',
      });

      // Request Twilio to terminate the call - Twilio's callback will handle finalization
      // This keeps Twilio as the source of truth
      if (callSid) {
        try {
          const client = await getTwilioClient();
          await client.calls(callSid).update({ status: 'completed' });
          logger.info(`Requested Twilio to terminate long-running call - awaiting callback`, {
            callId: callLogId,
            twilioCallSid: callSid,
          });
          // DO NOT finalize here - wait for Twilio's status callback
          // Twilio will send a 'completed' status which triggers handleTwilioStatusCallback
        } catch (error) {
          logger.error(`Failed to request Twilio termination - forcing local cleanup`, {
            callId: callLogId,
            twilioCallSid: callSid,
            error: String(error),
          });
          // Only force finalize if Twilio API fails - this is our last resort
          this.finalizeCall(callLogId, 'failed');
        }
      } else {
        // No Twilio CallSid - we have to finalize locally
        logger.warn(`No Twilio CallSid - forcing local cleanup`, { callId: callLogId });
        this.finalizeCall(callLogId, 'completed');
      }
      
      this.maxDurationTimeouts.delete(callLogId);
    }, maxDurationMs);

    this.maxDurationTimeouts.set(callLogId, timeout);
    logger.debug(`Scheduled ${Math.round(maxDurationMs / 60000)}-minute max duration timeout`, { callId: callLogId, agentSlug });
  }

  cancelMaxDurationTimeout(callLogId: string): void {
    const timeout = this.maxDurationTimeouts.get(callLogId);
    if (timeout) {
      clearTimeout(timeout);
      this.maxDurationTimeouts.delete(callLogId);
    }
  }

  async forceTerminateLongRunningCalls(): Promise<number> {
    let terminated = 0;
    const now = Date.now();
    
    for (const [callLogId, record] of this.activeCalls.entries()) {
      if (record.state !== 'in_progress') continue;
      if (record.transferredToHuman) continue;
      
      const durationMs = now - record.startTime.getTime();
      if (durationMs > this.DEFAULT_MAX_CALL_DURATION_MS) {
        const callSid = record.twilioCallSid;
        logger.warn(`Force terminating long-running call on startup`, {
          callId: callLogId,
          twilioCallSid: callSid,
          durationMinutes: Math.floor(durationMs / 60000),
        });

        if (callSid) {
          try {
            const client = await getTwilioClient();
            await client.calls(callSid).update({ status: 'completed' });
            terminated++;
          } catch (error) {
            logger.error(`Failed to terminate call`, { callId: callLogId, error: String(error) });
          }
        }
        
        this.finalizeCall(callLogId, 'completed');
      }
    }
    
    return terminated;
  }

  private startStaleCallDetector(): void {
    setInterval(async () => {
      const now = Date.now();
      for (const [callLogId, record] of this.activeCalls.entries()) {
        if (record.state !== 'in_progress') continue;
        if (record.transferredToHuman) continue; // Don't flag transferred calls as stale
        
        const inactiveMs = now - record.lastActivity.getTime();
        if (inactiveMs > this.STALE_CALL_THRESHOLD_MS) {
          // Only log warning once
          if (!record.staleWarningLogged) {
            record.staleWarningLogged = true;
            logger.warn(`Stale call detected - checking Twilio status`, { 
              callId: callLogId, 
              inactiveSeconds: Math.floor(inactiveMs / 1000),
              twilioCallSid: record.twilioCallSid,
              event: 'stale_call',
            });
            this.emit('stale-call', { callLogId, inactiveSeconds: Math.floor(inactiveMs / 1000) });
          }
          
          // CRITICAL: Query Twilio as authoritative source for call status
          // This ensures stale calls are properly cleaned up even if webhooks fail
          if (record.twilioCallSid) {
            try {
              const client = await getTwilioClient();
              const twilioCall = await client.calls(record.twilioCallSid).fetch();
              const twilioStatus = twilioCall.status;
              
              logger.info(`Twilio status check for stale call`, {
                callId: callLogId,
                twilioCallSid: record.twilioCallSid,
                twilioStatus,
              });
              
              // If Twilio confirms call is finished, finalize it
              if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(twilioStatus)) {
                logger.info(`Twilio confirms call ended - cleaning up stale call`, {
                  callId: callLogId,
                  twilioCallSid: record.twilioCallSid,
                  twilioStatus,
                });
                record.terminationSignals.twilioStatusCallback = true;
                this.finalizeCall(callLogId, twilioStatus === 'completed' ? 'completed' : 'failed');
              }
            } catch (error) {
              logger.error(`Failed to check Twilio status for stale call`, {
                callId: callLogId,
                twilioCallSid: record.twilioCallSid,
                error: String(error),
              });
            }
          } else {
            // No Twilio CallSid - force cleanup after extended stale period (5 minutes)
            const extendedStaleMs = 5 * 60 * 1000;
            if (inactiveMs > extendedStaleMs) {
              logger.warn(`Force cleaning stale call without Twilio CallSid`, {
                callId: callLogId,
                inactiveSeconds: Math.floor(inactiveMs / 1000),
              });
              this.finalizeCall(callLogId, 'failed');
            }
          }
        }
      }
    }, 30000);
  }

  /**
   * Database reconciler - catches zombie calls not tracked in memory
   * Runs every 60 seconds to find calls stuck in 'in_progress' that:
   * 1. Aren't tracked in the in-memory activeCalls map
   * 2. Have been running for more than 5 minutes
   * Uses Twilio as source of truth and force-terminates stale calls
   */
  private startDatabaseReconciler(): void {
    const DB_RECONCILE_INTERVAL_MS = 60000; // 1 minute
    const DB_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    setInterval(async () => {
      try {
        const staleThreshold = new Date(Date.now() - DB_STALE_THRESHOLD_MS);
        
        // Query for calls stuck in transient states that aren't in memory
        const { and, or, lt, isNotNull, inArray } = await import('drizzle-orm');
        const staleCalls = await db
          .select({
            id: callLogs.id,
            callSid: callLogs.callSid,
            status: callLogs.status,
            createdAt: callLogs.createdAt,
          })
          .from(callLogs)
          .where(
            and(
              or(
                eq(callLogs.status, 'in_progress'),
                eq(callLogs.status, 'ringing'),
                eq(callLogs.status, 'initiated')
              ),
              lt(callLogs.createdAt, staleThreshold),
              isNotNull(callLogs.callSid)
            )
          )
          .limit(10);

        if (staleCalls.length === 0) return;

        logger.info(`Database reconciler found ${staleCalls.length} stale calls to check`);

        const client = await getTwilioClient();

        for (const call of staleCalls) {
          // Skip if already tracked in memory (handled by staleCallDetector)
          if (this.activeCalls.has(call.id)) continue;

          try {
            const twilioCall = await client.calls(call.callSid!).fetch();
            const twilioStatus = twilioCall.status;
            const duration = twilioCall.duration ? parseInt(twilioCall.duration) : null;

            logger.info(`DB reconciler: Twilio status for zombie call`, {
              callId: call.id,
              callSid: call.callSid,
              dbStatus: call.status,
              twilioStatus,
              twilioConfirmedDuration: duration,
            });

            // If Twilio says call is finished, update DB
            if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(twilioStatus)) {
              const finalStatus = twilioStatus === 'completed' ? 'completed' : 
                                  twilioStatus === 'busy' ? 'busy' :
                                  twilioStatus === 'no-answer' ? 'no_answer' : 'failed';

              await db.update(callLogs).set({
                status: finalStatus,
                duration: duration ?? undefined,
                endTime: new Date(),
              }).where(eq(callLogs.id, call.id));

              logger.info(`DB reconciler: Fixed zombie call`, {
                callId: call.id,
                oldStatus: call.status,
                newStatus: finalStatus,
                duration: duration ?? undefined,
              });

              // Fetch Twilio insights for this call
              await twilioInsightsService.fetchAndSaveInsights(call.id, call.callSid!);
            } else if (twilioStatus === 'in-progress') {
              // Still active in Twilio - force terminate it
              const createdAt = call.createdAt ? new Date(call.createdAt) : new Date();
              const callAge = Date.now() - createdAt.getTime();
              if (callAge > this.DEFAULT_MAX_CALL_DURATION_MS) {
                logger.warn(`DB reconciler: Force terminating long-running call`, {
                  callId: call.id,
                  callSid: call.callSid,
                  ageMinutes: Math.floor(callAge / 60000),
                });

                try {
                  await client.calls(call.callSid!).update({ status: 'completed' });
                  
                  await db.update(callLogs).set({
                    status: 'completed',
                    endTime: new Date(),
                  }).where(eq(callLogs.id, call.id));

                  logger.info(`DB reconciler: Force terminated and updated`, { callId: call.id });
                } catch (terminateError) {
                  logger.error(`DB reconciler: Failed to force terminate`, {
                    callId: call.id,
                    error: String(terminateError),
                  });
                }
              }
            }
          } catch (error) {
            logger.error(`DB reconciler: Failed to check Twilio for call`, {
              callId: call.id,
              callSid: call.callSid,
              error: String(error),
            });
          }
        }
      } catch (error) {
        logger.error(`DB reconciler failed`, { error: String(error) });
      }
    }, DB_RECONCILE_INTERVAL_MS);
  }

  getActiveCallCount(): number {
    return Array.from(this.activeCalls.values()).filter(c => c.state === 'in_progress').length;
  }

  getActiveCallSummary(): Array<{
    callLogId: string;
    state: CallState;
    agent: string | undefined;
    duration: number;
    transcriptLines: number;
    lastActivity: Date;
  }> {
    const now = Date.now();
    return Array.from(this.activeCalls.values())
      .filter(c => c.state === 'in_progress')
      .map(c => ({
        callLogId: c.callLogId,
        state: c.state,
        agent: c.agentSlug,
        duration: Math.floor((now - c.startTime.getTime()) / 1000),
        transcriptLines: c.transcriptLines.length,
        lastActivity: c.lastActivity,
      }));
  }
}

export const callLifecycleCoordinator = new CallLifecycleCoordinator();
