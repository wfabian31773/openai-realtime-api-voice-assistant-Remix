/**
 * AN ALARM THAT ONLY WRITES TO THE CONSOLE HAS NOT ALERTED ANYONE.
 *
 * Codex, PR #244 round seven. The note at the top of `systemAlertService`
 * says alerts "still record to logs and alertHistory, they just don't go to a
 * phone". That was true of the three callers that push the event themselves,
 * and false of the generic `sendAlert` path — which is the one the
 * ticket-filing alarm uses.
 *
 * So the outcome for a critical filing outage was: SMS suppressed (off since
 * 2026-07-27, by operator decision, after it sent one every 15 minutes for
 * hours), email still a TODO, and nothing in `alertHistory` for any interface
 * to read back. Two console lines.
 *
 * This pins the recording half. WHERE a filing-stopped alert should actually
 * be delivered is an operator decision and is not made here — enabling SMS
 * would silently reverse the 07-27 ruling.
 *
 * Read as source text: this module imports the database at load, so it cannot
 * be imported in a unit test without a live DATABASE_URL (that is the same
 * reason `p0Hardening.test.ts` is the suite's known baseline failure).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./systemAlertService.ts', import.meta.url), 'utf8');
// Anchored at the method signature, not at a comment inside it: round eight
// moved the recording ABOVE the cooldown check, and a slice that started at
// "// Check hourly limit" no longer contained the line it was asserting on.
const sendAlert = source.slice(
  source.indexOf('private async sendAlert'),
  source.indexOf('private async sendSmsAlert'),
);

describe('sendAlert records what it was asked to send', () => {
  it('pushes the event to alertHistory', () => {
    // The Observatory renders alertHistory. Without this the alarm is
    // invisible to every surface except a log tail.
    expect(sendAlert).toMatch(/this\.alertHistory\.push\(event\)/);
  });

  it('records ABOVE the cooldown and hourly-limit returns', () => {
    // Round eight moved this up. Suppression is a decision about DELIVERY; an
    // alert dropped for being the fourth this hour is exactly the one an
    // operator later needs to find. Below the returns it was lost entirely.
    const pushAt = sendAlert.indexOf('this.alertHistory.push(event)');
    const cooldownAt = sendAlert.indexOf('Skipping alert (cooldown)');
    const hourlyAt = sendAlert.indexOf('Skipping alert (hourly limit)');
    const smsAt = sendAlert.indexOf('await this.sendSmsAlert(event)');
    for (const [name, at] of [['cooldown', cooldownAt], ['hourly', hourlyAt], ['sms', smsAt]] as const) {
      expect(at, name).toBeGreaterThan(-1);
      expect(pushAt, name).toBeLessThan(at);
    }
  });

  it('records each alert exactly once', () => {
    // Round seven added the push here while three callers were already pushing
    // their own, so every delivered alert landed twice — inflating
    // getAlertStats() and eating the ten-event recent window. The two callers
    // that always reach sendAlert now leave the recording to it.
    const always = source.slice(source.indexOf('async recordCallLogFailure'), source.indexOf('private async sendAlert'));
    expect(always).not.toMatch(/alertHistory\.push/);
    expect(always.match(/await this\.sendAlert\(event\)/g) ?? []).toHaveLength(2);
  });

  it('still records a sub-threshold database failure, which never alerts at all', () => {
    // recordDatabaseFailure is the one caller that can record WITHOUT calling
    // sendAlert — below FAILURE_THRESHOLD it deliberately does not wake anyone,
    // and dropping its push to de-duplicate would have lost that history.
    const dbFailure = source.slice(
      source.indexOf('async recordDatabaseFailure'),
      source.indexOf('recordDatabaseSuccess'),
    );
    expect(dbFailure).toMatch(/consecutiveFailures >= FAILURE_THRESHOLD/);
    expect(dbFailure).toMatch(/\} else \{[\s\S]*alertHistory\.push\(event\)/);
    // And exactly one push — in the else branch, not before the if.
    expect(dbFailure.match(/alertHistory\.push/g) ?? []).toHaveLength(1);
  });

  it('leaves the SMS default alone — that ruling is the operator\'s', () => {
    // 2026-07-27: engineering telemetry to a personal phone buried the one
    // message that mattered. Re-enabling it here would reverse that silently.
    expect(source).toMatch(/SYSTEM_ALERT_SMS_ENABLED = process\.env\.SYSTEM_ALERT_SMS_ENABLED === 'true'/);
  });
});
