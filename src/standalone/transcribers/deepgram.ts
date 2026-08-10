/**
 * Deepgram Nova-3, realtime.
 *
 * Parameters verified against the live streaming API reference on 2026-08-09:
 * `encoding=mulaw` is valid, `sample_rate` is free-form, `keyterm` is the
 * Nova-3 term-boosting parameter, `vad_events=true` produces SpeechStarted,
 * and the stream is closed with a `CloseStream` message.
 *
 * Auth is `Authorization: Token <key>` — Deepgram's own convention, and
 * deliberately NOT the same as AssemblyAI's raw key. Getting these two
 * confused is the fastest way to a silent 401 on one engine while the other
 * works, which would quietly bias the comparison this whole file exists for.
 */
import { WebSocket } from 'ws';
import type { Transcriber, TranscriberOptions } from './types';

const HOST = 'wss://api.deepgram.com/v1/listen';

/**
 * A local stand-in, so a test can drive a whole call through the REAL adapter
 * — query string, auth header, message parsing and all — without the network.
 * Unset in production, where it is Deepgram itself. This exists because the
 * caller's words used to enter through the OpenAI session, which every test
 * leaned on; now that the ear is a separate socket, the tests have to speak
 * through the same door a real caller does.
 */
function host(): string {
  return process.env.DEEPGRAM_URL || HOST;
}

export function createDeepgramTranscriber(): Transcriber {
  let ws: WebSocket | null = null;
  let opts: TranscriberOptions | null = null;
  /** Settled segments of the utterance in progress, awaiting its end. */
  let pending: string[] = [];

  /** Hand the accumulated sentence over as ONE turn, and start the next. */
  function flush(confidence?: number): void {
    const text = pending.join(' ').trim();
    pending = [];
    if (!text) return;
    opts?.onTurn({ engine: 'deepgram', text, isFinal: true, confidence });
  }

  return {
    name: 'deepgram',

    async start(o) {
      opts = o;
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key && !process.env.DEEPGRAM_URL) throw new Error('DEEPGRAM_API_KEY is not set');

      const qs = new URLSearchParams({
        model: process.env.DEEPGRAM_MODEL ?? 'nova-3',
        // Twilio's audio as-is, same as the other engines get.
        encoding: 'mulaw',
        sample_rate: '8000',
        channels: '1',
        punctuate: 'true',
        smart_format: 'true',
        interim_results: 'true',
        vad_events: 'true',
        // Deepgram's endpointing is in ms of trailing silence. Their default
        // (10) is tuned for dictation and finalises far too eagerly for a
        // caller who pauses while reading a date off a bottle.
        endpointing: process.env.DEEPGRAM_ENDPOINTING ?? '500',
        // Backstop for the end of an utterance. speech_final is the primary
        // signal, but Deepgram documents that it can be missed when a caller
        // runs straight on without the trailing silence endpointing needs;
        // UtteranceEnd fires on the gap instead, so a turn is never stranded.
        utterance_end_ms: process.env.DEEPGRAM_UTTERANCE_END_MS ?? '1000',
      });
      // keyterm repeats, one per term (Nova-3's term boosting).
      for (const term of o.keyterms.slice(0, 100)) qs.append('keyterm', term);

      const socket = new WebSocket(`${host()}?${qs.toString()}`, {
        headers: { Authorization: `Token ${key}` }, // Token — not Bearer, not raw
      });
      ws = socket;

      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', (e) => reject(e));
      });

      socket.on('message', (raw) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        try {
          if (msg.type === 'SpeechStarted') {
            opts?.onSpeechStarted?.();
            return;
          }
          // The caller stopped talking. Whatever we have accumulated is the
          // whole utterance, even if speech_final never came.
          if (msg.type === 'UtteranceEnd') {
            flush();
            return;
          }
          if (msg.type !== 'Results') return;
          const alt = msg.channel?.alternatives?.[0];
          const text = String(alt?.transcript ?? '').trim();
          if (!text) return; // Deepgram emits empty transcripts during silence

          // is_final and speech_final are NOT the same thing, and treating
          // them as one is what made the agent repeat itself.
          //
          // is_final means "these words are settled" — Deepgram will not
          // revise them. It does NOT mean the caller finished. A sentence
          // spoken with any internal pause arrives as several is_final
          // segments, and firing a turn on each one hands the agent a
          // fragment. Live 19:11: "Yes. I'm calling to see if" became a turn,
          // the agent asked for a name, then "you could tell me when my last
          // appointment was, please" became a second turn and it asked for
          // the name again. The caller: "You're repeating everything twice."
          //
          // speech_final is the one that means the caller stopped. Segments
          // accumulate until then, and the agent sees one sentence.
          if (msg.is_final) {
            pending.push(text);
            if (msg.speech_final) flush(typeof alt?.confidence === 'number' ? alt.confidence : undefined);
            return;
          }
          // An interim hypothesis: useful for a live display, never a turn.
          opts?.onTurn({
            engine: 'deepgram',
            text: [...pending, text].join(' '),
            isFinal: false,
            confidence: typeof alt?.confidence === 'number' ? alt.confidence : undefined,
          });
        } catch (e) {
          opts?.onError?.(e);
        }
      });

      socket.on('error', (e) => opts?.onError?.(e));
      socket.on('close', (code, reason) => {
        console.info(`[STT][deepgram] closed code=${code} reason=${reason?.toString() || '(none)'}`);
      });
    },

    sendAudio(mulaw) {
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(mulaw);
        } catch {
          /* a dropped frame must never take the call down */
        }
      }
    },

    // Deepgram has no agent-context equivalent. Deliberately absent rather
    // than faked, so the comparison shows the real difference between them.

    async stop() {
      const socket = ws;
      ws = null;
      // A caller who hangs up mid-sentence still said something, and the
      // agent files on hang-up. Stranding those words in the buffer would
      // lose the last thing they told us.
      flush();
      if (!socket) return;
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* closing anyway */
      }
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    },
  };
}
