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

/**
 * THE DEFECT THAT COST A DAY.
 *
 * `toZod` made every property `.nullable()` but never `.optional()`, so all
 * fifteen of file_surgery_ticket's landed in `required`. With `strict: true`
 * the SDK then demanded the model emit all fifteen keys. On four live calls it
 * emitted thirteen — omitting `callback_number` and `description_prefix` — and
 * the SDK rejected the arguments with "Invalid JSON input for tool" BEFORE
 * calling execute. No handler run, no log line, no timeline event, nothing
 * anywhere to see. The model received an error and told the caller the system
 * was having trouble.
 *
 * file_optical_ticket has twelve properties, the model emitted all twelve, and
 * Optical filed perfectly. That single difference is why one queue worked and
 * the other never did. Nothing was wrong with either tool.
 */
describe('a model may omit what it does not have', () => {
  it('reaches the handler with the exact arguments the live call sent', async () => {
    // Verbatim from the 2026-08-12 23:44 call: 13 of 15 keys.
    const liveArgs = {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: 'March 17, 1973',
      request_description: 'I need a refill for my combo drops',
      location: 'Loma Linda Surgery Center LLC',
      surgeon: 'Dwayne Logan, MD',
      request_reason_id: '529',
      surgery_date: null,
      urgent: null,
      email: null,
      call_sid: null,
      caller_phone: '+18455317471',
      dialed_number: null,
    };

    await import('./surgeryTools');
    const { realtimeToolsFor } = await import('./realtimeAdapter');
    const tool = realtimeToolsFor(['file_surgery_ticket'], { queue: 'surgery' })[0];

    const out = await callTool(tool as never, liveArgs);

    // The handler RAN and refused in words the agent can say — rather than the
    // SDK rejecting the call and the agent inventing a system failure.
    expect(out, 'the SDK rejected the arguments before the handler saw them').not.toMatch(
      /Invalid JSON input|An error occurred/,
    );
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.missingFields).toEqual(['callback_number']);
    expect(parsed.message).toMatch(/best number to reach you/i);
  });

  it('requires only what the tool actually needs, not every property', async () => {
    await import('./surgeryTools');
    const { realtimeToolsFor } = await import('./realtimeAdapter');
    const tool = realtimeToolsFor(['file_surgery_ticket'], {})[0] as unknown as {
      parameters: { properties: Record<string, unknown>; required?: string[] };
      strict?: boolean;
    };

    const props = Object.keys(tool.parameters.properties).length;
    const required = tool.parameters.required?.length ?? 0;
    expect(props).toBeGreaterThan(required);
    expect(
      tool.strict,
      'strict forces every property into required — the exact cause of the outage',
    ).toBe(false);
  });
});


/**
 * THE CALL KNOWS ITS OWN SID. THE MODEL DOES NOT GET A VOTE.
 *
 * Measured 2026-09-01 in the ticketing app's voice_agent_api_logs: 130
 * create-ticket POSTs from the surgery queue between 08-24 and today carried
 * `callData.callSid = "unknown"` — the literal string. Seven more from optical,
 * plus "none", "undefined", "N/A", "latest", "automated_xxx_placeholder".
 *
 * Every one of those calls has a real CA-prefixed CallSid on its call_logs row.
 * All 2,926 queue calls in the window do. The SID was never missing; it was
 * OVERWRITTEN — `call_sid` is a declared property on the filing tools ("The
 * call id, so a retry cannot double-file"), so the model emits it, and the
 * merge below put the model's arguments on top of the injected context.
 *
 * The cost is not cosmetic. The idempotency key is `call-${callSid}` guarded by
 * isTwilioCallSid, so a payload carrying "unknown" goes out with NO key: no
 * duplicate protection on a retry, no way for the post-call enrichment endpoint
 * to attach the recording and transcript, and — since 2026-09-01 — no key for
 * the outbox either. With a real SID, duplicate filing is 3 calls in 2,086
 * (0.14%). Without one it is unbounded.
 */
describe('injected call context outranks the model', () => {
  it('keeps the real CallSid when the model passes "unknown"', async () => {
    const { registerTool } = await import('./registry');
    const { realtimeToolsFor } = await import('./realtimeAdapter');
    registerTool({
      name: 'echo_context_test',
      description: 'test only',
      layer: 'agent',
      timeoutMs: 1000,
      input_schema: {
        type: 'object',
        properties: {
          call_sid: { type: 'string', description: 'the call id' },
          caller_phone: { type: 'string', description: 'the caller' },
          note: { type: 'string', description: 'anything' },
        },
        required: [],
      },
      handler: async (input: Record<string, unknown>) => ({ success: true, saw: input }),
    } as never);

    const tool = realtimeToolsFor(
      ['echo_context_test'],
      { call_sid: 'CA11111111111111111111111111111111', caller_phone: '+17605551234' },
    )[0] as never;

    const out = JSON.parse(
      await callTool(tool, {
        // What the model actually emits on the surgery line, 130 times in nine days.
        call_sid: 'unknown',
        caller_phone: 'N/A',
        note: 'the model may still say what it likes about its own fields',
      }),
    );

    expect(out.saw.call_sid).toBe('CA11111111111111111111111111111111');
    expect(out.saw.caller_phone).toBe('+17605551234');
    // The model's OWN arguments are untouched — this is not "the process wins
    // everything", it is "the process wins the fields it supplied".
    expect(out.saw.note).toMatch(/model may still say/);
  });

  it('does not blank a model argument the context has no value for', async () => {
    const { realtimeToolsFor } = await import('./realtimeAdapter');
    // caller_phone absent from the context — a call whose caller ID never
    // arrived. Overwriting the model's answer with undefined here would be the
    // same bug pointing the other way.
    const tool = realtimeToolsFor(
      ['echo_context_test'],
      { call_sid: 'CA22222222222222222222222222222222', caller_phone: undefined },
    )[0] as never;

    const out = JSON.parse(await callTool(tool, { caller_phone: '7605559999' }));
    expect(out.saw.caller_phone).toBe('7605559999');
    expect(out.saw.call_sid).toBe('CA22222222222222222222222222222222');
  });
});
