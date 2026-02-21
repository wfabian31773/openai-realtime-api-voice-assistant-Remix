import { redactPHI } from './phiSanitizer';

export function sanitizeCallLogForExport(callLog: any): any {
  if (!callLog) return callLog;

  const sanitized = { ...callLog };

  if (sanitized.from) {
    sanitized.from = sanitized.from.replace(/^(.*)(\d{4})$/, '***$2');
  }
  if (sanitized.to) {
    sanitized.to = sanitized.to.replace(/^(.*)(\d{4})$/, '***$2');
  }
  if (sanitized.callerNumber) {
    sanitized.callerNumber = sanitized.callerNumber.replace(/^(.*)(\d{4})$/, '***$2');
  }

  if (sanitized.transcript) {
    sanitized.transcript = redactPHI(sanitized.transcript);
  }

  if (sanitized.graderResults?.graders) {
    sanitized.graderResults = {
      ...sanitized.graderResults,
      graders: sanitized.graderResults.graders.map((g: any) => ({
        ...g,
        reason: g.reason ? redactPHI(g.reason) : g.reason,
        metadata: g.metadata ? JSON.parse(redactPHI(JSON.stringify(g.metadata))) : g.metadata,
      })),
    };
  }

  if (sanitized.qualityAnalysis) {
    sanitized.qualityAnalysis = { redacted: true, score: sanitized.qualityScore };
  }

  return sanitized;
}

export function sanitizeCallLogsForExport(callLogs: any[]): any[] {
  return callLogs.map(sanitizeCallLogForExport);
}
