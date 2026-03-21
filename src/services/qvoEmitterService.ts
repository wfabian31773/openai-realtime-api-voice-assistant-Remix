/**
 * QVO Emitter Service
 *
 * Fire-and-forget bridge that sends call and ticket events to a QVO ingest API.
 * This service has zero impact on the voice agent system:
 *   • No-ops silently when QVO_INGEST_URL / QVO_API_KEY / QVO_TENANT_ID are absent
 *   • Circuit breaker prevents hammering a down QVO server
 *   • All sends are fire-and-forget — failures never propagate to callers
 */

import { storage } from '../../server/storage';
import type { SyncAgentTicketParams } from './syncAgentService';

const QVO_INGEST_URL = process.env.QVO_INGEST_URL?.replace(/\/$/, '');
const QVO_API_KEY   = process.env.QVO_API_KEY;
const QVO_TENANT_ID = process.env.QVO_TENANT_ID;

const MAX_RETRIES      = 3;
const RETRY_BASE_MS    = 1_000;
const FETCH_TIMEOUT_MS = 10_000;

// ── Circuit breaker (in-memory) ───────────────────────────────────────────────
const BREAKER_THRESHOLD   = 5;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1_000; // 5 minutes

let _failureCount    = 0;
let _lastFailureTime = 0;

function breakerIsOpen(): boolean {
  return _failureCount >= BREAKER_THRESHOLD
    && Date.now() - _lastFailureTime < BREAKER_COOLDOWN_MS;
}
function onSuccess()  { _failureCount = 0; }
function onFailure()  { _failureCount++; _lastFailureTime = Date.now(); }

// ── Config check ─────────────────────────────────────────────────────────────
function isConfigured(): boolean {
  return !!(QVO_INGEST_URL && QVO_API_KEY && QVO_TENANT_ID);
}

// ── HTTP helper with retry ────────────────────────────────────────────────────
async function postWithRetry(path: string, body: object): Promise<void> {
  const url = `${QVO_INGEST_URL}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${QVO_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.status === 201 || res.status === 409) {
        // 201 = created, 409 = duplicate idempotency key (both are safe outcomes)
        onSuccess();
        return;
      }

      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[QVO EMITTER] Attempt ${attempt + 1}/${MAX_RETRIES} failed (${url}):`, lastError.message);
    }
  }

  onFailure();
  console.error(`[QVO EMITTER] All ${MAX_RETRIES} retries exhausted for ${url}:`, lastError?.message);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Emit a call.completed event to QVO.
 * Should be called ~20 seconds after the call ends so costs & grading are settled.
 * Completely fire-and-forget — never throws.
 */
