import { createLogger } from './structuredLogger';

const logger = createLogger('CALL_DIAGNOSTICS');

function isPhiLoggingDisabled(): boolean {
  return process.env.DISABLE_PHI_LOGGING === 'true';
}

export interface CallTrace {
  traceId: string;
  twilioCallSid?: string;
  openaiCallId?: string;
  conferenceSid?: string;
  conferenceName?: string;
  callLogId?: string;
  agentSlug?: string;
  callerPhone?: string;
  dialedNumber?: string;
  stages: CallStage[];
  startTime: number;
  completedAt?: number;
  outcome?: 'success' | 'accept_failed' | 'db_error' | 'timeout' | 'handoff' | 'unknown';
  failureReason?: string;
}

export interface CallStage {
  stage: CallStageName;
  timestamp: number;
  durationMs?: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type CallStageName = 
  | 'twilio_webhook_received'
  | 'ivr_started'
  | 'conference_created'
  | 'sip_participant_added'
  | 'openai_webhook_received'
  | 'agent_routing_started'
  | 'db_get_agent_started'
  | 'db_get_agent_completed'
  | 'db_create_call_log_started'
  | 'db_create_call_log_completed'
  | 'agent_factory_started'
  | 'agent_factory_completed'
  | 'accept_payload_built'
  | 'accept_started'
  | 'accept_attempt'
  | 'accept_completed'
  | 'accept_failed'
  | 'session_connect_started'
  | 'session_connect_failed'
  | 'session_connected'
  | 'first_audio_sent'
  | 'caller_joined_conference'
  | 'call_completed'
  | 'handoff_initiated'
  | 'handoff_completed'
  | 'fallback_to_human'
  | 'timeout_cleanup';

const activeTraces = new Map<string, CallTrace>();
const completedTraces: CallTrace[] = [];
const MAX_ACTIVE_TRACES = 500;
const MAX_COMPLETED_TRACES = 1000;
const SUCCESS_RETENTION_MS = 60 * 60 * 1000;
const FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;
const STALE_TRACE_AGE_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const PHI_METADATA_KEYS = [
  'patientName', 'patient_name', 'name', 'fullName', 'full_name',
  'dob', 'dateOfBirth', 'date_of_birth', 'birthDate', 'birth_date',
  'ssn', 'socialSecurityNumber', 'social_security',
  'address', 'street', 'city', 'state', 'zip', 'zipCode',
  'email', 'emailAddress', 'email_address',
  'phone', 'phoneNumber', 'phone_number', 'callerPhone', 'dialedNumber',
  'mrn', 'medicalRecordNumber', 'medical_record_number',
  'insurance', 'insuranceId', 'insurance_id',
  'provider', 'providerName', 'provider_name', 'doctor', 'physician',
];

function phoneLast4(phone?: string): string {
  if (!phone) return '****';
  if (isPhiLoggingDisabled()) return '[REDACTED]';
  return `***${phone.slice(-4)}`;
}

function sidLast8(sid?: string): string {
  if (!sid) return '********';
  if (isPhiLoggingDisabled()) return '[REDACTED]';
  return `...${sid.slice(-8)}`;
}

function redactCallLogId(callLogId?: string): string {
  if (!callLogId) return '[none]';
  if (isPhiLoggingDisabled()) return '[REDACTED]';
  return callLogId.slice(0, 8) + '...';
}

function redactPhiFromMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();
    if (PHI_METADATA_KEYS.some(phiKey => lowerKey.includes(phiKey.toLowerCase()))) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

let cleanupIntervalHandle: NodeJS.Timeout | null = null;

export class CallDiagnostics {
  static startCleanupTimer(): void {
    if (cleanupIntervalHandle) return;
    
    cleanupIntervalHandle = setInterval(() => {
      this.runCleanup();
    }, CLEANUP_INTERVAL_MS);
    
    logger.info('Cleanup timer started', {
      event: 'cleanup_timer_started',
      intervalMs: CLEANUP_INTERVAL_MS,
    });
  }
  
