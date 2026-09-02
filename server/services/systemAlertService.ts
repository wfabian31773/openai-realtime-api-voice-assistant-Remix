/**
 * System Alert Service - Production Monitoring & Notifications
 * 
 * Sends SMS/email alerts when critical system issues occur:
 * - Database connection failures (after retries exhausted)
 * - Call log creation failures
 * - System health degradation
 * - Circuit breaker state changes
 */

import { getTwilioClient, getTwilioFromPhoneNumber } from '../../src/lib/twilioClient';
import { getEnvironmentConfig } from '../../src/config/environment';
import { db } from '../../server/db';
import { sql } from 'drizzle-orm';

interface AlertEvent {
  type: 'database_failure' | 'call_log_failure' | 'circuit_breaker_open' | 'system_degraded' | 'recovery' | 'emergency_miss' | 'provider_miss' | 'handoff_failure_spike' | 'high_mismatch_ratio' | 'grader_critical_failure' | 'ticket_filing_stalled';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  details?: Record<string, any>;
  timestamp: Date;
}

interface AlertState {
  lastAlertTime: Map<string, number>;
  alertCounts: Map<string, number>;
  systemHealthy: boolean;
  consecutiveFailures: number;
  lastRecoverySentAt: number;
  /** Last observed 24h grader miss counts, so alerts fire on a RISE rather than on every check. */
  lastEmergencyMissCount: number;
  lastProviderMissCount: number;
}

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between same-type alerts
const MAX_ALERTS_PER_HOUR = 10;
const FAILURE_THRESHOLD = 3; // Alert after 3 consecutive failures

// System/grader alerts do NOT text. Operator decision, 2026-07-27.
//
// URGENT_NOTIFICATION_NUMBER is a human's personal phone, and it has exactly
// one job: the after-hours no-IVR agent texting a real urgent or emergency
// caller (`[HANDOFF] INCOMING TRANSFER` in src/voiceAgentRoutes.ts). That
// channel is untouched and must stay that way.
//
// This service is engineering telemetry — grader misses, DB failures,
// circuit breakers. Sending it to the same phone buries the one message that
// matters under operational noise; on 2026-07-27 it sent an SMS every 15
// minutes for hours. Alerts still record to logs and alertHistory, they just
// don't go to a phone.
//
// Set SYSTEM_ALERT_SMS_ENABLED=true to restore, ideally only once these point
// at an ops channel rather than a personal number.
const SYSTEM_ALERT_SMS_ENABLED = process.env.SYSTEM_ALERT_SMS_ENABLED === 'true';

class SystemAlertService {
  private state: AlertState = {
    lastAlertTime: new Map(),
    alertCounts: new Map(),
    systemHealthy: true,
    consecutiveFailures: 0,
    lastRecoverySentAt: 0,
    lastEmergencyMissCount: 0,
    lastProviderMissCount: 0,
  };

  private alertHistory: AlertEvent[] = [];
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    console.log('[ALERT SERVICE] Initializing system alert service...');
    this.initialized = true;
    
    // Reset hourly alert counts
    setInterval(() => {
      this.state.alertCounts.clear();
    }, 60 * 60 * 1000);
    
