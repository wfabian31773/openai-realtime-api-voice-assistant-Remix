/**
 * THE ALARM NOW HAS A CHANNEL — and these run it rather than read it.
 *
 * `systemAlertService` imports the database at load, so its own tests read it
 * as source text. Four tests on this branch asserted nothing until a mutation
 * said so, all of them source slices. The recipient rule, the severity rule
 * and the body are pure functions in `alertEmail.ts` precisely so they can be
 * executed here instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { alertEmailRecipient, shouldEmailAlert, buildAlertEmail } from './alertEmail';

const AT = new Date('2026-09-02T11:45:00.000Z');

const filingStalled = {
  type: 'ticket_filing_stalled',
  severity: 'critical' as const,
  message: 'TICKET FILING HAS STOPPED: 14 queue calls with no ticket',
  details: { unfiledRun: 14, minutesSinceLastFiled: 37, outboxHeld: 0 },
  timestamp: AT,
};

const originalEnv = process.env.SYSTEM_ALERT_EMAIL;
beforeEach(() => { delete process.env.SYSTEM_ALERT_EMAIL; });
afterEach(() => {
  if (originalEnv === undefined) delete process.env.SYSTEM_ALERT_EMAIL;
  else process.env.SYSTEM_ALERT_EMAIL = originalEnv;
});

describe('who the alert goes to', () => {
  it('defaults to the operator, with nothing configured', () => {
    // Not a required variable: unset, the old behaviour was an alarm that
    // detected perfectly and reached nobody.
    expect(alertEmailRecipient()).toBe('wfabian@azulvision.com');
  });

  it('is overridable by SYSTEM_ALERT_EMAIL', () => {
    process.env.SYSTEM_ALERT_EMAIL = 'oncall@example.com';
    expect(alertEmailRecipient()).toBe('oncall@example.com');
  });

  it('falls back when the variable is set to whitespace', () => {
    process.env.SYSTEM_ALERT_EMAIL = '   ';
    expect(alertEmailRecipient()).toBe('wfabian@azulvision.com');
  });
});

describe('which alerts email at all', () => {
  it('emails a critical alert', () => {
    expect(shouldEmailAlert('critical')).toBe(true);
  });

  it.each(['warning', 'info'])('does not email a %s alert', (sev) => {
    // The 2026-07-27 ruling was about volume. Emailing every warning would
    // reproduce it in an inbox instead of on a phone.
    expect(shouldEmailAlert(sev)).toBe(false);
  });
});

describe('what the alert says', () => {
  it('carries the message, the type and the counts', () => {
    const mail = buildAlertEmail(filingStalled);
    expect(mail.to).toBe('wfabian@azulvision.com');
    expect(mail.subject).toContain('TICKET FILING HAS STOPPED');
    expect(mail.html).toContain('TICKET FILING HAS STOPPED');
    expect(mail.html).toContain('ticket_filing_stalled');
    expect(mail.html).toContain('unfiledRun');
    expect(mail.html).toContain('14');
    expect(mail.text).toContain('minutesSinceLastFiled: 37');
    expect(mail.text).toContain('2026-09-02T11:45:00.000Z');
  });

  it('drops structured details rather than serialising them', () => {
    // `details` is Record<string, any>. Today's critical alerts pass counts and
    // an error string, but the type permits an object carrying a caller, and an
    // alert email is not where that should first be discovered.
    const mail = buildAlertEmail({
      ...filingStalled,
      details: {
        unfiledRun: 3,
        patient: { firstName: 'Ruth', lastName: 'Alvarez', phone: '9095551234' },
        recentCallers: ['9095551234'],
      },
    });
    expect(mail.html).toContain('unfiledRun');
    expect(mail.html).not.toContain('Ruth');
    expect(mail.html).not.toContain('Alvarez');
    expect(mail.html).not.toContain('9095551234');
    expect(mail.text).not.toContain('9095551234');
  });

  it('escapes markup in the message rather than emitting it', () => {
    const mail = buildAlertEmail({ ...filingStalled, message: 'stopped <script>x</script>' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('survives an alert with no details', () => {
    const mail = buildAlertEmail({ ...filingStalled, details: undefined });
    expect(mail.html).toContain('TICKET FILING HAS STOPPED');
    expect(mail.text).toContain('ticket_filing_stalled');
  });

  it('caps a runaway detail value', () => {
    const mail = buildAlertEmail({ ...filingStalled, details: { error: 'x'.repeat(5000) } });
    expect(mail.html.length).toBeLessThan(4000);
  });
});
