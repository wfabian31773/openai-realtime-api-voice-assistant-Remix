/**
 * The call page's Tool calls tab (v238): what each tool was given and what it
 * answered, read from `/api/call-logs/:id/tool-payloads` (admin-only). Pure
 * helpers, so the reading rules are testable without a DOM.
 */

export interface ToolPayloadView {
  seq: number
  tool: string
  eventAt: string
  ms: number | null
  args: unknown
  result: unknown
}

export type PayloadVerdict = 'ok' | 'refused' | 'error' | 'unknown'

/**
 * How the tool answered, read from its own result. `success: false` with a
 * named refusal or missing fields is a REFUSAL (the tool said no and why);
 * any other `success: false`, or an `error`, is an ERROR.
 */
export function payloadVerdict(result: unknown): PayloadVerdict {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown'
  const r = ((result as any).result ?? result) as Record<string, unknown>
  if (r.error != null && r.success !== true) return 'error'
  if (r.success === true) return 'ok'
  if (r.success === false) {
    const missing = Array.isArray(r.missingFields) && r.missingFields.length > 0
    return r.refused != null || missing ? 'refused' : 'error'
  }
  return 'unknown'
}

/** The text a reader sees for one half. A capped half shows its kept text. */
export function prettyJson(value: unknown): string {
  if (value && typeof value === 'object' && (value as any).truncated === true && typeof (value as any).text === 'string') {
    return `${(value as any).text}\n… cut at the store's cap (${(value as any).chars} characters in all)`
  }
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

/** A row matches when the tool name or either half contains the text, case ignored. */
export function matchesFilter(p: ToolPayloadView, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  if (p.tool.toLowerCase().includes(needle)) return true
  return `${prettyJson(p.args)}\n${prettyJson(p.result)}`.toLowerCase().includes(needle)
}

/** The reason the tab is empty, in the reader's words. */
export function emptyLabel(status: 'forbidden' | 'none' | 'error', retentionDays: number): string {
  if (status === 'forbidden') return 'Full tool arguments are visible to admins only.'
  if (status === 'error') return 'The stored tool arguments could not be read. Try again in a moment.'
  return `No tool arguments are stored for this call. They are kept for ${retentionDays} days, for calls from v238 on.`
}