    console.log('[ALERT SERVICE] System alert service initialized');
  }

  /**
   * Record a database failure. Alerts after threshold is reached.
   */
  async recordDatabaseFailure(operation: string, error: Error): Promise<void> {
    this.state.consecutiveFailures++;
    
    const event: AlertEvent = {
      type: 'database_failure',
      severity: 'critical',
      message: `Database operation failed: ${operation}`,
      details: { 
        error: error.message, 
        consecutiveFailures: this.state.consecutiveFailures,
        operation,
      },
      timestamp: new Date(),
    };
    
    if (this.state.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.state.systemHealthy = false;
      // sendAlert records it; pushing here too would count it twice.
      await this.sendAlert(event);
    } else {
      // The only path that records WITHOUT alerting. A single failure below
      // the threshold is history worth keeping and not worth waking anyone for.
      this.alertHistory.push(event);
    }
  }

  /**
   * Record successful database operation (resets failure count)
   */
  recordDatabaseSuccess(): void {
    if (this.state.consecutiveFailures > 0 || !this.state.systemHealthy) {
      console.log('[ALERT SERVICE] Database operations recovered');
      
      if (!this.state.systemHealthy) {
        this.sendRecoveryAlert();
      }
    }
    
    this.state.consecutiveFailures = 0;
    this.state.systemHealthy = true;
  }

  /**
   * Record a call log creation failure (critical for healthcare)
   */
  async recordCallLogFailure(callSid: string, error: Error): Promise<void> {
    const event: AlertEvent = {
      type: 'call_log_failure',
      severity: 'critical',
      message: `Failed to create call log for ${callSid?.slice(-8) || 'unknown'}`,
      details: { 
        callSid: callSid?.slice(-8),
        error: error.message,
      },
      timestamp: new Date(),
    };
    
    // Recorded by sendAlert, reached unconditionally from here.
    await this.sendAlert(event);
  }

  /**
   * Record circuit breaker state change
   */
  async recordCircuitBreakerChange(name: string, fromState: string, toState: string): Promise<void> {
    if (toState === 'open') {
      const event: AlertEvent = {
        type: 'circuit_breaker_open',
        severity: 'warning',
        message: `Circuit breaker '${name}' opened - service may be degraded`,
        details: { circuitName: name, fromState, toState },
        timestamp: new Date(),
      };
      
      // Recorded by sendAlert, reached unconditionally from here.
      await this.sendAlert(event);
    }
  }

  /**
   * Send alert via SMS and/or email
   */
  private async sendAlert(event: AlertEvent): Promise<void> {
    const alertKey = `${event.type}:${event.severity}`;
    
    // Check cooldown
    const lastAlert = this.state.lastAlertTime.get(alertKey) || 0;
    /**
     * RECORD EVERY ALERT, BEFORE ANY REASON NOT TO SEND IT — Codex, PR #244,
     * across two rounds, and the second round was correcting the first.
     *
     * Round seven: the note at the top of this file promises alerts "still
     * record to logs and alertHistory". That held for the three callers that
     * push the event themselves and not for `sendAlert` — which SEVEN other
     * call sites use, the grader alerts and the ticket-filing alarm among
     * them. Those were never recorded at all.
     *
     * Round eight: adding the push lower down made the three self-pushing
     * callers record twice, inflating `getAlertStats()` and eating the
     * ten-event recent window.
     *
     * Recording HERE, above the cooldown and hourly-limit returns, settles
     * both. Suppression is a decision about DELIVERY, and an alert dropped for
     * being the fourth this hour is precisely the one an operator later needs
     * to find in the history — the old placement, below those returns, would
     * have lost it. The two callers that always reach this drop their own
     * push; `recordDatabaseFailure` keeps one for the sub-threshold case where
     * it never calls this at all.
     */
    this.alertHistory.push(event);

    const timeSinceLastAlert = Date.now() - lastAlert;
    
    if (timeSinceLastAlert < ALERT_COOLDOWN_MS) {
      console.log(`[ALERT SERVICE] Skipping alert (cooldown): ${event.message}`);
      return;
    }
    
    // Check hourly limit
    const hourlyCount = this.state.alertCounts.get(alertKey) || 0;
    if (hourlyCount >= MAX_ALERTS_PER_HOUR) {
      console.log(`[ALERT SERVICE] Skipping alert (hourly limit): ${event.message}`);
      return;
    }
    
    // Update state
    this.state.lastAlertTime.set(alertKey, Date.now());
    this.state.alertCounts.set(alertKey, hourlyCount + 1);
    
    console.log(`[ALERT SERVICE] Sending ${event.severity} alert: ${event.message}`);

    // Send SMS alert for critical issues
    if (event.severity === 'critical') {
      await this.sendSmsAlert(event);
    }

    await this.sendEmailAlert(event);

    console.log(`[ALERT SERVICE] Alert sent:`, {
      type: event.type,
      severity: event.severity,
      message: event.message,
      timestamp: event.timestamp.toISOString(),
    });
  }

  /**
   * Send SMS alert via Twilio
   */
  /**
   * EMAIL IS THE CHANNEL THAT ACTUALLY REACHES SOMEONE — operator, 2026-09-02.
   *
   * Codex found that a critical filing outage produced two console lines and
   * nothing else: SMS off since the 2026-07-27 ruling, email a TODO. I left
   * the channel open as his call rather than reverse that ruling by enabling
   * SMS. He answered: *"for the alert, email me at wfabian@azulvision.com,
   * use the same route we use for invites and such"* — which is
   * `emailService.sendEmail`, the Office365 sender behind `sendInviteEmail`.
   *
   * DELIBERATELY BELOW THE COOLDOWN AND HOURLY GATES. The July ruling was
   * about volume — one text every fifteen minutes for hours, burying the
   * message that mattered — and putting email above those returns would
   * reproduce it in an inbox. Here it inherits the 5-minute cooldown and the
   * ten-an-hour cap, and critical-only on top of that.
   *
   * ON BY DEFAULT, with no new flag and no required variable. A flag
   * defaulting off, or an unset SYSTEM_ALERT_EMAIL, would deploy an alarm that
   * detects perfectly and still reaches nobody — the exact defect being fixed.
   *
   * NEVER THROWS. This is called from the five-minute alarm loop; a mail
   * failure must not take the loop down or mask the outage it is reporting.
   * `sendEmail` already swallows its own errors and returns false, so the
   * catch here is for the import and the body build.
   */
  private async sendEmailAlert(event: AlertEvent): Promise<void> {
    try {
      const { shouldEmailAlert, buildAlertEmail } = await import('./alertEmail');
      if (!shouldEmailAlert(event.severity)) return;

      const { sendEmail } = await import('./emailService');
      const message = buildAlertEmail(event);
      const delivered = await sendEmail(message);

      if (delivered) {
        console.log(`[ALERT SERVICE] Alert emailed to ${message.to}: ${event.type}`);
      } else {
        console.error(
          `[ALERT SERVICE] ✗ Alert email FAILED for ${event.type} to ${message.to} — ` +
            `the alert is recorded but nobody has been told. Check SMTP_PASSWORD.`,
        );
      }
    } catch (error) {
      console.error('[ALERT SERVICE] ✗ Alert email threw (alert still recorded):', error);
    }
  }

  private async sendSmsAlert(event: AlertEvent): Promise<void> {
    if (!SYSTEM_ALERT_SMS_ENABLED) {
      console.log(`[ALERT SERVICE] SMS suppressed (SYSTEM_ALERT_SMS_ENABLED not set): ${event.type} — ${event.message}`);
      return;
    }

    try {
      const config = getEnvironmentConfig();
      const alertNumber = config.twilio.urgentNotificationNumber;

      if (!alertNumber) {
        console.warn('[ALERT SERVICE] No URGENT_NOTIFICATION_NUMBER configured for SMS alerts');
        return;
      }

      const twilioClient = await getTwilioClient();
      const fromNumber = await getTwilioFromPhoneNumber();
      
      if (!twilioClient || !fromNumber) {
        console.warn('[ALERT SERVICE] Twilio not configured for SMS alerts');
        return;
      }
      
      const severityEmoji = event.severity === 'critical' ? '🚨' : '⚠️';
      const smsBody = `${severityEmoji} AZUL VISION ALERT\n\n${event.message}\n\nTime: ${event.timestamp.toLocaleTimeString()}\nType: ${event.type}`;
      
      await twilioClient.messages.create({
        body: smsBody.slice(0, 1600), // SMS length limit
        from: fromNumber,
        to: alertNumber,
      });
      
      console.log(`[ALERT SERVICE] SMS alert sent to ${alertNumber.slice(-4)}`);
    } catch (error) {
      console.error('[ALERT SERVICE] Failed to send SMS alert:', error);
    }
  }

  /**
   * Send recovery notification (rate-limited to once per cooldown window)
   */
  private async sendRecoveryAlert(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRecovery = now - this.state.lastRecoverySentAt;

    if (timeSinceLastRecovery < ALERT_COOLDOWN_MS) {
      const remainingSecs = Math.round((ALERT_COOLDOWN_MS - timeSinceLastRecovery) / 1000);
      console.log(`[ALERT SERVICE] Skipping recovery SMS (cooldown — ${remainingSecs}s remaining)`);
      return;
    }

    this.state.lastRecoverySentAt = now;

    const event: AlertEvent = {
      type: 'recovery',
      severity: 'info',
      message: 'System has recovered - database operations are working normally',
      timestamp: new Date(),
    };
    
    this.alertHistory.push(event);

    if (!SYSTEM_ALERT_SMS_ENABLED) {
      console.log('[ALERT SERVICE] Recovery SMS suppressed (SYSTEM_ALERT_SMS_ENABLED not set)');
      return;
    }

    try {
      const config = getEnvironmentConfig();
      const alertNumber = config.twilio.urgentNotificationNumber;

      if (!alertNumber) return;

      const twilioClient = await getTwilioClient();
      const fromNumber = await getTwilioFromPhoneNumber();
      
      if (!twilioClient || !fromNumber) return;
      
      await twilioClient.messages.create({
        body: `✅ AZUL VISION RECOVERY\n\nSystem has recovered and is operating normally.\n\nTime: ${event.timestamp.toLocaleTimeString()}`,
        from: fromNumber,
        to: alertNumber,
      });
      
      console.log('[ALERT SERVICE] Recovery SMS sent');
    } catch (error) {
      console.error('[ALERT SERVICE] Failed to send recovery SMS:', error);
    }
  }

  /**
   * Get current system health status
   */
  getHealthStatus(): {
    healthy: boolean;
    consecutiveFailures: number;
    recentAlerts: AlertEvent[];
    lastAlertTime: string | null;
  } {
    const recentAlerts = this.alertHistory
      .filter(a => Date.now() - a.timestamp.getTime() < 60 * 60 * 1000) // Last hour
      .slice(-10);
    
    const lastAlert = this.alertHistory[this.alertHistory.length - 1];
    
    return {
      healthy: this.state.systemHealthy,
      consecutiveFailures: this.state.consecutiveFailures,
      recentAlerts,
      lastAlertTime: lastAlert ? lastAlert.timestamp.toISOString() : null,
    };
  }

  /**
   * Get alert statistics
   */
  getAlertStats(): {
    totalAlertsToday: number;
    alertsByType: Record<string, number>;
    systemUptime: string;
  } {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayAlerts = this.alertHistory.filter(a => a.timestamp >= today);
    
    const alertsByType: Record<string, number> = {};
    todayAlerts.forEach(a => {
      alertsByType[a.type] = (alertsByType[a.type] || 0) + 1;
    });
    
    return {
      totalAlertsToday: todayAlerts.length,
      alertsByType,
      systemUptime: this.state.systemHealthy ? 'healthy' : 'degraded',
    };
  }

  async checkGraderAlerts(): Promise<void> {
    try {
      const rows = await db.execute(sql`
        SELECT grader_results FROM call_logs
        WHERE grader_results IS NOT NULL
        AND created_at > NOW() - INTERVAL '24 hours'
      `);

      let totalGraded = 0;
      let handoffPassCount = 0;
      let handoffTotalCount = 0;
      let durationMismatchFailCount = 0;
      let criticalFailCount = 0;
      let emergencyMissCount = 0;
      let providerMissCount = 0;

      for (const row of rows.rows) {
        const results = (row as any).grader_results;
        if (!results?.graders) continue;
        totalGraded++;

        let hasCriticalFail = false;
        for (const g of results.graders) {
          const name = g.grader || '';
          const passed = g.pass ?? true;
          const severity = g.severity || '';

          if (name === 'handoff_expected_vs_actual') {
            handoffTotalCount++;
            if (passed) handoffPassCount++;
          }
          if (!passed && name === 'duration_mismatch') {
            durationMismatchFailCount++;
          }
          if (!passed && severity === 'critical') {
            hasCriticalFail = true;
          }
          if (!passed && name === 'emergency_handling') {
            emergencyMissCount++;
          }
          if (!passed && name === 'provider_must_escalate') {
            providerMissCount++;
          }
        }
        if (hasCriticalFail) criticalFailCount++;
      }

      const handoffSuccessRate = handoffTotalCount > 0 ? Math.round((handoffPassCount / handoffTotalCount) * 10000) / 100 : 100;
      const criticalFailRate = totalGraded > 0 ? Math.round((criticalFailCount / totalGraded) * 10000) / 100 : 0;

      // Edge-triggered, not level-triggered.
      //
      // These counts are over a rolling 24h window but the check runs every
      // 15 minutes, and ALERT_COOLDOWN_MS (5 min) is shorter than that — so a
      // level check (`count > 0`) re-alerts on the SAME calls roughly 96 times
      // before they age out of the window. That is what paged the on-call
      // number every 15 minutes on 2026-07-27. Alerting only when the count
      // RISES means one page per new miss, which is the actual signal.
      //
      // The counter resets when the window drains, so a recurrence after a
      // quiet period pages again rather than staying silent.
      if (emergencyMissCount > this.state.lastEmergencyMissCount) {
        const newMisses = emergencyMissCount - this.state.lastEmergencyMissCount;
        await this.sendAlert({
          type: 'emergency_miss',
          severity: 'critical',
          message: `Emergency handling failure detected: ${newMisses} new emergency miss(es) (${emergencyMissCount} in last 24h)`,
          details: { emergencyMissCount, newMisses },
          timestamp: new Date(),
        });
      }
      this.state.lastEmergencyMissCount = emergencyMissCount;

      if (providerMissCount > this.state.lastProviderMissCount) {
        const newMisses = providerMissCount - this.state.lastProviderMissCount;
        await this.sendAlert({
          type: 'provider_miss',
          severity: 'critical',
          message: `Provider escalation failure: ${newMisses} new provider miss(es) (${providerMissCount} in last 24h)`,
          details: { providerMissCount, newMisses },
          timestamp: new Date(),
        });
      }
      this.state.lastProviderMissCount = providerMissCount;

      if (handoffSuccessRate < 80 && handoffTotalCount > 3) {
        await this.sendAlert({
          type: 'handoff_failure_spike',
          severity: 'warning',
          message: `Handoff success rate degraded: ${handoffSuccessRate}% (threshold: 80%)`,
          details: { handoffSuccessRate, handoffTotalCount, handoffPassCount },
          timestamp: new Date(),
        });
      }

      if (durationMismatchFailCount > 5) {
        await this.sendAlert({
          type: 'high_mismatch_ratio',
          severity: 'warning',
          message: `High duration mismatch ratio: ${durationMismatchFailCount} mismatches in last 24h`,
          details: { durationMismatchFailCount },
          timestamp: new Date(),
        });
      }

      if (criticalFailRate > 10 && totalGraded > 5) {
        await this.sendAlert({
          type: 'grader_critical_failure',
          severity: 'warning',
          message: `Critical grader failure rate elevated: ${criticalFailRate}%`,
          details: { criticalFailRate, criticalFailCount, totalGraded },
          timestamp: new Date(),
        });
      }

      console.log(`[ALERT SERVICE] Grader alert check complete: ${totalGraded} calls graded in last 24h`);
    } catch (error) {
      console.error('[ALERT SERVICE] Error checking grader alerts:', error);
    }
  }

  startGraderAlertSchedule(): void {
    console.log('[ALERT SERVICE] Starting grader alert schedule (every 15 minutes)');
    setInterval(() => {
      this.checkGraderAlerts();
    }, 15 * 60 * 1000);
  }

  /**
   * THE TICKET PATH FINALLY HAS A WATCH ON IT.
   *
   * On 2026-08-31 filing stopped at 20:16 UTC and ran dead for three and a
   * half hours. Nothing alerted — R1–R12 in the diagnosis rules do not cover
   * the ticket path at all, which is the queue lines' entire job — and it was
   * found because staff told the operator.
   *
   * Thresholds and their derivation live in ticketFilingHealth.ts. Replayed
   * against the production rows, this fires at 20:23:06 that night, and does
   * not fire on any other run in the fortnight around it.
   *
   * Every five minutes rather than fifteen: seven minutes of detection is only
   * worth having if the check runs inside it.
   */
  async checkTicketFilingAlert(): Promise<void> {
    try {
      const { readTicketFilingSnapshot, assessTicketFiling } = await import('./ticketFilingHealth');
      const snapshot = await readTicketFilingSnapshot();
      if (!snapshot) return; // it logged its own reason

      const verdict = assessTicketFiling(snapshot);
      if (!verdict.stalled) {
        console.log(
          `[ALERT SERVICE] Ticket filing OK — ${verdict.unfiledRun} call(s) since the last ticket, ` +
            `${verdict.outboxHeld} held in the outbox`,
        );
        return;
      }

      await this.sendAlert({
        type: 'ticket_filing_stalled',
        severity: 'critical',
        message: `TICKET FILING HAS STOPPED: ${verdict.reason}`,
        details: {
          unfiledRun: verdict.unfiledRun,
          minutesSinceLastFiled: verdict.minutesSinceLastFiled,
          outboxHeld: verdict.outboxHeld,
        },
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[ALERT SERVICE] Error checking ticket filing:', error);
    }
  }

  startTicketFilingSchedule(): void {
    console.log('[ALERT SERVICE] Starting ticket-filing alarm (every 5 minutes)');
    setInterval(() => {
      this.checkTicketFilingAlert();
    }, 5 * 60 * 1000);
  }

  async runSyntheticAlertTest(): Promise<Array<{ alertType: string; delivered: boolean; detail: string }>> {
    const results: Array<{ alertType: string; delivered: boolean; detail: string }> = [];

    const syntheticAlerts: Array<{ type: AlertEvent['type']; severity: AlertEvent['severity']; message: string }> = [
      { type: 'emergency_miss', severity: 'critical', message: 'SYNTHETIC TEST: Emergency handling failure' },
      { type: 'provider_miss', severity: 'critical', message: 'SYNTHETIC TEST: Provider escalation failure' },
      { type: 'handoff_failure_spike', severity: 'warning', message: 'SYNTHETIC TEST: Handoff success rate degraded' },
      { type: 'high_mismatch_ratio', severity: 'warning', message: 'SYNTHETIC TEST: Duration mismatch elevated' },
      { type: 'grader_critical_failure', severity: 'warning', message: 'SYNTHETIC TEST: Critical grader failure rate elevated' },
    ];

    for (const sa of syntheticAlerts) {
      try {
        await this.sendAlert({
          type: sa.type,
          severity: sa.severity,
          message: sa.message,
          details: { synthetic: true },
          timestamp: new Date(),
        });
        results.push({
          alertType: sa.type,
          delivered: true,
          detail: SYSTEM_ALERT_SMS_ENABLED
            ? 'Alert dispatched (may be suppressed by cooldown/limit)'
            : 'Alert dispatched to logs only — SMS disabled (SYSTEM_ALERT_SMS_ENABLED not set). No text was sent.',
        });
      } catch (err: any) {
        results.push({ alertType: sa.type, delivered: false, detail: err.message || 'Send failed' });
      }
    }
    return results;
  }
}

export const systemAlertService = new SystemAlertService();
