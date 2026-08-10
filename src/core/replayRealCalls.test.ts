/**
 * REPLAY — every caller utterance from the operator's real calls tonight.
 *
 * "Are you just guessing this the whole way through?"
 *
 * Fair question, and the honest answer was yes: I changed code and asked him
 * to make a phone call to find out. That is him being the test harness. These
 * are the actual words spoken on the actual calls, pulled from call_logs, run
 * through the actual agent. No model is available in a test run, so this
 * exercises the PARSER FLOOR — the worst case, the one that runs when the
 * reader is slow, down, or unset. If a call passes here it passes anywhere.
 *
 * Each entry is a real call_sid. Add a failing call to this list before
 * changing any parsing code, and it stops being a guess.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearAllLedgers, seedLedger, getLedger } from '../services/callFactsLedger';
import { createTicketAgent, type TicketAgentServices } from './ticketAgent';
import type { CoreAction } from './types';

interface RealCall {
  sid: string;
  at: string;
  said: string[];
  /** What a human reading this call would say we should have captured. */
  wantName?: string;
  wantDob?: string;
  wantMedication?: RegExp;
}

const CALLS: RealCall[] = [
  {
    sid: 'CA364b8ec07b58bc6fb83cf1f482b908c9', at: '21:40',
    said: ["Yes. I'm trying to find out when was my last appointment.", "Yes. It's Wayne Fabian.", '03/17/1973.'],
    wantName: 'Wayne Fabian', wantDob: '1973-03-17',
  },
  {
    sid: 'CAf6bda914833ee1e803cd474fb6a70873', at: '20:48',
    said: ["Yes. I'm calling to see what was my last appointment.", "Yeah. It's Wayne Fabian.", "It's 03/17/1973."],
    wantName: 'Wayne Fabian', wantDob: '1973-03-17',
  },
  {
    sid: 'CAf5cd32fd5a161e879b40e958faca887f', at: '20:45',
    said: ["Yes. I'd like to know when was my last appointment.", "Yes. It's Wayne Fabian.", "That's 03/17/1973."],
    wantName: 'Wayne Fabian', wantDob: '1973-03-17',
  },
  {
    sid: 'CAd5d1ae39ad4397d4af130c89a6951887', at: '19:59',
    said: ["Yes. I'd like to know when was my last appointment.", "Yes. It's Wayne Fabian.", "Patient's date of birth is 03/17/1973."],
    wantName: 'Wayne Fabian', wantDob: '1973-03-17',
  },
  {
    sid: 'CAac2c00805c4185cd60d2645bdf28d15e', at: '17:16',
    said: ["Yeah. I'd like to know when was my last appointment.", "Yes. It's Wayne Fabian. Date of birth", 'is 03/17/1973.'],
    wantName: 'Wayne Fabian', wantDob: '1973-03-17',
  },
  {
    sid: 'CA70d236f04ebe530ed9b3fbc106a2ad1d', at: '18:23',
    said: ["Hi. I'd like a medication refill, please.", "Yes. Patient's name is Wayne Fabian.", "Patient's date of birth is 03/17/1973.", 'Prednisolone acetate.', 'Yes. This is.'],
    wantName: 'Wayne Fabian', wantDob: '1973-03-17', wantMedication: /prednisolone/i,
  },
  {
    sid: 'CA395942884e825111d1337ba5fac23492', at: '17:15',
    said: ["I'd like to put in for a medication refill, please.", "Yes. Patient's name is Wayne Fabian. Date of birth is 03/17/1973.", "It's prednisolone acetate.", 'Yes. This is.'],
    wantName: 'Wayne Fabian', wantDob: '1973-03-17', wantMedication: /prednisolone/i,
  },
];

function agentWithNoModel() {
  // Deliberately NO classifyIntent, NO readField, NO readConversation. This is
  // the floor: what happens when every model call fails.
  const svc: TicketAgentServices = {
    verify: vi.fn(async () => true),
    submit: vi.fn(async () => ({ ok: true, ticketNumber: 'T-1' })),
  };
  return svc;
}

async function drain(a: CoreAction | null): Promise<void> {
  let cur = a;
  while (cur) cur = cur.followUp ? await cur.followUp() : null;
}

describe('replay of the operator\'s real calls — parser floor, no model', () => {
  beforeEach(() => clearAllLedgers());

  for (const call of CALLS) {
    it(`${call.at} ${call.sid.slice(-6)}`, async () => {
      const id = call.sid;
      const a = createTicketAgent(agentWithNoModel());
      a.start(id);
      seedLedger(id, { callerPhone: '8455317471' });
      for (const line of call.said) await drain(await a.onUtterance(id, line));

      const f = getLedger(id);
      if (call.wantName) {
        const got = `${f?.firstName ?? ''} ${f?.lastName ?? ''}`.trim();
        expect(got, `name from ${call.at}`).toBe(call.wantName);
      }
      if (call.wantDob) expect(f?.dateOfBirth, `dob from ${call.at}`).toBe(call.wantDob);
    });
  }
});