  static stopCleanupTimer(): void {
    if (cleanupIntervalHandle) {
      clearInterval(cleanupIntervalHandle);
      cleanupIntervalHandle = null;
    }
  }
  
  static runCleanup(): void {
    const staleCount = this.cleanupStaleTraces();
    const completedCount = this.cleanupOldCompletedTraces();
    
    if (staleCount > 0 || completedCount > 0) {
      logger.info('Cleanup completed', {
        event: 'cleanup_run',
        staleTracesRemoved: staleCount,
        completedTracesRemoved: completedCount,
        activeCount: activeTraces.size,
        completedCount: completedTraces.length,
      });
    }
  }
  
  static startTrace(traceId: string, initialData?: Partial<CallTrace>): CallTrace {
    if (activeTraces.size >= MAX_ACTIVE_TRACES) {
      const oldest = Array.from(activeTraces.entries())
        .sort((a, b) => a[1].startTime - b[1].startTime)[0];
      if (oldest) {
        this.completeTrace(oldest[0], 'timeout', 'Evicted due to max active traces');
        logger.warn('Evicted oldest trace due to capacity', {
          event: 'trace_evicted',
          evictedTraceId: oldest[0],
        });
      }
    }
    
    const trace: CallTrace = {
      traceId,
      stages: [],
      startTime: Date.now(),
      ...initialData,
    };
    activeTraces.set(traceId, trace);
    
    logger.info('Call trace started', {
      event: 'trace_started',
      traceId,
      twilioCallSid: sidLast8(initialData?.twilioCallSid),
      callerPhone: phoneLast4(initialData?.callerPhone),
    });
    
    return trace;
  }
  
  static getTrace(traceId: string): CallTrace | undefined {
    return activeTraces.get(traceId);
  }
  
  static getTraceByAnyId(id: string): CallTrace | undefined {
    for (const trace of activeTraces.values()) {
      if (
        trace.traceId === id ||
        trace.twilioCallSid === id ||
        trace.openaiCallId === id ||
        trace.conferenceSid === id ||
        trace.conferenceName === id ||
        trace.callLogId === id
      ) {
        return trace;
      }
    }
    return undefined;
  }
  
  static updateTrace(traceId: string, updates: Partial<CallTrace>): void {
    const trace = activeTraces.get(traceId);
    if (trace) {
      Object.assign(trace, updates);
    }
  }
  
  static addCorrelationId(traceId: string, idType: 'openaiCallId' | 'conferenceSid' | 'conferenceName' | 'callLogId' | 'twilioCallSid', value: string): void {
    const trace = activeTraces.get(traceId);
    if (trace) {
      (trace as any)[idType] = value;
      
      logger.info('Correlation ID added', {
        event: 'correlation_added',
        traceId,
        idType,
        value: idType === 'callLogId' ? redactCallLogId(value) : sidLast8(value),
      });
    }
  }
  
  static recordStage(
    traceId: string, 
    stage: CallStageName, 
    success: boolean, 
    metadata?: Record<string, unknown>,
    error?: string
  ): void {
    const trace = activeTraces.get(traceId);
    if (!trace) {
      logger.warn('Attempted to record stage for unknown trace', {
        event: 'orphan_stage',
        traceId,
        stage,
      });
      return;
    }
    
    const safeMetadata = redactPhiFromMetadata(metadata);
    
    const stageEntry: CallStage = {
      stage,
      timestamp: Date.now(),
      success,
      error,
      metadata: safeMetadata,
    };
    
    const previousStage = trace.stages[trace.stages.length - 1];
    if (previousStage) {
      previousStage.durationMs = stageEntry.timestamp - previousStage.timestamp;
    }
    
    trace.stages.push(stageEntry);
    
    const logContext = {
      event: 'call_stage',
      traceId,
      stage,
      success,
      twilioCallSid: sidLast8(trace.twilioCallSid),
      openaiCallId: isPhiLoggingDisabled() ? '[REDACTED]' : trace.openaiCallId?.slice(-12),
      elapsedMs: stageEntry.timestamp - trace.startTime,
      ...(safeMetadata || {}),
    };
    
    if (success) {
      logger.info(`Stage: ${stage}`, logContext);
    } else {
      logger.error(`Stage FAILED: ${stage}`, { ...logContext, error });
    }
  }
  
