import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SipCallerActivity } from '../services/sipGhostHangup';
import { escalationDetailsMap } from '../services/escalationStore';

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

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  escalationDetailsMap.clear();
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
      const callerActivity = new SipCallerActivity();
      const unsubscribed = vi.fn();
      const agent = await factory(async () => undefined, {
        callId: `call-${callSid}`,
        callSid,
        getTranscript: () => transcript,
        onCallerActivity: (cancel: () => void) => {
          const unsubscribe = callerActivity.subscribe(cancel);
          return () => { unsubscribe(); unsubscribed(); };
        },
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
        speechStarted: () => callerActivity.onTransportEvent({ type: 'input_audio_buffer.speech_started' }),
        speechStopped: () => callerActivity.onTransportEvent({ type: 'input_audio_buffer.speech_stopped' }),
        transcribed: (text: string) => {
          transcript += `\nCALLER: ${text}`;
          callerActivity.onTransportEvent({
            type: 'conversation.item.input_audio_transcription.completed', transcript: text,
          });
        },
        unsubscribed,
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
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await pending).toMatchObject({ success: true, reason: 'ghost_call' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(markCallConcluded).toHaveBeenCalledTimes(1);
        expect(h.unsubscribed).toHaveBeenCalledTimes('pipeline' in extra ? 0 : 1);
      },
    );

    it('keeps other termination reasons available', async () => {
      const h = await setup();
      h.setTranscript('CALLER: Synthetic automated solicitation.');
      expect(await h.terminate('spam')).toMatchObject({ success: true, reason: 'spam' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    if (!('pipeline' in extra)) {
      it('cancels an armed ghost hangup when speech starts before transcription', async () => {
        const h = await setup();
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).not.toHaveBeenCalled();

        h.speechStarted(); // VAD arrives before the caller's words.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await pending).toMatchObject({ success: false, error: 'caller_speaking' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(markCallConcluded).not.toHaveBeenCalled();
        expect(h.unsubscribed).toHaveBeenCalledTimes(1);
      });

      it('rechecks the live transcript after the cancellation window', async () => {
        const h = await setup();
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(500);
        // Also cover callers that only supply a live transcript getter.
        h.setTranscript('CALLER: Please help with my appointment.');
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ success: false, error: 'caller_already_heard' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(markCallConcluded).not.toHaveBeenCalled();
      });

      it('aborts an in-flight ghost hangup and ignores a late successful response', async () => {
        const h = await setup();
        let finish!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const signal = fetchMock.mock.calls[0][1]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);

        h.transcribed('Please help with my appointment.');
        expect(signal?.aborted).toBe(true);
        // Even if the server's success beats the transport abort, do not
        // record a deliberate conclusion based on the stale permission.
        finish(new Response(null, { status: 200 }));
        expect(await pending).toMatchObject({ success: false, error: 'caller_already_heard' });
        expect(markCallConcluded).not.toHaveBeenCalled();
        expect(h.unsubscribed).toHaveBeenCalledTimes(1);
      });

      it('returns a caller refusal when speech aborts the HTTP request', async () => {
        const h = await setup();
        fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
        h.speechStarted();
        expect(await pending).toMatchObject({ success: false, error: 'caller_speaking' });
        expect(markCallConcluded).not.toHaveBeenCalled();
        expect(h.unsubscribed).toHaveBeenCalledTimes(1);
      });

      it('refuses a ghost hangup while speech already underway awaits transcription', async () => {
        const h = await setup();
        h.speechStarted();
        expect(await h.terminate()).toMatchObject({ success: false, error: 'caller_speaking' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(markCallConcluded).not.toHaveBeenCalled();
        expect(h.unsubscribed).toHaveBeenCalledTimes(1);
      });

      it('cancels on a late transcript even without a VAD speech-start event', async () => {
        const h = await setup();
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(500);
        h.transcribed('Please help with my appointment.');
        expect(await pending).toMatchObject({ success: false, error: 'caller_already_heard' });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(markCallConcluded).not.toHaveBeenCalled();
      });

      it('waits for the transcript when speech has stopped before termination', async () => {
        const h = await setup();
        h.speechStarted();
        h.speechStopped();
        expect(await h.terminate()).toMatchObject({ success: false, error: 'caller_speaking' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(markCallConcluded).not.toHaveBeenCalled();
      });

      it('cancels while awaiting transcription even if the speech-start event was missed', async () => {
        const h = await setup();
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(500);
        h.speechStopped();
        expect(await pending).toMatchObject({ success: false, error: 'caller_speaking' });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(markCallConcluded).not.toHaveBeenCalled();
      });

      it('allows a new termination after a noise-only interruption ends', async () => {
        const h = await setup();
        const interrupted = h.terminate();
        await vi.advanceTimersByTimeAsync(500);
        h.speechStarted();
        expect(await interrupted).toMatchObject({ success: false, error: 'caller_speaking' });
        h.speechStopped();
        h.transcribed('   ');

        const retried = h.terminate();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await retried).toMatchObject({ success: true, reason: 'ghost_call' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(markCallConcluded).toHaveBeenCalledTimes(1);
        expect(h.unsubscribed).toHaveBeenCalledTimes(2);
      });

      it('rechecks a late transcript when the HTTP response arrives without an activity notification', async () => {
        const h = await setup();
        let finish!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(1_000);
        h.setTranscript('CALLER: Please help with my appointment.');
        finish(new Response(null, { status: 200 }));
        expect(await pending).toMatchObject({ success: false, error: 'caller_already_heard' });
        expect(markCallConcluded).not.toHaveBeenCalled();
      });

      it('releases the activity subscription after an HTTP failure', async () => {
        const h = await setup();
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
        const pending = h.terminate();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await pending).toMatchObject({ success: false, status: 503 });
        expect(markCallConcluded).not.toHaveBeenCalled();
        expect(h.unsubscribed).toHaveBeenCalledTimes(1);
      });

      if (lane === 'no-ivr SIP') {
        it('rechecks escalation after waiting for caller speech', async () => {
          const h = await setup();
          const pending = h.terminate();
          await vi.advanceTimersByTimeAsync(500);
          escalationDetailsMap.set('call-CA0000000000000000000000000000beef', {
            reason: 'Synthetic handoff in progress',
          } as never);
          await vi.advanceTimersByTimeAsync(500);
          expect(await pending).toMatchObject({ success: false, error: 'escalation_in_progress' });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(markCallConcluded).not.toHaveBeenCalled();
          expect(h.unsubscribed).toHaveBeenCalledTimes(1);
        });
      }
    }

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
