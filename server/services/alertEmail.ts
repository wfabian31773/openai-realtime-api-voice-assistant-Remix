/**
 * WHERE A CRITICAL ALERT ACTUALLY GOES.
 *
 * Codex raised this on PR #244: the ticket-filing alarm detected correctly,
 * recorded to `alertHistory`, painted the Observatory banner — and reached
 * nobody. SMS has been off since 2026-07-27 by the operator's own ruling,
 * made after it sent one every 15 minutes for hours and buried the message
 * that mattered; email was a TODO. I left the channel open as his decision
 * rather than silently reverse that ruling.
 *
 * He answered on 2026-09-02: *"for the alert, email me at
 * wfabian@azulvision.com, use the same route we use for invites and such."*
 * That route is `emailService.sendEmail` — Office365 SMTP as
 * notifications@me.azulvision.com, the same sender behind `sendInviteEmail`.
 *
 * THIS MODULE IS SEPARATE FROM `systemAlertService` ON PURPOSE.
 * That module imports the database at load, so nothing in it can be imported
 * by a unit test without a live DATABASE_URL — which is why its existing tests
 * read it as source text, and why four tests on this branch asserted nothing
 * until a mutation said so. The recipient rule, the severity rule and the body
 * are pure functions here, so they are tested by being run.
 *
 * NO PHI. The body carries the message, the severity, the timestamp and
 * primitive `details` values only. Objects and arrays are dropped rather than
 * serialised: `details` is typed `Record<string, any>`, so the only safe
 * assumption is that anything structured could carry a caller. Today's
 * critical alerts pass counts, an operation name, an error string and a
 * last-8 CallSid fragment — but the type permits more, and an alert email is
 * not the place to find out.
 */
import type { EmailOptions } from './emailService';

/**
 * Defaulted, not required. A required-and-unset variable is exactly the defect
 * this exists to fix: the alarm would deploy, detect, and reach nobody, which
 * is the state Codex found it in. Setting SYSTEM_ALERT_EMAIL overrides it.
 */
const DEFAULT_ALERT_EMAIL = 'wfabian@azulvision.com';

export function alertEmailRecipient(): string {
  return process.env.SYSTEM_ALERT_EMAIL?.trim() || DEFAULT_ALERT_EMAIL;
}

export interface AlertEmailInput {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

/**
 * Critical only — the same bar SMS used.
 *
 * The July ruling was about VOLUME, not about the channel, so emailing every
 * warning would reproduce it in a new inbox. Delivery is additionally bounded
 * by `sendAlert`'s own 5-minute cooldown and 10-per-hour cap, because this is
 * called from below both of those gates.
 */
export function shouldEmailAlert(severity: string): boolean {
  return severity === 'critical';
}

/** Primitives only. Anything structured is dropped — see the PHI note above. */
function renderDetails(details: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!details) return [];
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) continue;
    const t = typeof value;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') continue;
    rows.push([key, String(value).slice(0, 200)]);
  }
  return rows;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildAlertEmail(event: AlertEmailInput): EmailOptions {
  const when = event.timestamp.toISOString();
  const rows = renderDetails(event.details);

  const detailRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;">${escapeHtml(k)}</td>` +
        `<td style="padding:4px 0;color:#1f2937;font-size:13px;font-family:monospace;">${escapeHtml(v)}</td></tr>`,
    )
    .join('');

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#b91c1c;font-weight:600;">
    Azul Vision — critical alert
  </p>
  <p style="margin:0 0 16px;font-size:17px;font-weight:600;">${escapeHtml(event.message)}</p>
  <table style="border-collapse:collapse;margin-bottom:16px;">
    <tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;">type</td>
        <td style="padding:4px 0;color:#1f2937;font-size:13px;font-family:monospace;">${escapeHtml(event.type)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;">time (UTC)</td>
        <td style="padding:4px 0;color:#1f2937;font-size:13px;font-family:monospace;">${escapeHtml(when)}</td></tr>
    ${detailRows}
  </table>
  <p style="margin:0;font-size:12px;color:#9ca3af;">
    Sent because this alert is critical. Repeats are limited to one every five minutes and ten an hour.
  </p>
</div>`.trim();

  const text = [
    `AZUL VISION — CRITICAL ALERT`,
    ``,
    event.message,
    ``,
    `type: ${event.type}`,
    `time (UTC): ${when}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
  ].join('\n');

  return {
    to: alertEmailRecipient(),
    subject: `[Azul Vision] ${event.message}`.slice(0, 180),
    html,
    text,
  };
}