  static recordDbOperation(
    traceId: string,
    operation: 'get_agent' | 'create_call_log' | 'get_call_log' | 'update_call_log',
    startTime: number,
    success: boolean,
    error?: string
  ): void {
    const durationMs = Date.now() - startTime;
    
    const logContext = {
      event: 'db_operation',
      traceId,
      operation,
      durationMs,
      success,
      slow: durationMs > 1000,
    };
    
    if (!success) {
      logger.error(`DB operation failed: ${operation}`, { ...logContext, error });
    } else if (durationMs > 1000) {
      logger.warn(`DB operation SLOW: ${operation}`, logContext);
    } else {
      logger.info(`DB operation: ${operation}`, logContext);
    }
  }
  
  static recordAcceptAttempt(
    traceId: string,
    attempt: number,
    maxAttempts: number,
    success: boolean,
    statusCode?: number,
    error?: string
  ): void {
    const trace = activeTraces.get(traceId);
    
    this.recordStage(traceId, 'accept_attempt', success, {
      attempt,
      maxAttempts,
      statusCode,
    }, error);
    
    if (!success && attempt === maxAttempts) {
      this.recordStage(traceId, 'accept_failed', false, {
        totalAttempts: maxAttempts,
        lastStatusCode: statusCode,
      }, error);
      
      if (trace) {
        trace.outcome = 'accept_failed';
        trace.failureReason = error;
      }
    }
  }
  
  static calculateAcceptLatency(traceId: string): number | undefined {
    const trace = activeTraces.get(traceId);
    if (!trace) return undefined;
    
    const webhookStage = trace.stages.find(s => s.stage === 'openai_webhook_received');
    const acceptStage = trace.stages.find(s => s.stage === 'accept_completed' && s.success);
    
    if (webhookStage && acceptStage) {
      return acceptStage.timestamp - webhookStage.timestamp;
    }
    return undefined;
  }
  
  static completeTrace(traceId: string, outcome: CallTrace['outcome'], failureReason?: string): void {
    const trace = activeTraces.get(traceId);
    if (!trace) return;
    
    trace.outcome = outcome;
    trace.failureReason = failureReason;
    trace.completedAt = Date.now();
    
    const totalDurationMs = trace.completedAt - trace.startTime;
    const acceptLatencyMs = this.calculateAcceptLatency(traceId);
    
    const failedStages = trace.stages.filter(s => !s.success);
    const slowDbOps = trace.stages.filter(s => 
      s.stage.startsWith('db_') && s.durationMs && s.durationMs > 1000
    );
    
    logger.info('Call trace completed', {
      event: 'trace_completed',
      traceId,
      outcome,
      failureReason,
      twilioCallSid: sidLast8(trace.twilioCallSid),
      openaiCallId: isPhiLoggingDisabled() ? '[REDACTED]' : trace.openaiCallId?.slice(-12),
      callLogId: redactCallLogId(trace.callLogId),
      agentSlug: trace.agentSlug,
      totalDurationMs,
      acceptLatencyMs,
      stageCount: trace.stages.length,
      failedStageCount: failedStages.length,
      failedStages: failedStages.map(s => s.stage),
      slowDbOpCount: slowDbOps.length,
    });
    
    activeTraces.delete(traceId);
    completedTraces.push(trace);
    
    if (completedTraces.length > MAX_COMPLETED_TRACES) {
      completedTraces.shift();
    }
  }
  
  static getActiveTraceCount(): number {
    return activeTraces.size;
  }
  
  static getCompletedTraceCount(): number {
    return completedTraces.length;
  }
  
