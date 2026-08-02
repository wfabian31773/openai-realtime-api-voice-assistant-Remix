/**
 * Historical replay harness (Checkpoint 19).
 *
 * Ingests a recorded session (spool JSONL, fixture JSON, or a production
 * call_logs-style transcript converted to events), feeds the SAME events
 * through a fresh pipeline, and emits turn-by-turn comparisons + a session
 * summary. Only de-identified/approved records may be committed as fixtures.
 *
 * CLI: npx tsx src/shadow/replayHarness.ts <file.json|file.jsonl> [--agent slug]
 */
import { readFile } from 'fs/promises';
import { shadowEventSchema, type ShadowEvent } from './contracts';
import { ShadowPipeline, type SessionRecord } from './pipeline';
import type { SessionComparisonSummary } from './comparison';
import type { SessionEvaluation } from './evaluation';

export interface ReplayResult {
  sessionId: string;
  agentId: string;
  summary: SessionComparisonSummary | undefined;
  evaluation: SessionEvaluation | undefined;
  flags: string[];
  turnComparisons: SessionRecord['turnComparisons'];
}

export interface FixtureSession {
  sessionId: string;
  agentId: string;
  /** Simplified authoring format for fixtures. */
  turns: Array<
    | { caller: string }
    | { agent: string }
    | { tool: string; args?: Record<string, unknown>; result?: unknown; failed?: boolean; ms?: number }
    | { n8n: string; status?: number; body?: Record<string, unknown> }
  >;
  outcome?: string;
}

let replaySeq = 0;
function ev(
  sessionId: string,
  agentId: string,
  type: ShadowEvent['type'],
  payload: Record<string, unknown>,
  sensitive = false,
): ShadowEvent {
  return shadowEventSchema.parse({
    contractVersion: 1,
    eventId: `replay-${sessionId}-${replaySeq}`,
    sessionId,
    agentId,
    seq: replaySeq++,
    ts: new Date(1700000000000 + replaySeq * 1000).toISOString(),
    type,
    payload,
    source: { component: 'replay' },
    sensitive,
  });
}

/** Convert the human-authorable fixture format into normalized events. */
export function fixtureToEvents(fx: FixtureSession): ShadowEvent[] {
  const events: ShadowEvent[] = [ev(fx.sessionId, fx.agentId, 'session_started', {})];
  for (const turn of fx.turns) {
    if ('caller' in turn) {
      events.push(ev(fx.sessionId, fx.agentId, 'user_transcript', { text: turn.caller }, true));
    } else if ('agent' in turn) {
      events.push(ev(fx.sessionId, fx.agentId, 'assistant_transcript', { text: turn.agent }, true));
    } else if ('tool' in turn) {
      events.push(
        ev(fx.sessionId, fx.agentId, turn.failed ? 'tool_failed' : 'tool_completed', {
          tool: turn.tool,
          args: turn.args ?? {},
          outcome: turn.result ?? (turn.failed ? { error: 'failed' } : { ok: true }),
          ms: turn.ms ?? 100,
        }, true),
      );
    } else if ('n8n' in turn) {
      events.push(
        ev(fx.sessionId, fx.agentId, (turn.status ?? 200) < 400 ? 'n8n_workflow_completed' : 'n8n_workflow_failed', {
          endpoint: turn.n8n,
          status: turn.status ?? 200,
          viaGateway: true,
          body: turn.body ?? {},
        }, true),
      );
    }
  }
  events.push(ev(fx.sessionId, fx.agentId, 'session_completed', { status: fx.outcome ?? 'completed' }));
  // Turn ids: assign user-turn ordinals like the live tap does.
  let turnId = 0;
  for (const e of events) {
    if (e.type === 'user_transcript') turnId++;
    e.turnId = turnId;
  }
  return events;
}

export async function replayEvents(events: ShadowEvent[]): Promise<ReplayResult> {
  const pipeline = new ShadowPipeline();
  await pipeline.ingest(events);
  const sessionId = events[0]?.sessionId ?? 'unknown';
  const s = pipeline.sessions.get(sessionId);
  const flags: string[] = [];
  if (s) {
    for (const sig of s.loopDetector.signals) flags.push(`${sig.source}:${sig.loopType}:${sig.affectedState}`);
    for (const t of s.turnComparisons) for (const c of t.disagreementCodes) flags.push(`turn${t.turn}:${c}`);
  }
  return {
    sessionId,
    agentId: events[0]?.agentId ?? 'unknown',
    summary: s?.summary,
    evaluation: s?.evaluation,
    flags: [...new Set(flags)],
    turnComparisons: s?.turnComparisons ?? [],
  };
}

export async function replayFixtureFile(path: string): Promise<ReplayResult[]> {
  const raw = await readFile(path, 'utf8');
  const results: ReplayResult[] = [];
  if (path.endsWith('.jsonl')) {
    // Spool format: one session record per line with {events: [...]}.
    for (const line of raw.split('\n').filter(Boolean)) {
      const rec = JSON.parse(line) as { events?: unknown[] };
      if (!rec.events) continue;
      const events = (rec.events as unknown[])
        .map((e) => shadowEventSchema.safeParse(e))
        .filter((p): p is { success: true; data: ShadowEvent } => p.success)
        .map((p) => p.data);
      results.push(await replayEvents(events));
    }
  } else {
    const parsed = JSON.parse(raw) as FixtureSession | FixtureSession[];
    const fixtures = Array.isArray(parsed) ? parsed : [parsed];
    for (const fx of fixtures) results.push(await replayEvents(fixtureToEvents(fx)));
  }
  return results;
}

// CLI entry
const isMain = process.argv[1]?.endsWith('replayHarness.ts');
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npx tsx src/shadow/replayHarness.ts <fixture.json|spool.jsonl>');
    process.exit(2);
  }
  replayFixtureFile(file)
    .then((results) => {
      for (const r of results) {
        console.log(JSON.stringify({
          sessionId: r.sessionId,
          agentId: r.agentId,
          verdict: r.evaluation?.verdict,
          actionAgreementPct: r.summary?.actionAgreementPct,
          toolAgreementPct: r.summary?.toolAgreementPct,
          loops: r.summary?.loopCount,
          flags: r.flags,
          limitation: r.summary?.limitation,
        }, null, 2));
      }
    })
    .catch((err) => {
      console.error('replay failed:', err);
      process.exit(1);
    });
}
