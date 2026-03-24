/**
 * SIP Call Health Monitor
 *
 * Periodically checks Twilio's API for recent SIP calls to sip.api.openai.com.
 * If all recent SIP calls have failed AND at least 3 calls were attempted,
 * it fires an SMS alert to the on-call number (HUMAN_AGENT_NUMBER).
 *
 * Rate-limiting: at most one SMS alert per 30-minute window.
 * The latest check result is exposed via /api/health/sip.
 */

import { getTwilioClient, getTwilioFromPhoneNumber } from '../lib/twilioClient';
import { getEnvironmentConfig } from '../config/environment';

const MONITOR_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const LOOKBACK_MINUTES = 30;
const MIN_CALLS_REQUIRED = 3;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between SMS alerts

const TWILIO_CONSOLE_URL = 'https://console.twilio.com/us1/monitor/logs/calls';

export interface SipHealthStatus {
  timestamp: string;
  callsChecked: number;
  failures: number;
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  message: string;
}

let latestStatus: SipHealthStatus = {
  timestamp: new Date().toISOString(),
  callsChecked: 0,
  failures: 0,
  status: 'unknown',
  message: 'Monitor has not run yet',
};

let lastAlertSentAt = 0;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single health check cycle.
 */
async function runCheck(): Promise<void> {
  const now = new Date();
  const startTime = new Date(now.getTime() - LOOKBACK_MINUTES * 60 * 1000);

  let callsChecked = 0;
  let failures = 0;

  try {
    const client = await getTwilioClient();

    // The SIP URI for all calls uses the OpenAI Project ID as the user portion:
    //   sip:<OPENAI_PROJECT_ID>@sip.api.openai.com
    // This matches the pattern used throughout voiceAgentRoutes.ts.
    const openaiProjectId = process.env.OPENAI_PROJECT_ID;
    if (!openaiProjectId) {
      throw new Error('OPENAI_PROJECT_ID not configured — cannot filter SIP calls');
    }

    // Fetch calls to the OpenAI SIP endpoint in the last LOOKBACK_MINUTES minutes.
    // Twilio's Calls list supports filtering by 'to' SIP URI via the 'to' param.
    // We use startTimeBefore/startTimeAfter to scope the window.
    const calls = await client.calls.list({
      to: `sip:${openaiProjectId}@sip.api.openai.com`,
      startTimeAfter: startTime,
      startTimeBefore: now,
      limit: 100,
    });

    callsChecked = calls.length;
    failures = calls.filter(c => c.status === 'failed').length;

    let status: SipHealthStatus['status'];
    let message: string;

    if (callsChecked === 0) {
      status = 'unknown';
      message = `No SIP calls to sip.api.openai.com in the last ${LOOKBACK_MINUTES} minutes`;
    } else if (callsChecked < MIN_CALLS_REQUIRED) {
      status = failures === callsChecked ? 'degraded' : 'ok';
      message = `${callsChecked} call(s) checked (< ${MIN_CALLS_REQUIRED} minimum), ${failures} failed`;
    } else if (failures === callsChecked) {
      status = 'down';
      message = `ALL ${callsChecked} SIP call(s) failed in the last ${LOOKBACK_MINUTES} minutes`;
    } else if (failures > 0) {
      status = 'degraded';
      message = `${failures}/${callsChecked} SIP call(s) failed in the last ${LOOKBACK_MINUTES} minutes`;
    } else {
      status = 'ok';
      message = `${callsChecked} SIP call(s) completed successfully`;
    }

    const checkResult: SipHealthStatus = {
      timestamp: now.toISOString(),
      callsChecked,
      failures,
      status,
      message,
    };

    latestStatus = checkResult;

    console.log('[SIP-MONITOR]', JSON.stringify({
      event: 'sip_health_check',
      ...checkResult,
    }));

    // Fire SMS alert if fully down with enough calls and cooldown has passed
    if (
      status === 'down' &&
      callsChecked >= MIN_CALLS_REQUIRED &&
      Date.now() - lastAlertSentAt >= ALERT_COOLDOWN_MS
    ) {
      await sendAlert(checkResult);
    }
  } catch (error: any) {
    const errorStatus: SipHealthStatus = {
      timestamp: now.toISOString(),
      callsChecked,
      failures,
      status: 'unknown',
      message: `Health check error: ${error?.message || String(error)}`,
    };
    latestStatus = errorStatus;
    console.error('[SIP-MONITOR]', JSON.stringify({
      event: 'sip_health_check_error',
      error: error?.message || String(error),
      ...errorStatus,
    }));
  }
}

/**
 * Send an SMS alert to the on-call number.
 */
async function sendAlert(status: SipHealthStatus): Promise<void> {
  try {
    const config = getEnvironmentConfig();
    const alertNumber = config.twilio.humanAgentNumber;

    if (!alertNumber) {
      console.warn('[SIP-MONITOR] HUMAN_AGENT_NUMBER not configured — skipping SMS alert');
      return;
    }

    const twilioClient = await getTwilioClient();
    const fromNumber = await getTwilioFromPhoneNumber();

    if (!twilioClient || !fromNumber) {
      console.warn('[SIP-MONITOR] Twilio not available — skipping SMS alert');
      return;
    }

    const body = [
      `🚨 SIP HEALTH ALERT`,
      ``,
      `${status.failures} of ${status.callsChecked} SIP calls to OpenAI failed in the last ${LOOKBACK_MINUTES} minutes.`,
      ``,
      `Time: ${new Date(status.timestamp).toLocaleTimeString()}`,
      `Console: ${TWILIO_CONSOLE_URL}`,
    ].join('\n').slice(0, 1600);

    await twilioClient.messages.create({
      body,
      from: fromNumber,
      to: alertNumber,
    });

    lastAlertSentAt = Date.now();
    console.log('[SIP-MONITOR]', JSON.stringify({
      event: 'sip_alert_sent',
      to: alertNumber.slice(-4),
      failures: status.failures,
      callsChecked: status.callsChecked,
    }));
  } catch (error: any) {
    console.error('[SIP-MONITOR] Failed to send SMS alert:', error?.message || String(error));
  }
}

/**
 * Return the latest SIP health check result.
 */
export function getLatestSipHealthStatus(): SipHealthStatus {
  return latestStatus;
}

/**
 * Start the SIP health monitor.
 * Runs an immediate check on startup, then every MONITOR_INTERVAL_MS.
 */
export function start(intervalMs: number = MONITOR_INTERVAL_MS): void {
  if (monitorInterval) {
    console.warn('[SIP-MONITOR] Monitor already running — skipping duplicate start');
    return;
  }

  console.log(`[SIP-MONITOR] Starting SIP health monitor (interval: ${intervalMs / 60000} min, lookback: ${LOOKBACK_MINUTES} min, min calls: ${MIN_CALLS_REQUIRED})`);

  // Run immediately, then on interval
  runCheck().catch(err => console.error('[SIP-MONITOR] Initial check failed:', err));
  monitorInterval = setInterval(() => {
    runCheck().catch(err => console.error('[SIP-MONITOR] Scheduled check failed:', err));
  }, intervalMs);
}

/**
 * Stop the SIP health monitor (useful for testing / graceful shutdown).
 */
export function stop(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[SIP-MONITOR] Monitor stopped');
  }
}