  static getDailyStats(): {
    totalCalls: number;
    successfulCalls: number;
    acceptFailures: number;
    dbErrors: number;
    timeouts: number;
    avgAcceptLatencyMs: number;
    p95AcceptLatencyMs: number;
    activeCallsCount: number;
    potentialOrphanCount: number;
    unaccountedCalls: number;
    adjustedFailureRate: string;
  } {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    
    const todaysCompletedTraces = completedTraces.filter(t => t.startTime > oneDayAgo);
    
    const orphanThreshold = now - STALE_TRACE_AGE_MS;
    const potentialOrphans = Array.from(activeTraces.values())
      .filter(t => t.startTime < orphanThreshold);
    
    const acceptLatencies = todaysCompletedTraces
      .map(t => {
        const webhook = t.stages.find(s => s.stage === 'openai_webhook_received');
        const accept = t.stages.find(s => s.stage === 'accept_completed' && s.success);
        return webhook && accept ? accept.timestamp - webhook.timestamp : null;
      })
      .filter((l): l is number => l !== null)
      .sort((a, b) => a - b);
    
    const avgAcceptLatencyMs = acceptLatencies.length > 0
      ? acceptLatencies.reduce((a, b) => a + b, 0) / acceptLatencies.length
      : 0;
    
    const p95Index = acceptLatencies.length > 0 
      ? Math.min(Math.ceil(acceptLatencies.length * 0.95) - 1, acceptLatencies.length - 1)
      : 0;
    const p95AcceptLatencyMs = acceptLatencies[p95Index] || 0;
    
    const completedFailures = todaysCompletedTraces.filter(
      t => t.outcome === 'accept_failed' || t.outcome === 'db_error' || t.outcome === 'timeout'
    ).length;
    const unaccountedCalls = potentialOrphans.length;
    const totalAccountable = todaysCompletedTraces.length + unaccountedCalls;
    const totalFailuresIncludingOrphans = completedFailures + unaccountedCalls;
    const adjustedFailureRate = totalAccountable > 0
      ? ((totalFailuresIncludingOrphans / totalAccountable) * 100).toFixed(2)
      : '0.00';
    
    return {
      totalCalls: todaysCompletedTraces.length,
      successfulCalls: todaysCompletedTraces.filter(t => t.outcome === 'success').length,
      acceptFailures: todaysCompletedTraces.filter(t => t.outcome === 'accept_failed').length,
      dbErrors: todaysCompletedTraces.filter(t => t.outcome === 'db_error').length,
      timeouts: todaysCompletedTraces.filter(t => t.outcome === 'timeout').length,
      avgAcceptLatencyMs: Math.round(avgAcceptLatencyMs),
      p95AcceptLatencyMs: Math.round(p95AcceptLatencyMs),
      activeCallsCount: activeTraces.size,
      potentialOrphanCount: potentialOrphans.length,
      unaccountedCalls,
      adjustedFailureRate: `${adjustedFailureRate}%`,
    };
  }
  
  static getAllActiveTraces(): CallTrace[] {
    return Array.from(activeTraces.values());
  }
  
  static getCompletedTraces(): CallTrace[] {
    return [...completedTraces];
  }
  
  static cleanupStaleTraces(maxAgeMs: number = STALE_TRACE_AGE_MS): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [traceId, trace] of activeTraces.entries()) {
      if (now - trace.startTime > maxAgeMs) {
        this.completeTrace(traceId, 'timeout', 'Stale trace cleanup');
        cleaned++;
      }
    }
    
    return cleaned;
  }
  
  static cleanupOldCompletedTraces(): number {
    const now = Date.now();
    let removed = 0;
    
    const initialLength = completedTraces.length;
    for (let i = completedTraces.length - 1; i >= 0; i--) {
      const trace = completedTraces[i];
      const completedAt = trace.completedAt || trace.startTime;
      const age = now - completedAt;
      
      const retentionMs = trace.outcome === 'success' ? SUCCESS_RETENTION_MS : FAILURE_RETENTION_MS;
      
      if (age > retentionMs) {
        completedTraces.splice(i, 1);
        removed++;
      }
    }
    
    return removed;
  }
}

CallDiagnostics.startCleanupTimer();

export const callDiagnostics = CallDiagnostics;
