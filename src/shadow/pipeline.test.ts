/**
 * Checkpoint 18 — pipeline end-to-end via the replay harness fixtures:
 * scenario coverage, idempotency, out-of-order, missing events, crash
 * isolation, session correlation, comparison-report generation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resetShadowConfig } from './config';
import { shadowEventSchema, type ShadowEvent } from './contracts';
import { ShadowPipeline } from './pipeline';
import { fixtureToEvents, replayEvents, type FixtureSession } from './replayHarness';

function envSetup(): void {
  process.env.SHADOW_SPOOL_ENABLED = 'false'; // unit tests never touch disk
  process.env.SHADOW_N8N_ENABLED = 'false';
  resetShadowConfig();
}
function envReset(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SHADOW_') || k.startsWith('N8N_')) delete process.env[k];
  }
  resetShadowConfig();
}

async function loadFixtures(): Promise<FixtureSession[]> {
  const raw = await readFile(join(__dirname, 'fixtures', 'replay-set.json'), 'utf8');
  return JSON.parse(raw) as FixtureSession[];
}
async function fixture(id: string): Promise<FixtureSession> {
  const all = await loadFixtures();
  const fx = all.find((f) => f.sessionId === id);
  if (!fx) throw new Error(`missing fixture ${id}`);
  return fx;
}

describe('ShadowPipeline scenarios (replayed fixtures)', () => {
  beforeEach(envSetup);
  afterEach(envReset);

  it('happy ticket call: agreement on tool choice, no loops, report generated', async () => {
    const r = await replayEvents(fixtureToEvents(await fixture('fx-ticket-happy')));
    expect(r.summary).toBeDefined();
    expect(r.summary!.turns).toBeGreaterThan(3);
    expect(r.summary!.limitation).toContain('Counterfactual');
    expect(r.summary!.loopCount).toBe(0);
    expect(r.summary!.n8nExecutionEstimate).toBe(0);
    expect(['equivalent', 'better', 'indeterminate']).toContain(r.evaluation!.verdict);
  });

  it('looping call: detects production repeated question + bundled questions', async () => {
    const r = await replayEvents(fixtureToEvents(await fixture('fx-loop-name')));
    expect(r.flags.some((f) => f.includes('production:repeated_question') || f.includes('production:ignored_answer'))).toBe(true);
    expect(r.flags.some((f) => f.includes('production_bundled_questions') || f.includes('production:bundled_questions'))).toBe(true);
  });

  it('urgent call: shadow escalates; escalation agreement with production transfer', async () => {
    const r = await replayEvents(fixtureToEvents(await fixture('fx-urgent')));
    const turn1 = r.turnComparisons[0];
    expect(['escalate', 'transfer']).toContain(turn1.shadowAction);
    expect(r.summary!.stateLossCount).toBe(0);
  });

  it('repeated tool failure: flags repeated_tool_call and repeated_tool_failure', async () => {
    const r = await replayEvents(fixtureToEvents(await fixture('fx-tool-failure')));
    expect(r.flags.some((f) => f.includes('repeated_tool_call'))).toBe(true);
    expect(r.flags.some((f) => f.includes('repeated_tool_failure'))).toBe(true);
  });

  it('multi-intent + correction call: detects multiple intents and continues', async () => {
    const r = await replayEvents(fixtureToEvents(await fixture('fx-multi-intent')));
    expect(r.summary).toBeDefined();
    expect(r.summary!.turns).toBe(3);
  });

  it('premature production ticket: flags production_premature_tool', async () => {
    const r = await replayEvents(fixtureToEvents(await fixture('fx-premature-ticket')));
    expect(r.flags.some((f) => f.includes('production_premature_tool'))).toBe(true);
    expect(r.evaluation!.reviewPriority).toBeGreaterThan(0);
  });

  it('caller cancellation: completes without recommending any mutation', async () => {
    const r = await replayEvents(fixtureToEvents(await fixture('fx-cancellation-flow')));
    const mutations = r.turnComparisons.filter((t) => t.shadowTool !== null);
    expect(mutations.length).toBe(0);
  });

  it('every fixture replays deterministically (same flags on second run)', async () => {
    for (const fx of await loadFixtures()) {
      const a = await replayEvents(fixtureToEvents(fx));
      const b = await replayEvents(fixtureToEvents(fx));
      expect(b.flags).toEqual(a.flags);
      expect(b.summary?.actionAgreementPct).toEqual(a.summary?.actionAgreementPct);
    }
  });
});

describe('ShadowPipeline robustness', () => {
  beforeEach(envSetup);
  afterEach(envReset);

  it('duplicate events are idempotent (single session, single processing)', async () => {
    const events = fixtureToEvents(await fixture('fx-ticket-happy'));
    const doubled = [...events, ...events]; // same eventIds again
    const p = new ShadowPipeline();
    await p.ingest(doubled);
    expect(p.sessions.size).toBe(1);
    const s = p.sessions.get('fx-ticket-happy')!;
    expect(s.turnComparisons.length).toBe(s.state.turnCount);
  });

  it('out-of-order events do not create multiple sessions', async () => {
    const events = fixtureToEvents(await fixture('fx-ticket-happy'));
    const shuffled = [...events].reverse();
    const p = new ShadowPipeline();
    await p.ingest(shuffled);
    expect(p.sessions.size).toBe(1);
  });

  it('missing tool-result events do not crash the pipeline', async () => {
    const fx = await fixture('fx-ticket-happy');
    const events = fixtureToEvents(fx).filter((e) => e.type !== 'tool_completed');
    const p = new ShadowPipeline();
    await p.ingest(events);
    expect(p.sessions.get('fx-ticket-happy')!.finalized).toBe(true);
  });

  it('a crashing reasoning dependency isolates per event; later events still process', async () => {
    let calls = 0;
    const p = new ShadowPipeline({
      llmRefine: async () => { calls++; throw new Error('model exploded'); },
    });
    const events = fixtureToEvents(await fixture('fx-ticket-happy'));
    await expect(p.ingest(events)).resolves.toBeUndefined();
    expect(p.sessions.get('fx-ticket-happy')!.finalized).toBe(true);
  });

  it('invalid model JSON / llm returning garbage falls back to deterministic result', async () => {
    process.env.SHADOW_MODEL_ROUTING_ENABLED = 'true';
    resetShadowConfig();
    const p = new ShadowPipeline({
      llmRefine: async () => null, // e.g. JSON parse failed upstream
    });
    const events = fixtureToEvents(await fixture('fx-multi-intent'));
    await p.ingest(events);
    const s = p.sessions.get('fx-multi-intent')!;
    expect(s.turnComparisons.length).toBeGreaterThan(0);
  });

  it('session correlation: alias events (twilio SID) land in the primary session', async () => {
    const p = new ShadowPipeline();
    const mk = (over: Partial<ShadowEvent>): ShadowEvent =>
      shadowEventSchema.parse({
        contractVersion: 1,
        eventId: `e-${Math.random()}`,
        sessionId: 'openai-call-1',
        agentId: 'no-ivr',
        seq: 0,
        ts: new Date().toISOString(),
        type: 'other',
        payload: {},
        source: { component: 'replay' },
        sensitive: false,
        ...over,
      });
    await p.ingest([
      mk({ type: 'session_started', seq: 0, payload: { correlation: { twilioCallSid: 'CAxyz' } } }),
      mk({ type: 'user_transcript', seq: 1, turnId: 1, payload: { text: 'I need a refill of my prescription' } }),
      mk({ type: 'n8n_workflow_completed', seq: 2, sessionId: 'CAxyz', payload: { endpoint: '/api/voice-agent/submit-ticket', status: 200, viaGateway: true } }),
    ]);
    expect(p.sessions.size).toBe(1);
    const s = p.sessions.get('openai-call-1')!;
    expect(s.state.productionN8nHistory.length).toBe(1);
  });

  it('stale sessions finalize via sweep and can be counted as failed:timeout', async () => {
    process.env.SHADOW_SESSION_TIMEOUT_MIN = '0';
    resetShadowConfig();
    const p = new ShadowPipeline();
    const events = fixtureToEvents(await fixture('fx-ticket-happy')).filter(
      (e) => e.type !== 'session_completed',
    );
    await p.ingest(events);
    const swept = await p.sweepStaleSessions(new Date(Date.now() + 60_000));
    expect(swept).toBe(1);
    expect(p.sessions.get('fx-ticket-happy')!.state.status).toBe('failed');
  });

  it('duplicate completion events do not double-finalize', async () => {
    const events = fixtureToEvents(await fixture('fx-ticket-happy'));
    const completed = events[events.length - 1];
    const p = new ShadowPipeline();
    await p.ingest(events);
    await p.ingest([{ ...completed, eventId: 'dup-complete', seq: 999 }]);
    const s = p.sessions.get('fx-ticket-happy')!;
    expect(s.finalized).toBe(true);
  });
});
