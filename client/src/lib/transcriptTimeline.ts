/**
 * client/src/lib/transcriptTimeline.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A TOOL CALL PLACED IN THE CONVERSATION AT THE MOMENT IT HAPPENED.
 *
 * The shape of xAI's own call log, where `lookup_patient` sits between the
 * two lines it ran between. Our `tool_timeline` records the END of each call
 * (`at`) and how long it took (`ms`), so the chip is placed at its START —
 * a 6,000ms `lookup_patient` that finished at 12:00:10 began at 12:00:04, and
 * that is where a reader expects to find it.
 *
 * Pure, so the Observatory's page can be tested without a DOM: the page hands
 * in the timeline events and its timed turn rows and renders what comes back.
 */

export interface ToolChip {
  kind: 'tool'
  /** The START of the call, epoch ms. */
  atMs: number
  tool: string
  ms: number | null
  ok: boolean
  outcome: Record<string, unknown> | null
  args: Record<string, unknown> | null
}

export interface TimedTurn {
  kind: 'turn'
  role: 'caller' | 'agent'
  text: string
  /** ISO time the line was written; absent on a flat-transcript fallback. */
  at?: string
}

/** A timeline event as `call_logs.tool_timeline.events[]` stores it. */
export interface TimelineEvent {
  at?: unknown
  ms?: unknown
  tool?: unknown
  name?: unknown
  outcome?: { success?: unknown; [k: string]: unknown } | null
  args?: Record<string, unknown> | null
}

export function toolChipsFrom(events: TimelineEvent[] | null | undefined): ToolChip[] {
  return (events ?? [])
    .filter((e) => typeof e.at === 'string' && !Number.isNaN(new Date(e.at).getTime()))
    .map((e) => {
      const ms = e.ms != null && !Number.isNaN(Number(e.ms)) ? Number(e.ms) : null
      return {
        kind: 'tool' as const,
        atMs: new Date(e.at as string).getTime() - (ms ?? 0),
        tool: String(e.tool ?? e.name ?? 'tool'),
        ms,
        // A tool that THREW is recorded as `{ error }` with no `success` key
        // (recordingExecute), and a cancelled dispatch as `{ cancelled }`;
        // neither is a success (Codex P2, #321 round 5).
        ok: e.outcome?.success !== false && e.outcome?.error == null && e.outcome?.cancelled !== true,
        outcome: e.outcome ?? null,
        args: e.args ?? null,
      }
    })
}

/**
 * Tool calls only interleave when EVERY turn carries a time: a flat-transcript
 * fallback has no clock to place them on, so they stay on the Logs tab and
 * the rows come back untouched. Stable on ties — a chip at exactly a line's
 * time goes AFTER the line it followed, and two chips keep their timeline
 * order.
 */
export function interleave<T extends TimedTurn>(turnRows: T[], chips: ToolChip[]): Array<T | ToolChip> {
  const timed = turnRows.length > 0 && turnRows.every((r) => !!r.at)
  if (!timed || chips.length === 0) return turnRows
  const merged: Array<T | ToolChip> = [...turnRows, ...chips]
  const timeOf = (r: T | ToolChip) => (r.kind === 'tool' ? r.atMs : new Date(r.at!).getTime())
  return merged
    .map((r, i) => ({ r, i, t: timeOf(r), tie: r.kind === 'tool' ? 1 : 0 }))
    .sort((a, b) => a.t - b.t || a.tie - b.tie || a.i - b.i)
    .map((x) => x.r)
}
