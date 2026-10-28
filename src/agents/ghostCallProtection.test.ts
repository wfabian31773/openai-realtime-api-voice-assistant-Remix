import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/toolTimeline', () => ({
  recordingExecute: (_ctx: unknown, _name: string, execute: unknown) => execute,
  recordToolEvent: vi.fn(),
  flushAzulTimeline: async () => undefined,
}));
vi.mock('../services/callConclusion', () => ({ markCallConcluded: vi.fn() }));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: {} }));
vi.mock('../services/callerMemoryService', () => ({
  CallerMemoryService: {},
  callerMemoryService: { getCallerMemory: async () => null },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { createAnsweringServiceAgent } = await import('./answeringServiceAgent');
const { createAfterHoursAgent } = await import('./afterHoursAgent');
const { markCallConcluded } = await import('../services/callConclusion');
const createLegacyAfterHours = (handoff: () => Promise<void>, metadata: Parameters<typeof createNoIvrAgent>[1]) =>
  createAfterHoursAgent(handoff, undefined, metadata);

const fetchMock = vi.fn(async () => ({ ok: true }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// Reported request-loss shapes, using only synthetic caller words.
const REQUESTS = [
  ['CA9956d19a9d474ed2838beaa3f1d85f96', 'I need help with my appointment.'],
  ['CA92b3cdb4d8abe46de22197672845afb9', 'Please send my request to the office.'],
  ['CAc0af5afc63d37374e20358468df3da59', 'Necesito ayuda con mi receta.'],
] as const;

for (const [lane, factory, extra] of [
  ['no-ivr SIP', createNoIvrAgent, {}],
  ['no-ivr runtime', createNoIvrAgent, { pipeline: 'runtime' as const }],
  ['answering-service SIP', createAnsweringServiceAgent, {}],
  ['after-hours SIP', createLegacyAfterHours, {}],
] as const) {
  describe(lane, () => {
    async function setup(callSid = 'CA0000000000000000000000000000beef') {
      let transcript = 'AGENT: How can I help you?';
      const agent = await factory(async () => undefined, {
        callId: `call-${callSid}`,
        callSid,
        getTranscript: () => transcript,
        ...extra,
      });
      const termination = agent.tools.find((t) => t.name === 'terminate_call');
      if (!termination || !('description' in termination) || !('invoke' in termination)) {
        throw new Error('terminate_call must be a function tool');
      }
      return {
        agent,
        termination,
        setTranscript: (text: string) => { transcript = text; },
        terminate: async (reason = 'ghost_call') => {
          const raw = await (termination as any).invoke({}, JSON.stringify({ reason }));
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        },
      };
    }

    it.each(REQUESTS)('refuses a ghost hangup after a request: %s', async (sid, request) => {
      const h = await setup(sid);
      // The getter changes AFTER construction, just as it does on the live route.
      // Later silence/empty turns must not erase the earlier request.
      h.setTranscript(`AGENT: How can I help?\nCALLER: ${request}\nAGENT: Take your time.\nCALLER:   `);
      const result = await h.terminate();
      expect(result).toMatchObject({ success: false, error: 'caller_already_heard' });
      expect(result.fix).toMatch(/continue helping/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markCallConcluded).not.toHaveBeenCalled();
    });

    it.each(['', 'AGENT: How can I help?', 'CALLER:   \nAGENT: Hello?'])(
      'preserves the untranscribed ghost termination: %j', async (transcript) => {
        const h = await setup();
        h.setTranscript(transcript);
        expect(await h.terminate()).toMatchObject({ success: true, reason: 'ghost_call' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(markCallConcluded).toHaveBeenCalledTimes(1);
      },
    );

    it('keeps other termination reasons available', async () => {
      const h = await setup();
      h.setTranscript('CALLER: Synthetic automated solicitation.');
      expect(await h.terminate('spam')).toMatchObject({ success: true, reason: 'spam' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('forbids both the ghost line and ghost hangup after any request in the live prompt', async () => {
      const h = await setup();
      const instructions = h.agent.instructions;
      const prompt = typeof instructions === 'function'
        ? await instructions({} as never, h.agent)
        : instructions;
      expect(String(prompt)).toMatch(
        /NEVER use the ghost-call line or terminate_call with reason "ghost_call" after any non-empty caller transcript, including any request or question/,
      );
      expect(h.termination.description).toMatch(/NEVER use ghost_call after any non-empty caller transcript/);
    });
  });
}
