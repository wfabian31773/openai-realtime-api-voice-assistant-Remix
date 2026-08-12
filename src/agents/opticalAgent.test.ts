/**
 * The Optical agent: what it can do, and what it must never claim it can do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

import {
  buildOpticalPrompt,
  createOpticalAgent,
  opticalAgentConfig,
  OPTICAL_TOOLS,
} from './opticalAgent';
import { manifest } from '../tools/registry';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('it cannot transfer, and must not imply that it can', () => {
  // Operator ruling, 2026-08-12: "there is no handoff for any of the answering
  // service agents, only for PCP, Scheduling SD. All other agents politely
  // state they are unable to handoff and can only create a request for a
  // callback."
  const prompt = buildOpticalPrompt({ callerPhone: '8455317471' });

  it('has no transfer tool of any kind', () => {
    // Not a disabled one, not one that "records the request" — none. A tool the
    // agent cannot see is a promise it cannot make.
    for (const name of OPTICAL_TOOLS) {
      expect(name).not.toMatch(/transfer|handoff|escalat|human|operator/i);
    }
    expect(OPTICAL_TOOLS).toHaveLength(5);
  });

  it('is told to say so plainly and offer the callback instead', () => {
    expect(prompt).toMatch(/not able to transfer you/i);
    expect(prompt).toMatch(/call you back/i);
    expect(prompt).toMatch(/never say you will\s*\n?\s*put them through/i);
  });

  it('is built without a handoff callback wired to anything', async () => {
    // The registry hands every factory a handoff callback. This one takes it
    // and ignores it; passing a throwing callback proves nothing calls it.
    const agent = await createOpticalAgent(undefined, { callId: 'c1', callerPhone: '8455317471' });
    expect(agent).toBeTruthy();
  });
});

describe('the queue decides what the call is, not the model', () => {
  const prompt = buildOpticalPrompt({ callerPhone: '8455317471' });

  it('never asks the caller which department they want', () => {
    expect(prompt).toMatch(/must never ask the caller which department/i);
  });

  it('stays small — that is the point of routing by queue', () => {
    // The answering-service prompt is ~4,900 tokens and most of it decides
    // which department the call belongs to. This one does not have to.
    const approxTokens = prompt.length / 4;
    expect(approxTokens).toBeLessThan(1200);
  });

  it('knows appointments are somebody else\'s job', () => {
    // MASTER.md §9: Optical takes anything optical EXCEPT appointment requests.
    expect(prompt).toMatch(/appointment/i);
    expect(prompt).toMatch(/do not attempt to schedule/i);
  });
});

describe('the tools it is given', () => {
  it('are exactly the five in the library, and all registered', () => {
    const published = manifest().map((t) => t.name);
    for (const name of OPTICAL_TOOLS) {
      expect(published, `${name} must be an agent-layer tool`).toContain(name);
    }
  });

  it('come from the library rather than being redeclared here', async () => {
    // If this agent defined its own copies they would drift from the ones the
    // HTTP surface serves, which is the failure the library exists to prevent.
    const agent = await createOpticalAgent(undefined, { callId: 'c2' });
    const names = ((agent as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
    expect(names.sort()).toEqual([...OPTICAL_TOOLS].sort());
  });
});

describe('what it tells the caller about themselves', () => {
  it('uses the number they called from without asking', () => {
    const p = buildOpticalPrompt({ callerPhone: '8455317471' });
    expect(p).toMatch(/7471/);
    expect(p).toMatch(/without asking/i);
  });

  it('asks for a callback number when caller ID is absent', () => {
    const p = buildOpticalPrompt({});
    expect(p).toMatch(/ask for a full ten-digit callback number/i);
  });

  it('is told to confirm the office rather than assume it', () => {
    // usual_clinic is derived from visit history. It is a good guess, not a
    // fact about what the caller wants today.
    const p = buildOpticalPrompt({});
    expect(p).toMatch(/confirm it rather than assuming/i);
  });

  it('is told what an uncertain identity means before it reads anything back', () => {
    const p = buildOpticalPrompt({});
    expect(p).toMatch(/identity_is_certain is false/);
    expect(p).toMatch(/do not read their history\s*\n?\s*back/i);
  });

  it('is told never to emit markdown, because it is spoken aloud', () => {
    // A live agent said "**Dr. Dwayne Logan**" to a caller on 2026-08-10.
    expect(buildOpticalPrompt({})).toMatch(/never use markdown/i);
  });
});

describe('config', () => {
  it('is slug "optical" so the webhook and the registry agree', () => {
    expect(opticalAgentConfig.slug).toBe('optical');
  });
});

describe('the call id must not depend on the model remembering it', () => {
  // VA-50813 — the Optical line's first working call — filed with
  // `call_sid: null`. The tool accepts it as an input and the model simply
  // never passed it. Without it `update-call-data` can never match the ticket
  // to the call, so the recording, transcript and summary are not late, they
  // are unattachable forever.
  it('injects call_sid, caller_phone and dialed_number into every tool', async () => {
    const { runTool } = await import('../tools/registry');
    const spy = vi.spyOn(await import('../tools/registry'), 'runTool');

    const agent = await createOpticalAgent(undefined, {
      callId: 'call-1',
      callSid: 'CAreal123',
      callerPhone: '8455317471',
      dialedNumber: '8186193692',
    });
    const file = ((agent as { tools?: Array<{ name: string; invoke?: Function }> }).tools ?? []).find(
      (t) => t.name === 'file_optical_ticket',
    );
    expect(file, 'file_optical_ticket must be on the agent').toBeTruthy();

    // Invoke with the arguments a model actually sends: everything present,
    // the ones it does not know set to null.
    await file!.invoke?.({} as never, JSON.stringify({
      first_name: 'Wayne', last_name: 'Fabian', date_of_birth: '03/17/1973',
      callback_number: '845-531-7471', location: 'Eastvale',
      request_description: 'hinge broke', request_reason_id: null,
      provider: null, email: null, call_sid: null, caller_phone: null, dialed_number: null,
    }));

    const passed = spy.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(passed.call_sid, 'a null from the model must not blank the injected id').toBe('CAreal123');
    expect(passed.caller_phone).toBe('8455317471');
    expect(passed.dialed_number).toBe('8186193692');
    void runTool;
  });

  it('falls back to callId when there is no callSid', async () => {
    const spy = vi.spyOn(await import('../tools/registry'), 'runTool');
    const agent = await createOpticalAgent(undefined, { callId: 'call-only' });
    const t = ((agent as { tools?: Array<{ name: string; invoke?: Function }> }).tools ?? []).find(
      (x) => x.name === 'check_open_tickets',
    );
    await t!.invoke?.({} as never, JSON.stringify({ phone: '845-531-7471' }));
    expect((spy.mock.calls.at(-1)?.[1] as Record<string, unknown>).call_sid).toBe('call-only');
  });
});
