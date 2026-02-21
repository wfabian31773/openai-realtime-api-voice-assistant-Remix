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
  type: 'database_failure' | 'call_log_failure' | 'circuit_breaker_open' | 'system_degraded' | 'recovery' | 'emergency_miss' | 'provider_miss' | 'handoff_failure_spike' | 'high_mismatch_ratio' | 'grader_critical_failure';
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
}

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between same-type alerts
const MAX_ALERTS_PER_HOUR = 10;
const FAILURE_THRESHOLD = 3; // Alert after 3 consecutive failures

class SystemAlertService {
  private state: AlertState = {
    lastAlertTime: new Map(),
    alertCounts: new Map(),
    systemHealthy: true,
    consecutiveFailures: 0,
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
    
    this.alertHistory.push(event);
    
    if (this.state.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.state.systemHealthy = false;
      await this.sendAlert(event);
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
    
    this.alertHistory.push(event);
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
      
      this.alertHistory.push(event);
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
    
    // Log for now - email integration can be added later
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
  private async sendSmsAlert(event: AlertEvent): Promise<void> {
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
   * Send recovery notification
   */
  private async sendRecoveryAlert(): Promise<void> {
    const event: AlertEvent = {
      type: 'recovery',
      severity: 'info',
      message: 'System has recovered - database operations are working normally',
      timestamp: new Date(),
    };
    
    this.alertHistory.push(event);
    
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

      if (emergencyMissCount > 0) {
        await this.sendAlert({
          type: 'emergency_miss',
          severity: 'critical',
          message: `Emergency handling failure detected: ${emergencyMissCount} emergency miss(es) in last 24h`,
          details: { emergencyMissCount },
          timestamp: new Date(),
        });
      }

      if (providerMissCount > 0) {
        await this.sendAlert({
          type: 'provider_miss',
          severity: 'critical',
          message: `Provider escalation failure: ${providerMissCount} provider miss(es) in last 24h`,
          details: { providerMissCount },
          timestamp: new Date(),
        });
      }

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
        results.push({ alertType: sa.type, delivered: true, detail: 'Alert dispatched (may be suppressed by cooldown/limit)' });
      } catch (err: any) {
        results.push({ alertType: sa.type, delivered: false, detail: err.message || 'Send failed' });
      }
    }
    return results;
  }
}

export const systemAlertService = new SystemAlertService();
