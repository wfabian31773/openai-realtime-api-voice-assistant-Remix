/**
 * A TICKET NEEDS THREE THINGS, AND A CALLER CAN NEVER LOSE THEIR REQUEST.
 *
 * Operator, 2026-08-17: *"we should not be filing tickets in 27 seconds... we
 * should not create a ticket unless we have enough information to do so, a
 * ticket should be blocked without required fields."* And on which fields:
 * *"the most important parts of a ticket are who is calling, who is the call
 * about and how do we contact you."*
 *
 * Blocking was tried before and it destroyed requests — `e0384db1` burned ten
 * tool calls on `callbackNumber`, `e761053a` five on `callerName`, and 21
 * medical-records requests reached this line on 2026-08-06 with nothing filed
 * behind them. So the tests that matter most here are not the ones proving a
 * ticket blocks. They are the ones proving it eventually goes through anyway.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ticketReadiness,
  nextRequiredAsk,
  annotationFor,
  MAX_BLOCKS,
  type RequiredField,
} from './ticketRequirements';
import type { PcpConversationState } from './director';

const base = (over: Partial<PcpConversationState> = {}): PcpConversationState => ({
  verificationStatus: 'pending',
  toolFailures: {},
  completedTools: [],
  ...over,
});

const complete = base({
  callPurpose: 'peer_to_peer',
  callerName: 'Dr Chen office',
  patientFirstName: 'Wayne',
  patientLastName: 'Fabian',
  callbackNumber: '+18455317471',
});

describe('the three questions, and only those three', () => {
  it('a complete intake is ready', () => {
    const r = ticketReadiness(complete);
    expect(r.ready).toBe(true);
    expect(r.blocking).toEqual([]);
  });

  it('blocks on who is calling', () => {
    const r = ticketReadiness(base({ ...complete, callerName: undefined }));
    expect(r.blocking).toContain('callerName');
  });

  it('blocks on who the call is about', () => {
    const r = ticketReadiness(base({ ...complete, patientFirstName: undefined, patientLastName: undefined }));
    expect(r.blocking).toContain('patientName');
  });

  it('blocks on how to reach them', () => {
    const r = ticketReadiness(base({ ...complete, callbackNumber: undefined }));
    expect(r.blocking).toContain('callbackNumber');
  });

  it('does NOT block on role, organisation, facility type or date of birth', () => {
    /**
     * The operator's list is three items long. A staffer can work without a job
     * title; holding a request for one is what produced ten refusals on a
     * single call in August.
     */
    const r = ticketReadiness(base({
      ...complete,
      callerRole: undefined,
      callerOrganization: undefined,
      callerFacilityType: undefined,
      patientDob: undefined,
    }));
    expect(r.ready).toBe(true);
  });
});

describe('a patient calling about themselves is not interrogated', () => {
  it("their own name answers 'who is the call about'", () => {
    // Asking someone ringing about their own eye drops for "the patient's
    // name" is the interrogation this line keeps being corrected for.
    const r = ticketReadiness(base({
      callPurpose: 'patient_caller',
      callerName: 'Bernice Capuano',
      callbackNumber: '+16265550857',
    }));
    expect(r.ready).toBe(true);
  });

  it('but a professional still has to say who the patient is', () => {
    const r = ticketReadiness(base({
      callPurpose: 'peer_to_peer',
      callerName: 'Dr Chen office',
      callbackNumber: '+18455317471',
    }));
    expect(r.blocking).toContain('patientName');
  });
});

describe('THE FLOOR — a stubborn caller cannot lose their request', () => {
  it('holds the ticket up to MAX_BLOCKS times, then files', () => {
    const state = base({ ...complete, callerName: undefined });
    expect(ticketReadiness(state, 0).blocking).toContain('callerName');
    expect(ticketReadiness(state, MAX_BLOCKS - 1).blocking).toContain('callerName');
    // Budget spent: annotated, not blocked.
    const done = ticketReadiness(state, MAX_BLOCKS);
    expect(done.blocking).toEqual([]);
    expect(done.annotate).toContain('callerName');
    expect(done.ready).toBe(true);
  });

  it('a caller who answers NOTHING still gets a ticket', () => {
    // The 08-06 shape, directly: every required field absent, budget spent.
    const nothing = base({ callPurpose: 'peer_to_peer' });
    const r = ticketReadiness(nothing, MAX_BLOCKS);
    expect(r.ready, 'a fully uncooperative call must still file').toBe(true);
    expect(r.blocking).toEqual([]);
    expect([...r.annotate].sort()).toEqual(['callbackNumber', 'callerName', 'patientName']);
  });

  /**
   * WHY THE BUDGET IS THE CONVERSATION'S, NOT THE FIELD'S.
   *
   * A per-field budget was the first design and it is wrong. Three fields at
   * two strikes each is FIVE refusals before a ticket goes through, which is
   * the shape of e0384db1 — ten tool calls, all refused, caller told there was
   * "an issue recording". The caller does not experience "two strikes on
   * callerName"; they experience being asked over and over.
   */
  it('the budget counts the whole call, not each field', () => {
    const nothing = base({ callPurpose: 'peer_to_peer' });
    // Three fields missing, but the third block ends it for ALL of them.
    expect(ticketReadiness(nothing, MAX_BLOCKS - 1).ready).toBe(false);
    expect(ticketReadiness(nothing, MAX_BLOCKS).ready).toBe(true);
  });

  it('is three — enough to ask, not enough to interrogate', () => {
    expect(MAX_BLOCKS).toBe(3);
  });
});

