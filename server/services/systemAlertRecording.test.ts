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
const sendAlert = source.slice(
  source.indexOf('// Check hourly limit'),
  source.indexOf('private async sendSmsAlert'),
);

describe('sendAlert records what it was asked to send', () => {
  it('pushes the event to alertHistory', () => {
    // The Observatory renders alertHistory. Without this the alarm is
    // invisible to every surface except a log tail.
    expect(sendAlert).toMatch(/this\.alertHistory\.push\(event\)/);
  });

  it('records BEFORE attempting delivery, so a suppressed channel loses nothing', () => {
    const pushAt = sendAlert.indexOf('this.alertHistory.push(event)');
    const smsAt = sendAlert.indexOf('await this.sendSmsAlert(event)');
    expect(pushAt).toBeGreaterThan(-1);
    expect(smsAt).toBeGreaterThan(-1);
    expect(pushAt).toBeLessThan(smsAt);
  });

  it('leaves the SMS default alone — that ruling is the operator\'s', () => {
    // 2026-07-27: engineering telemetry to a personal phone buried the one
    // message that mattered. Re-enabling it here would reverse that silently.
    expect(source).toMatch(/SYSTEM_ALERT_SMS_ENABLED = process\.env\.SYSTEM_ALERT_SMS_ENABLED === 'true'/);
  });
});
