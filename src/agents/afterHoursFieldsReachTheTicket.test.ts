/**
 * v163: WHAT THE AFTER-HOURS CALLER SAID REACHES THE TICKET.
 *
 * Tickets 70150, 70157, 70160, 70162 (and the noise calls 70148/70149/70170)
 * reached staff with no date of birth, no office and no request type. On 70150
 * the caller answered the date-of-birth question twice; the floor read a date
 * only from a certain lookup, and the live create_ticket filed an omitted
 * date_of_birth as `Unknown` without looking at the caller's answer. Ticket
 * 70166 was an urgent on-call transfer that rang out.
 *
 * Synthetic callers only — no name, date, number or words from those calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveTool } from '../runtime/agentBinding';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});

const h = vi.hoisted(() => ({
  getCallLogBySid: vi.fn(),
  submitSimplifiedTicket: vi.fn(),
  lookupByNameAndDOB: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [] })),
}));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: h.getCallLogBySid } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: h.submitSimplifiedTicket,
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [] }),
    lookupByNameAndDOB: h.lookupByNameAndDOB,
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { defaultLaneSource } = await import('../runtime/laneRegistry');
const { runLaneTeardownFloor } = await import('../runtime/pcpFloor');
const { noteSpokenDob } = await import('../tools/spokenDob');
const { rememberConfirmedClinic } = await import('../tools/verifiedIdentity');
const { AFTER_HOURS_CATCHALL, AFTER_HOURS_REASON_IDS } = await import('../tools/afterHoursTaxonomy');
const { HANDOFF_ERROR_DIRECTIVE, HANDOFF_FAILED_DIRECTIVE, HANDOFF_NOT_PLACED_DIRECTIVE, createNoIvrAgent } = await import('./noIvrAgent');
const { isoDobToUs, dobTheCallerGave } = await import('../services/afterHoursCallFacts');
const { __resetDirectory } = await import('../services/consoleDirectory');

const DOB_ASK = 'AGENT: And your date of birth, starting with the month, then the day, then the year?';

let serial = 0;
beforeEach(() => {
  h.getCallLogBySid.mockReset().mockResolvedValue(undefined);
  h.submitSimplifiedTicket.mockReset().mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
  h.lookupByNameAndDOB.mockClear();
  const office = (key: string, canonical: string, fileAs?: string) =>
    [key, { canonical, key, facilityKind: 'clinic', volume90d: 1, fileAs }] as const;
  __resetDirectory({
    providers: new Map(),
    locations: new Map([office('covina', 'Covina'), office('downey', 'Downey'), office('dtla', 'DTLA', 'Los Angeles')]),
    loadedAt: Date.now(),
  } as never);
});

async function call(transcript?: string, handoff = vi.fn(async () => {})) {
  const source = await defaultLaneSource();
  const config = source.getAgentConfig('no-ivr')!;
  const callSid = `CA${String(9000 + ++serial).padStart(32, '0')}`;
  const callId = `synthetic-v163-${serial}`;
  const agent = await config.factory(...[handoff, {
    callId, callSid, callerPhone: '+12025550100',
    ...(transcript === undefined ? {} : { getTranscript: () => transcript }),
  }] as never[]);
  const finish = () => runLaneTeardownFloor(
    { slug: 'no-ivr', callSid: callId, outcome: 'caller_hangup', transcript: '' },
    { source: async () => source },
  );
  return { callId, callSid, finish, agent: agent as { tools: LiveTool[] } };
}

async function invoke(agent: { tools: LiveTool[] }, name: string, args = {}) {
  const tool = agent.tools.find((t) => t.name === name)!;
  const result = await tool.invoke!({}, JSON.stringify(args));
  return typeof result === 'string' ? JSON.parse(result) : result;
}

describe('the date of birth the caller gave', () => {
  it('reads an ISO answer as month/day/year, and nothing else', () => {
    expect(isoDobToUs('1961-03-03')).toBe('03/03/1961');
    expect(isoDobToUs('March 3')).toBeUndefined();
    expect(isoDobToUs(undefined)).toBeUndefined();
  });

  it('counts only an answer to a date-of-birth ask, never a mention', () => {
    expect(dobTheCallerGave(undefined, `${DOB_ASK}\nCALLER: March 3rd, 1961.`)).toBe('03/03/1961');
    expect(dobTheCallerGave(undefined, 'AGENT: How can I help?\nCALLER: My appointment is March 3rd, 2027.')).toBeUndefined();
  });
});

describe('the teardown floor (the 70150 shape)', () => {
  const REQUEST = `AGENT: How may I assist you?\nCALLER: I want to make an appointment.\n${DOB_ASK}\nCALLER: March 3rd, 1961.`;

  it('files the date of birth the caller gave, flagged as not matched to a record', async () => {
    const c = await call(REQUEST);
    await c.finish();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    const sent = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(sent.patientDOB).toBe('03/03/1961');
    expect(sent.additionalDetails).toContain('DATE OF BIRTH as the caller gave it');
  });

  it("files `Unknown` with no date note when the caller never answered the question", async () => {
    const c = await call('AGENT: How may I assist you?\nCALLER: Please cancel my appointment and call me back.');
    await c.finish();
    const sent = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(sent.patientDOB).toBe('Unknown');
    expect(sent.additionalDetails).not.toContain('DATE OF BIRTH');
  });

  it('takes department 8\'s catch-all when no cue matches, so the ticket is never type-less (70157 shape)', async () => {
    const c = await call('AGENT: How may I assist you?\nCALLER: Please cancel my appointment for next week, I have a conflict.');
    await c.finish();
    const sent = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(sent.departmentId).toBe(8);
    expect(sent.suggestedRequestTypeId).toBe(AFTER_HOURS_CATCHALL.requestTypeId);
    expect(sent.suggestedRequestReasonId).toBe(AFTER_HOURS_CATCHALL.requestReasonId);
    expect(AFTER_HOURS_REASON_IDS.has(sent.suggestedRequestReasonId)).toBe(true);
  });

  it('carries the department-8 pair the caller\'s words match: "call me back" is 36/174', async () => {
    const c = await call('AGENT: How may I assist you?\nCALLER: Please cancel my appointment and call me back.');
    await c.finish();
    const sent = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(sent.departmentId).toBe(8);
    expect(sent.suggestedRequestTypeId).toBe(36);
    expect(sent.suggestedRequestReasonId).toBe(174);
    expect(AFTER_HOURS_REASON_IDS.has(174)).toBe(true);
  });

  const OFFICE_ASK = 'AGENT: Which office do you usually visit?';
  const officeSent = async (transcript: string) => {
    const c = await call(transcript);
    await c.finish();
    return h.submitSimplifiedTicket.mock.calls[0][0];
  };

  it('prefers the confirmed office over the transcript', async () => {
    const c = await call(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.`);
    rememberConfirmedClinic(c.callSid, 'Synthetic Office');
    await c.finish();
    expect(h.submitSimplifiedTicket.mock.calls[0][0]).toMatchObject({
      locationOfLastVisit: 'Synthetic Office',
      locationSource: 'caller',
    });
  });

  it.each([
    ['English', OFFICE_ASK, 'CALLER: Covina.', 'Covina'],
    ['a sentence', OFFICE_ASK, 'CALLER: Usually the Downey office.', 'Downey'],
    ['Spanish', 'AGENT: ¿A qué oficina va normalmente?', 'CALLER: A Covina.', 'Covina'],
    ['leading no', OFFICE_ASK, 'CALLER: No, Downey.', 'Downey'],
    ['the name the app files', OFFICE_ASK, 'CALLER: DTLA.', 'Los Angeles'],
  ])('recovers the office the caller named when asked with no store seeded (%s)', async (_label, ask, answer, office) => {
    expect(await officeSent(`${REQUEST}\n${ask}\n${answer}`)).toMatchObject({
      locationOfLastVisit: office,
      locationSource: 'caller',
    });
  });

  it('takes a correction to a known office over the first answer', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Thank you.\nCALLER: Actually, Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('takes a same-line correction to a known office', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina, actually Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('ignores a "sorry" after the agent has moved to another question', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: And what is the best number to reach you?\nCALLER: Sorry, I also need a refill at the Downey pharmacy.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('closes the office window on a question whose "?" is mid-line', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: What is your callback number? Please include the area code.\nCALLER: Sorry, refill at the Downey pharmacy.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('reads a correcting turn split across caller lines', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Thank you.\nCALLER: Actually,\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('does not read a pharmacy question as an office ask', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Which pharmacy should the office send your refill to?\nCALLER: The CVS in Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('does not read a bare "Which location?" after a pharmacy question as an office ask', async () => {
    const sent = await officeSent(`${REQUEST}\nAGENT: Which office do you usually visit?\nCALLER: Covina.\nAGENT: Which pharmacy?\nCALLER: CVS.\nAGENT: Which location?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('reads a bare "Which location?" that follows an office ask', async () => {
    const sent = await officeSent(`${REQUEST}\nAGENT: Which office do you usually visit?\nCALLER: Um.\nAGENT: Which location?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('does not read a bare "Which location?" with no office context', async () => {
    const sent = await officeSent(`${REQUEST}\nAGENT: Which location?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBeUndefined();
  });

  it('does not read "What can our office help you with?" as an office ask', async () => {
    const sent = await officeSent(`${REQUEST}\nAGENT: What can our office help you with?\nCALLER: Send my prescription to CVS in Downey.`);
    expect(sent.locationOfLastVisit).toBeUndefined();
  });

  it('reads a bare "Which office?" as an office ask', async () => {
    const sent = await officeSent(`${REQUEST}\nAGENT: Which office?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('takes the correction to an office readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, is that correct?\nCALLER: No, Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('keeps the office the caller confirms on a readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, is that correct?\nCALLER: Yes.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('does not read a pharmacy confirmation as an office readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Can you confirm which pharmacy?\nCALLER: CVS in Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('takes a correction that follows an affirmation on a readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, correcto?\nCALLER: Sí, perdón, quise decir Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('does not read "Which location is that?" after a pharmacy question as an office ask', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Which pharmacy?\nCALLER: CVS.\nAGENT: Which location is that?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('takes the correction to a second readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, is that correct?\nCALLER: No, Downey.\nAGENT: Downey, is that correct?\nCALLER: No, Springfield.`);
    expect(sent.locationOfLastVisit).toBeUndefined();
  });

  it('reads a readback of a sentence answer', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Usually the Covina office.\nAGENT: Covina, is that correct?\nCALLER: No, Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('files no office when the caller rejects the readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Usually the Covina office.\nAGENT: Covina, is that correct?\nCALLER: No.`);
    expect(sent.locationOfLastVisit).toBeUndefined();
  });

  it('reads a re-ask after a rejected readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, correct?\nCALLER: No.\nAGENT: Which location?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('does not read a callback-number confirmation as an office readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Can you confirm your callback number for the office?\nCALLER: Five five five, one two one two.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('does not read a pharmacy correction as an office correction', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Thank you.\nCALLER: Sorry, the pharmacy is in Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('does not read a readback of the request as an office readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina, I need a refill.\nAGENT: A refill, correct?\nCALLER: No, I need records sent to a doctor in Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('files the office a confirmed readback named', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: The Downey office, correct?\nCALLER: Yes.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('closes the window on a readback followed by another question', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, correct? Where should your records be sent?\nCALLER: To a doctor in Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('reads a readback of a lowercase answer', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: covina\nAGENT: Covina, correct?\nCALLER: No, Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it('honors a denial after an affirmation on a readback', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, correcto?\nCALLER: Sí, pero ya no voy a Covina.`);
    expect(sent.locationOfLastVisit).toBeUndefined();
  });

  it('keeps the answer on a generic office confirmation', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Is that the correct office?\nCALLER: Yes.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('does not keep office context through a readback that asks something else', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Covina, correct? Where should your records be sent?\nCALLER: A doctor.\nAGENT: Which location?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('ignores a later correction about something else', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Thank you.\nCALLER: Actually, my doctor in Downey needs the records.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('keeps the answer on a generic confirmation after a sentence', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Thank you. Is that the correct office?\nCALLER: Yes.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it('does not keep office context through an unrelated confirmation', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: You need records sent to another doctor, correct?\nCALLER: Yes.\nAGENT: Which location?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Covina');
  });

  it.each([['Downey office, is that correct?', 'Downey'], ['Springfield office, is that correct?', undefined]])('files what a confirmed "%s" names', async (q, want) => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: ${q}\nCALLER: Yes.`);
    expect(sent.locationOfLastVisit).toBe(want);
  });

  it('takes the answer to the last office ask', async () => {
    const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Sorry, which office was that?\nCALLER: Downey.`);
    expect(sent.locationOfLastVisit).toBe('Downey');
  });

  it.each([
    ['a mention with no ask', 'AGENT: How may I assist you?\nCALLER: I need a refill from the Covina office and a call back.'],
    ['a mention after the answer window closed', `${OFFICE_ASK}\nCALLER: I am not sure.\nAGENT: That is fine. How can we help?\nCALLER: I need a refill from the Covina office and a call back.`],
    ['an agent line that only states an office', 'AGENT: Our Covina office opens at eight.\nCALLER: Downey is closer, please call me back about my refill.'],
    ['two offices in the answer', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina or Downey.`],
    ['a denied office', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Not Covina anymore.`],
    ['a city that only contains an office name', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: West Covina.`],
    ['a Spanish denial ("No voy a ...")', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: No voy a Covina.`],
    ['an in-window correction to an unknown office', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina.\nCALLER: Actually, Springfield.`],
    ['a later correction to an unknown office', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Thank you.\nCALLER: Sorry, I mean Springfield.`],
    ['a re-ask answered with an unknown office', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina.\nAGENT: Sorry, which office was that?\nCALLER: Springfield.`],
    ['a same-line correction to an unknown office', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina, actually Springfield.`],
    ['a trailing Spanish "no"', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina, no.`],
    ['a trailing English "No."', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina? No.`],
    ['an in-window correction that names two offices', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Covina.\nCALLER: Actually, Downey\nCALLER: or Covina.`],
    ['an office the directory does not know', `AGENT: How may I assist you?\nCALLER: Please call me back about my refill.\n${OFFICE_ASK}\nCALLER: Springfield.`],
  ])('sends no office on %s', async (_label, transcript) => {
    const sent = await officeSent(transcript);
    expect(sent).not.toHaveProperty('locationOfLastVisit');
    expect(sent).not.toHaveProperty('locationSource');
  });

  it('still files the ticket when the directory is down', async () => {
    __resetDirectory(null);
    const before = process.env.OBS_CONSOLE_DATABASE_URL;
    delete process.env.OBS_CONSOLE_DATABASE_URL;
    try {
      const sent = await officeSent(`${REQUEST}\n${OFFICE_ASK}\nCALLER: Covina.`);
      expect(sent).not.toHaveProperty('locationOfLastVisit');
    } finally {
      if (before !== undefined) process.env.OBS_CONSOLE_DATABASE_URL = before;
    }
  });
});

describe('the live create_ticket', () => {
  const ARGS = {
    first_name: 'Synthetic', last_name: 'Example',
    callback_number: '2025550100', request_category: 'general_question',
    request_summary: 'Please return my call about a message for the office.',
  };

  it('takes the caller\'s spoken answer when the model omits date_of_birth (bridge store)', async () => {
    const c = await call();
    noteSpokenDob(c.callSid, [DOB_ASK, 'CALLER: March 3rd, 1961.']);
    expect(await invoke(c.agent, 'create_ticket', ARGS)).toMatchObject({ success: true });
    expect(h.submitSimplifiedTicket.mock.calls[0][0].patientDOB).toBe('03/03/1961');
  });

  it('falls back to the transcript when the store is empty', async () => {
    const c = await call(`${DOB_ASK}\nCALLER: March 3rd, 1961.`);
    expect(await invoke(c.agent, 'create_ticket', ARGS)).toMatchObject({ success: true });
    expect(h.submitSimplifiedTicket.mock.calls[0][0].patientDOB).toBe('03/03/1961');
  });

  it('looks the record up on the right date when the spoken answer hydrates as YYYY-MM-DD', async () => {
    const c = await call();
    noteSpokenDob(c.callSid, [DOB_ASK, 'CALLER: March 3rd, 1961.']);
    await invoke(c.agent, 'create_ticket', ARGS);
    expect(h.lookupByNameAndDOB).toHaveBeenCalledWith('Synthetic', 'Example', '1961-03-03');
  });

  it('converts to month/day/year on the payload only: a date sent as ISO stays ISO for the lookup', async () => {
    const c = await call();
    await invoke(c.agent, 'create_ticket', { ...ARGS, date_of_birth: '1961-03-03' });
    expect(h.lookupByNameAndDOB).toHaveBeenCalledWith('Synthetic', 'Example', '1961-03-03');
    expect(h.submitSimplifiedTicket.mock.calls[0][0].patientDOB).toBe('03/03/1961');
  });

  it('sends month/day/year when the model itself sends YYYY-MM-DD', async () => {
    const c = await call();
    await invoke(c.agent, 'create_ticket', { ...ARGS, date_of_birth: '1961-03-03' });
    expect(h.submitSimplifiedTicket.mock.calls[0][0].patientDOB).toBe('03/03/1961');
  });

  it('never overrides a date the model did send', async () => {
    const c = await call(`${DOB_ASK}\nCALLER: March 3rd, 1961.`);
    await invoke(c.agent, 'create_ticket', { ...ARGS, date_of_birth: '01/02/1980' });
    expect(h.submitSimplifiedTicket.mock.calls[0][0].patientDOB).toBe('01/02/1980');
  });
});

describe('the Grok prompt asks for the office', () => {
  it('asks once when no clinic is held, and no longer tells the model to omit it', async () => {
    const agent = await createNoIvrAgent(async () => {}, {
      callId: 'v163-prompt', callSid: 'CA0000000000000000000000000000f163', callerPhone: '+15555550100', pipeline: 'runtime',
    } as any);
    const p = String((agent as any).instructions);
    expect(p).toContain('Which office do you usually visit?');
    expect(p).not.toMatch(/omit location unless caller named it/);
  });
});

describe('a failed on-call transfer (the 70166 shape)', () => {
  const PROVIDER = {
    reason: 'Nurse from the hospital emergency department calling about a patient',
    caller_type: 'healthcare_provider',
    provider_info: 'hospital emergency department',
  };
  const NURSE = 'CALLER: I am a nurse calling from the hospital about a patient.';

  it('tells the model the urgent record is filed and the caller was not connected', async () => {
    const c = await call(NURSE, vi.fn(async () => { throw new Error('handoff_failed:NO_ANSWER'); }));
    expect(await invoke(c.agent, 'escalate_to_human', PROVIDER)).toMatchObject({
      success: false, handoffFailed: true, message: HANDOFF_FAILED_DIRECTIVE,
    });
    expect(HANDOFF_FAILED_DIRECTIVE).toMatch(/NOT connected/);
    expect(HANDOFF_FAILED_DIRECTIVE).toMatch(/Do not call escalate_to_human again/);
  });

  it('never claims an urgent record when no dial was placed', async () => {
    const c = await call(NURSE, vi.fn(async () => { throw new Error('handoff_failed:UNAVAILABLE'); }));
    const r = await invoke(c.agent, 'escalate_to_human', PROVIDER);
    expect(r.message).toBe(HANDOFF_NOT_PLACED_DIRECTIVE);
    expect(HANDOFF_NOT_PLACED_DIRECTIVE).not.toMatch(/already been filed/);
  });

  it.each(['on-call leg failed', 'handoff_failed:FAILED', 'handoff_failed:DECLINED'])(
    'keeps "Transfer failed" and says nobody-answered only on NO_ANSWER (%s)',
    async (thrown) => {
      const c = await call(NURSE, vi.fn(async () => { throw new Error(thrown); }));
      const r = await invoke(c.agent, 'escalate_to_human', PROVIDER);
      expect(r.message).toBe(HANDOFF_ERROR_DIRECTIVE);
      expect(r.message).toMatch(/Transfer failed/);
      expect(r.message).toMatch(/NOT connected/);
      expect(r.message).not.toMatch(/did not answer/);
    },
  );
});