describe('one question at a time', () => {
  it('asks for the first missing field only', () => {
    const r = ticketReadiness(base({ callPurpose: 'peer_to_peer' }));
    const ask = nextRequiredAsk(r);
    expect(ask?.field).toBe('callerName');
    expect(r.blocking.length).toBeGreaterThan(1); // more missing, but one ask
  });

  it('returns nothing to ask when ready', () => {
    expect(nextRequiredAsk(ticketReadiness(complete))).toBeNull();
  });

  it('every ask is a real sentence a caller can answer', () => {
    for (const field of ['callerName', 'patientName', 'callbackNumber'] as RequiredField[]) {
      const ask = nextRequiredAsk({ blocking: [field], annotate: [], ready: false });
      expect(ask?.prompt).toMatch(/\?$/);
      expect(ask?.prompt, 'must not name the field to the caller').not.toMatch(/callerName|patientName|callbackNumber/);
    }
  });
});

describe('a gap on a filed ticket says it is a gap', () => {
  it('names what was not captured', () => {
    const note = annotationFor(['callerName', 'callbackNumber']);
    expect(note).toMatch(/NOT CAPTURED/);
    expect(note).toMatch(/caller's name/);
    expect(note).toMatch(/callback number/);
  });

  it('says the caller was asked, so a blank is not read as an answer', () => {
    expect(annotationFor(['patientName'])).toMatch(/was asked and did not provide/);
  });

  it('is absent when nothing is missing', () => {
    expect(annotationFor([])).toBeUndefined();
  });
});

describe('the hangup fallback', () => {
  const src = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('exists and runs on PCP teardown only', () => {
    const routes = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');
    expect(code).toMatch(/export async function sweepPcpUnfiledCall/);
    expect(routes).toMatch(/agentConfig\?\.id === 'pcp'/);
    expect(routes).toMatch(/sweepPcpUnfiledCall\(callId\)/);
  });

  it('is bounded, like azul\'s', () => {
    // A wedged sweep must never block the timeline flush (2026-07-24).
    // Anchor on the sweep import — `id === 'pcp'` also appears earlier in the
    // file for the no-dead-air heartbeat.
    const routes = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');
    const at = routes.indexOf('sweepPcpUnfiledCall');
    expect(at, 'the sweep wiring moved').toBeGreaterThan(-1);
    const block = routes.slice(at, at + 300);
    expect(block).toMatch(/25_000/);
  });

  it('does nothing when something durable was already recorded', () => {
    const fn = code.slice(code.indexOf('export async function sweepPcpUnfiledCall'));
    expect(fn).toMatch(/if \(state\.dispositionRecorded\) return/);
  });

  it('refuses to file for a ghost call', () => {
    /**
     * azul's equivalent sweep put ~30 false "call them back" tickets into the
     * staff queue in two hours on 2026-07-30 by running for every call. The
     * gate here needs a purpose AND some identity.
     */
    const fn = code.slice(code.indexOf('export async function sweepPcpUnfiledCall'));
    expect(fn).toMatch(/const toldUsSomething = Boolean\(/);
    expect(fn).toMatch(/state\.callPurpose &&/);
    expect(fn).toMatch(/state\.callerName \|\| state\.patientFirstName/);
  });

  it('does not count the seeded callback number as evidence a caller spoke', () => {
    // callbackNumber is seeded from caller ID before anyone says a word, so it
    // is present on a silent call too — using it here would file for ghosts.
    const fn = code.slice(code.indexOf('export async function sweepPcpUnfiledCall'), code.indexOf('} catch (e) {'));
    const gate = fn.slice(fn.indexOf('toldUsSomething'), fn.indexOf('if (!toldUsSomething)'));
    expect(gate).not.toMatch(/callbackNumber/);
  });

  it('marks the ticket as an incomplete call, not a normal one', () => {
    const fn = code.slice(code.indexOf('export async function sweepPcpUnfiledCall'));
    expect(fn).toMatch(/CALLER HUNG UP BEFORE THE REQUEST WAS COMPLETE/);
    expect(fn).toMatch(/caller_hung_up_before_completion/);
  });

  it('never throws — the call is already over', () => {
    const fn = code.slice(code.indexOf('export async function sweepPcpUnfiledCall'));
    expect(fn).toMatch(/catch \(e\) \{/);
    expect(fn).toMatch(/finally \{/);
  });
});

describe('the tools actually enforce it', () => {
  const src = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8');

  it('create_pcp_task blocks and counts strikes', () => {
    const at = src.indexOf("name: 'create_pcp_task'");
    const block = src.slice(at, at + 3000);
    expect(block).toMatch(/ticketReadiness\(state, ticketBlocksUsed\)/);
    expect(block).toMatch(/ticketBlocksUsed \+= 1/);
    expect(block).toMatch(/missing_required_field:\$\{ask\.field\}/);
  });

  it('the records tool blocks too — it is the 27-second one', () => {
    const at = src.indexOf("name: 'handle_patient_medical_records_request'");
    const block = src.slice(at, at + 2600);
    expect(block).toMatch(/ticketReadiness\(preState, ticketBlocksUsed\)/);
    expect(block).toMatch(/missing_required_field:/);
  });

  it('the strike counter is per call, not module-wide', () => {
    // Module state here would leak one caller's refusals onto the next.
    expect(src).toMatch(/let ticketBlocksUsed = 0;/);
    const declAt = src.indexOf('let ticketBlocksUsed');
    const fnAt = src.indexOf('export function createPcpAgent');
    expect(declAt, 'must be declared inside createPcpAgent').toBeGreaterThan(fnAt);
  });

  it('a filed-anyway ticket carries the gap note', () => {
    expect(src).toMatch(/const gapNote = annotationFor\(readiness\.annotate\)/);
    expect(src).toMatch(/filing with unanswered required field\(s\)/);
  });
});
