/**
 * ONE NOTICE PER TERMINAL REFUSAL, OFF THE CRITICAL ALARM.
 *
 * 2026-09-25: three 400s (office / surgeon) dead-lettered after the ticketing
 * app recovered. The filing alarm treated every dead_letter as
 * ticket_filing_stalled and re-emailed every five minutes while tickets were
 * still landing. A payload refusal is a request a staffer must follow up —
 * not proof the pipe is down.
 *
 * This body is a warning, not a critical. It goes through emailService
 * directly so sendAlert's 5-minute cooldown and 10/hour cap cannot swallow
 * a row. The send is recorded on followup_notified_at; that, not this
 * module, is what makes the notice once-only.
 *
 * NO PHI. CallSid is a Twilio identifier. departmentId and agentUsed are
 * routing. last_error on these rows is the API's field-name sentence
 * ("Missing required information: surgeon"). Patient names stay in the
 * payload and stay off this email.
 */
import type { EmailOptions } from './emailService';
import { alertEmailRecipient } from './alertEmail';

export const TICKET_NEEDS_FOLLOWUP = 'ticket_needs_followup';

export interface FollowupNoticeRow {
  id: string;
  callSid: string | null;
  createdAt: Date;
  lastError: string | null;
  refusalStatusCode: number | null;
  departmentId: string;
  agentUsed: string;
}

export function followupFactsFromPayload(payload: unknown): {
  departmentId: string;
  agentUsed: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { departmentId: 'unknown', agentUsed: 'unknown' };
  }
  const raw = payload as Record<string, unknown>;
  const params =
    raw.kind === 'create_ticket_v1' && raw.params && typeof raw.params === 'object'
      ? (raw.params as Record<string, unknown>)
      : raw;
  const departmentId = params.departmentId == null ? 'unknown' : String(params.departmentId);
  const callData =
    params.callData && typeof params.callData === 'object'
      ? (params.callData as Record<string, unknown>)
      : {};
  const agentUsed =
    typeof callData.agentUsed === 'string' && callData.agentUsed.trim()
      ? callData.agentUsed.trim()
      : 'unknown';
  return { departmentId, agentUsed };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rowLine(row: FollowupNoticeRow): { html: string; text: string } {
  const sid = row.callSid ?? '(no call sid)';
  const when = row.createdAt.toISOString();
  const reason = row.lastError?.trim() || '(no reason recorded)';
  const status = row.refusalStatusCode == null ? '—' : String(row.refusalStatusCode);
  const html =
    `<tr>` +
    `<td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px;">${escapeHtml(sid)}</td>` +
    `<td style="padding:6px 12px 6px 0;font-size:13px;">${escapeHtml(row.agentUsed)} / dept ${escapeHtml(row.departmentId)}</td>` +
    `<td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px;">${escapeHtml(when)}</td>` +
    `<td style="padding:6px 0;font-size:13px;">HTTP ${escapeHtml(status)} — ${escapeHtml(reason).slice(0, 200)}</td>` +
    `</tr>`;
  const text = `- ${sid}  ${row.agentUsed} / dept ${row.departmentId}  ${when}  HTTP ${status} — ${reason.slice(0, 200)}`;
  return { html, text };
}

export function buildFollowupEmail(rows: FollowupNoticeRow[]): EmailOptions {
  const n = rows.length;
  const subject =
    n === 1
      ? `[Azul Vision] Ticket needs follow-up — ${rows[0].callSid ?? rows[0].id}`
      : `[Azul Vision] ${n} tickets need follow-up`;
  const rendered = rows.map(rowLine);
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#b45309;font-weight:600;">
    Azul Vision — needs follow-up
  </p>
  <p style="margin:0 0 16px;font-size:17px;font-weight:600;">
    ${n} ticket request${n === 1 ? '' : 's'} refused by the ticketing app and will not retry.
    Filing itself is healthy. A staffer needs to take these.
  </p>
  <table style="border-collapse:collapse;margin-bottom:16px;">
    <tr>
      <th style="text-align:left;padding:4px 12px 8px 0;color:#6b7280;font-size:12px;">call</th>
      <th style="text-align:left;padding:4px 12px 8px 0;color:#6b7280;font-size:12px;">agent / department</th>
      <th style="text-align:left;padding:4px 12px 8px 0;color:#6b7280;font-size:12px;">created (UTC)</th>
      <th style="text-align:left;padding:4px 0 8px 0;color:#6b7280;font-size:12px;">refusal</th>
    </tr>
    ${rendered.map((r) => r.html).join('')}
  </table>
  <p style="margin:0;font-size:12px;color:#9ca3af;">
    type: ${TICKET_NEEDS_FOLLOWUP}. Each row is emailed once. Resolve it from the Observatory outbox list when it is handled.
  </p>
</div>`.trim();

  const text = [
    'AZUL VISION — NEEDS FOLLOW-UP',
    '',
    `${n} ticket request${n === 1 ? '' : 's'} refused by the ticketing app and will not retry.`,
    'Filing itself is healthy.',
    '',
    ...rendered.map((r) => r.text),
    '',
    `type: ${TICKET_NEEDS_FOLLOWUP}`,
  ].join('\n');

  return {
    to: alertEmailRecipient(),
    subject: subject.slice(0, 180),
    html,
    text,
  };
}