async function emitCallCompleted(callLogId: string): Promise<void> {
  if (!isConfigured() || breakerIsOpen()) {
    if (breakerIsOpen()) {
      console.warn(`[QVO EMITTER] Circuit breaker open — skipping call event ${callLogId}`);
    }
    return;
  }

  let callLog: Awaited<ReturnType<typeof storage.getCallLog>>;
  try {
    callLog = await storage.getCallLog(callLogId);
  } catch (err) {
    console.error(`[QVO EMITTER] Failed to load call log ${callLogId}:`, err);
    return;
  }

  if (!callLog) {
    console.warn(`[QVO EMITTER] Call log not found: ${callLogId}`);
    return;
  }

  const payload: Record<string, unknown> = {
    version:          'v1',
    event_type:       'call.completed',
    timestamp:        new Date().toISOString(),
    idempotency_key:  `remix-call-${callLogId}`,
    tenant_id:        QVO_TENANT_ID,
    agent_remote_id:  callLog.agentUsed || 'unknown',

    // Call identifiers
    external_id:  callLogId,
    twilio_sid:   callLog.callSid || '',
    direction:    callLog.direction,
    from_number:  callLog.from,
    to_number:    callLog.to,
    status:       callLog.twilioStatus || callLog.status || 'completed',
    start_time:   callLog.startTime?.toISOString()  ?? new Date().toISOString(),
    end_time:     callLog.endTime?.toISOString()    ?? new Date().toISOString(),
    duration_seconds: callLog.duration ?? 0,

    // Transfer
    transferred_to_human: callLog.transferredToHuman ?? false,
    ...(callLog.transferredToHuman ? { escalation_reason: 'human_handoff' } : {}),

    // Content
    transcript:    callLog.transcript    ?? '',
    ...(callLog.summary      ? { summary:       callLog.summary }       : {}),
    ...(callLog.recordingUrl ? { recording_url: callLog.recordingUrl }  : {}),

    // Costs (all in cents)
    costs: {
      twilio_cents:  callLog.twilioCostCents  ?? 0,
      openai_cents:  callLog.openaiCostCents  ?? 0,
      total_cents:   callLog.totalCostCents   ?? 0,
      is_estimated:  callLog.costIsEstimated  !== false, // default true until reconciled
    },
  };

  // Token usage (only present when realtime telemetry was captured)
  if (callLog.inputAudioTokens != null || callLog.outputAudioTokens != null) {
    payload.tokens = {
      input_audio:  callLog.inputAudioTokens  ?? 0,
      output_audio: callLog.outputAudioTokens ?? 0,
      input_text:   callLog.inputTextTokens   ?? 0,
      output_text:  callLog.outputTextTokens  ?? 0,
    };
  }

  // Quality (only present when grading ran)
  if (callLog.sentiment || callLog.agentOutcome || callLog.qualityScore != null) {
    payload.quality = {
      ...(callLog.sentiment    ? { sentiment:    callLog.sentiment }                   : {}),
      ...(callLog.agentOutcome ? { agent_outcome: callLog.agentOutcome }               : {}),
      ...(callLog.qualityScore != null
        ? { score: callLog.qualityScore * 2 }  // our 1-5 → QVO's 0-10 scale
        : {}),
      ...(callLog.qualityAnalysis
        ? { analysis: typeof callLog.qualityAnalysis === 'string'
              ? callLog.qualityAnalysis
              : JSON.stringify(callLog.qualityAnalysis) }
        : {}),
    };
  }

  // Realtime telemetry
  if (callLog.totalTurns != null) {
    payload.telemetry = {
      total_turns:          callLog.totalTurns ?? 0,
      ...(callLog.interruptionCount != null ? { interruption_count: callLog.interruptionCount } : {}),
      ...(callLog.toolCallCount     != null ? { tool_call_count:    callLog.toolCallCount }     : {}),
      ...(callLog.whoHungUp              ? { who_hung_up:        callLog.whoHungUp }          : {}),
    };
  }

  console.info(`[QVO EMITTER] → call.completed ${callLogId} (agent: ${callLog.agentUsed})`);
  postWithRetry('/api/v1/ingest/calls', payload)
    .then(() => console.info(`[QVO EMITTER] ✓ call.completed accepted: ${callLogId}`))
    .catch(err => console.error(`[QVO EMITTER] ✗ call.completed failed: ${callLogId}`, err));
}

/**
 * Emit a ticket.created event to QVO.
 * Called immediately after a ticket is successfully sent via the outbox.
 * Completely fire-and-forget — never throws.
 */
async function emitTicketCreated(
  outboxId:     string,
  callLogId:    string | null,
  params:       SyncAgentTicketParams,
  ticketNumber: string,
): Promise<void> {
  if (!isConfigured() || breakerIsOpen()) {
    if (breakerIsOpen()) {
      console.warn(`[QVO EMITTER] Circuit breaker open — skipping ticket event ${outboxId}`);
    }
    return;
  }

  // Normalise priority — our internal value uses 'normal'; QVO expects 'medium'
  const rawPriority = params.priority ?? 'medium';
  const priority = rawPriority === 'normal' ? 'medium' : (rawPriority as 'low' | 'medium' | 'high' | 'urgent');

  const payload: Record<string, unknown> = {
    version:         'v1',
    event_type:      'ticket.created',
    timestamp:       new Date().toISOString(),
    idempotency_key: `remix-ticket-${outboxId}`,
    tenant_id:       QVO_TENANT_ID,
    agent_remote_id: 'no-ivr',             // tickets come from inbound agents

    // Ticket fields
    ...(callLogId ? { call_external_id: callLogId } : {}),
    subject:     params.subject || ticketNumber,
    description: params.description,
    priority,
    created_at:  new Date().toISOString(),

    // Patient identity (QVO will encrypt PII at rest)
    ...(params.patientPhone     ? { external_number:    params.patientPhone }     : {}),
    ...(params.patientFirstName ? { patient_first_name: params.patientFirstName } : {}),
    ...(params.patientLastName  ? { patient_last_name:  params.patientLastName }  : {}),
  };

  console.info(`[QVO EMITTER] → ticket.created ${outboxId} (${ticketNumber})`);
  postWithRetry('/api/v1/ingest/tickets', payload)
    .then(() => console.info(`[QVO EMITTER] ✓ ticket.created accepted: ${outboxId} (${ticketNumber})`))
    .catch(err => console.error(`[QVO EMITTER] ✗ ticket.created failed: ${outboxId}`, err));
}

export const qvoEmitterService = {
  emitCallCompleted,
  emitTicketCreated,
};
