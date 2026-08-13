/**
 * The adapter's job is to make a tool call VISIBLE, not just to run it.
 *
 * Four consecutive live Surgery calls recorded three tool events and nothing
 * for the fourth. That reads exactly like "the tool was never called", and it
 * was not: the timeline reaches the database only when the call ends and
 * flushes, `file_surgery_ticket` has a 30s budget, and a caller who has just
 * been told there is a problem hangs up inside that window. The record died
 * with the call, every time, and cost most of a day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above every const in this file, so the spy has to be
// hoisted with it or the factory closes over a value in its temporal dead zone.
const { flushSpy } = vi.hoisted(() => ({
  flushSpy: vi.fn(async (_key: string) => {}),
}));

vi.mock('../services/toolTimeline', () => ({
  // Pass-through: this file is about the flush, not the recording.
  recordingExecute: (_ctx: unknown, _name: string, fn: (a: unknown) => Promise<string>) => fn,
  flushAzulTimeline: (key: string) => flushSpy(key),
}));

async function buildTool(telemetry?: Record<string, unknown>) {
  await import('./sharedPatientTools');
  await import('./surgeryTools');
  const { realtimeToolsFor } = await import('./realtimeAdapter');
  return realtimeToolsFor(['classify_surgery_request'], {}, telemetry as never)[0] as unknown as {
    invoke?: unknown;
    execute?: (input: unknown) => Promise<string>;
  };
}

/**
 * Call the tool the way the SDK does.
 *
 * The realtime `tool()` exposes `invoke(runContext, argumentsJson)` — a JSON
 * STRING, not an object — and swallows any throw into an "An error occurred"
 * string. Calling it with the wrong shape therefore looks like a tool failure
 * rather than a harness mistake, which is how this test first "failed".
 */
async function callTool(tool: Record<string, unknown>, args: unknown): Promise<string> {
  const invoke = tool.invoke as
    | ((ctx: unknown, argsJson: string) => Promise<string>)
    | undefined;
  const execute = tool.execute as ((input: unknown) => Promise<string>) | undefined;
  if (typeof invoke === 'function') return invoke({} as never, JSON.stringify(args));
  expect(execute, 'the built tool exposes no executor').toBeTypeOf('function');
  return execute!(args);
}

beforeEach(() => {
  flushSpy.mockClear();
});

describe('a tool call is persisted when it finishes, not when the call does', () => {
  it('flushes the timeline after the tool returns', async () => {
    const tool = await buildTool({ callId: 'rtc_test_1', agentSlug: 'surgery' });
    const out = await callTool(tool as never, {
      request_description: 'my surgery is Monday and the eye drops never came',
    });

    expect(JSON.parse(out).success).toBe(true);
    expect(
      flushSpy,
      'the tool completed but nothing was written — this is the state that hid the failure',
    ).toHaveBeenCalledWith('rtc_test_1');
  });

  it('falls back to the call sid when there is no call id', async () => {
    const tool = await buildTool({ callSid: 'CAtest', agentSlug: 'surgery' });
    await callTool(tool as never, { request_description: 'anything' });
    expect(flushSpy).toHaveBeenCalledWith('CAtest');
  });

  it('does not try to flush when there is no call to flush against', async () => {
    // The HTTP surface has no call. Flushing there would key on nothing.
    const tool = await buildTool(undefined);
    await callTool(tool as never, { request_description: 'anything' });
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('never lets a telemetry failure reach the call', async () => {
    // A patient's call must not break because a write failed.
    flushSpy.mockRejectedValueOnce(new Error('db is down'));
    const tool = await buildTool({ callId: 'rtc_test_2', agentSlug: 'surgery' });

    const out = await callTool(tool as never, {
      request_description: 'my surgery is Monday and the eye drops never came',
    });

    expect(JSON.parse(out).success).toBe(true);
  });
});
