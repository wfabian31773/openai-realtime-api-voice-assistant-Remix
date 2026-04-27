import { sendEmail } from '../../server/services/emailService';

interface DiscrepancyAlertParams {
  dateStr: string;
  actualUsd: number;
  estimatedUsd: number;
  deltaUsd: number;
  deltaPercent: number;
  thresholdPct: number;
}

function getDashboardUrl(): string {
  const domain = process.env.REPLIT_DOMAINS?.split(',')[0];
  if (domain) {
    return `https://${domain}/cost-dashboard`;
  }
  return 'https://localhost:5000/cost-dashboard';
}

async function sendSlackAlert(webhookUrl: string, params: DiscrepancyAlertParams): Promise<void> {
  const dashboardUrl = getDashboardUrl();
  const sign = params.deltaUsd >= 0 ? '+' : '';
  const payload = {
    text: `*[Azul Vision] Cost Discrepancy Alert — ${params.dateStr}*`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Cost Discrepancy Alert — ${params.dateStr}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Date:*\n${params.dateStr}` },
          { type: 'mrkdwn', text: `*Delta:*\n${sign}${params.deltaPercent.toFixed(1)}% (threshold: ${params.thresholdPct}%)` },
          { type: 'mrkdwn', text: `*Actual (OpenAI):*\n$${params.actualUsd.toFixed(4)}` },
          { type: 'mrkdwn', text: `*Estimated (internal):*\n$${params.estimatedUsd.toFixed(4)}` },
          { type: 'mrkdwn', text: `*Delta USD:*\n${sign}$${params.deltaUsd.toFixed(4)}` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Dashboard' },
            url: dashboardUrl,
          },
        ],
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function sendEmailAlert(toEmail: string, params: DiscrepancyAlertParams): Promise<void> {
  const dashboardUrl = getDashboardUrl();
  const sign = params.deltaUsd >= 0 ? '+' : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f8fafc;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <tr>
            <td align="center" style="background-color:#dc2626;padding:32px 40px;">
              <h1 style="margin:0;font-size:24px;font-weight:700;color:#ffffff;">Cost Discrepancy Alert</h1>
              <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">Azul Vision — Daily Reconciliation</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 24px;font-size:16px;color:#1f2937;line-height:1.6;">
                A cost discrepancy has been detected for <strong>${params.dateStr}</strong> that exceeds the configured threshold of <strong>${params.thresholdPct}%</strong>.
              </p>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px;">
                    <table role="presentation" border="0" cellpadding="8" cellspacing="0" width="100%">
                      <tr>
                        <td style="font-size:14px;color:#6b7280;font-weight:600;width:50%;">Date</td>
                        <td style="font-size:14px;color:#1f2937;font-weight:700;">${params.dateStr}</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px;color:#6b7280;font-weight:600;">Actual Cost (OpenAI)</td>
                        <td style="font-size:14px;color:#1f2937;font-weight:700;">$${params.actualUsd.toFixed(4)}</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px;color:#6b7280;font-weight:600;">Estimated Cost (internal)</td>
                        <td style="font-size:14px;color:#1f2937;font-weight:700;">$${params.estimatedUsd.toFixed(4)}</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px;color:#6b7280;font-weight:600;">Delta USD</td>
                        <td style="font-size:14px;color:#dc2626;font-weight:700;">${sign}$${params.deltaUsd.toFixed(4)}</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px;color:#6b7280;font-weight:600;">Delta %</td>
                        <td style="font-size:14px;color:#dc2626;font-weight:700;">${sign}${params.deltaPercent.toFixed(1)}%</td>
                      </tr>
                      <tr>
                        <td style="font-size:14px;color:#6b7280;font-weight:600;">Threshold</td>
                        <td style="font-size:14px;color:#1f2937;font-weight:700;">${params.thresholdPct}%</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0;">
                <tr>
                  <td align="center">
                    <a href="${dashboardUrl}" style="display:inline-block;padding:14px 36px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">View Dashboard</a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#6b7280;">
                This alert was generated automatically by the Azul Vision reconciliation service. 
                To adjust the alert threshold, set the <code>RECONCILIATION_ALERT_THRESHOLD_PCT</code> environment variable.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:24px 40px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:13px;color:#9ca3af;">&copy; ${new Date().getFullYear()} Azul Vision. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const success = await sendEmail({
    to: toEmail,
    subject: `[Alert] Cost Discrepancy Detected — ${params.dateStr} (${params.deltaPercent >= 0 ? '+' : ''}${params.deltaPercent.toFixed(1)}%)`,
    html,
  });

  if (!success) {
    throw new Error(`Email delivery failed for ${toEmail}`);
  }
}

export async function sendDiscrepancyAlert(params: DiscrepancyAlertParams): Promise<void> {
  const webhookUrl = process.env.RECONCILIATION_ALERT_WEBHOOK_URL?.trim();
  const alertEmail = process.env.RECONCILIATION_ALERT_EMAIL?.trim();

  if (!webhookUrl && !alertEmail) {
    console.info('[RECONCILIATION ALERT] No alert destination configured (RECONCILIATION_ALERT_WEBHOOK_URL or RECONCILIATION_ALERT_EMAIL). Skipping outbound alert.');
    return;
  }

  const errors: string[] = [];

  if (webhookUrl) {
    try {
      await sendSlackAlert(webhookUrl, params);
      console.info(`[RECONCILIATION ALERT] Slack alert sent for ${params.dateStr}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[RECONCILIATION ALERT] Failed to send Slack alert for ${params.dateStr}:`, msg);
      errors.push(`Slack: ${msg}`);
    }
  }

  if (alertEmail) {
    try {
      await sendEmailAlert(alertEmail, params);
      console.info(`[RECONCILIATION ALERT] Email alert sent to ${alertEmail} for ${params.dateStr}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[RECONCILIATION ALERT] Failed to send email alert for ${params.dateStr}:`, msg);
      errors.push(`Email: ${msg}`);
    }
  }

  if (errors.length > 0) {
    console.warn(`[RECONCILIATION ALERT] Some alert channels failed for ${params.dateStr}: ${errors.join('; ')}`);
  }
}
