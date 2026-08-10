/**
 * AssemblyAI Universal-3.5 Pro, realtime.
 *
 * Parameters verified against the live API reference on 2026-08-09 rather
 * than recalled — their own agent instructions warn that the API has moved
 * and that pre-recorded params do not all exist on realtime. Confirmed there:
 * `encoding=pcm_mulaw`, `sample_rate` accepts 8000, `keyterms_prompt` caps at
 * 100 terms, `prompt` and `agent_context` at 1750 chars each.
 *
 * Auth is the raw key with NO Bearer prefix (Bearer is the Voice Agent API,
 * which is a different product we are deliberately not using — the agent is
 * ours).
 */
import { WebSocket } from 'ws';
import type { Transcriber, TranscriberOptions } from './types';

/**
 * The canonical host is the edge-routed one; the region-pinned variants exist
 * for data residency. I defaulted to the US-pinned host and the engine
 * produced no turns at all, so the default is now the host every example in
 * their docs uses, and pinning is opt-in via ASSEMBLYAI_REGION.
 */
const HOST =
  process.env.ASSEMBLYAI_REGION === 'eu'
    ? 'wss://streaming.eu.assemblyai.com/v3/ws'
    : process.env.ASSEMBLYAI_REGION === 'us'
      ? 'wss://streaming.us.assemblyai.com/v3/ws'
      : 'wss://streaming.assemblyai.com/v3/ws';

const MAX_KEYTERMS = 100;
const MAX_PROMPT = 1750;

export function createAssemblyAiTranscriber(): Transcriber {
  let ws: WebSocket | null = null;
  let opts: TranscriberOptions | null = null;

  return {
    name: 'assemblyai',

    async start(o) {
      opts = o;
      const key = process.env.ASSEMBLYAI_API_KEY;
      if (!key) throw new Error('ASSEMBLYAI_API_KEY is not set');

      const qs = new URLSearchParams({
        speech_model: 'universal-3-5-pro',
        // Twilio's audio, untouched. Their docs are explicit that upsampling
        // phone audio degrades accuracy.
        encoding: 'pcm_mulaw',
        sample_rate: '8000',
        mode: process.env.ASSEMBLYAI_MODE ?? 'balanced',
        // Speakerphones, cars and waiting rooms.
        voice_focus: 'far-field',
      });
      qs.set('prompt', o.prompt.slice(0, MAX_PROMPT));
      if (o.keyterms.length) {
        qs.set('keyterms_prompt', JSON.stringify(o.keyterms.slice(0, MAX_KEYTERMS)));
      }

      const socket = new WebSocket(`${HOST}?${qs.toString()}`, {
        headers: { Authorization: key }, // the raw key, unprefixed (see above)
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
          // Everything that is NOT a transcript, said out loud. Without this
          // the only observable fact was "no words", which is indistinguishable
          // from a bad key, a rejected parameter, and a silent caller.
          if (msg.type && msg.type !== 'Turn') {
            console.info(`[STT][assemblyai] ${msg.type}${msg.error ? ` error=${JSON.stringify(msg.error)}` : ''}`);
          }
          if (msg.type === 'SpeechStarted') opts?.onSpeechStarted?.();
          else if (msg.type === 'Turn') {
            const text = String(msg.transcript ?? '').trim();
            if (text) {
              opts?.onTurn({
                engine: 'assemblyai',
                text,
                isFinal: Boolean(msg.end_of_turn),
                confidence: typeof msg.end_of_turn_confidence === 'number' ? msg.end_of_turn_confidence : undefined,
              });
            }
          }
        } catch (e) {
          opts?.onError?.(e);
        }
      });

      socket.on('error', (e) => opts?.onError?.(e));
      socket.on('close', (code, reason) => {
        // 3007 is "audio chunk outside 50-1000ms or sent faster than real
        // time" — the exact failure that produced a connected socket and a
        // silent call. Never leave it to be inferred again.
        console.info(`[STT][assemblyai] closed code=${code} reason=${reason?.toString() || '(none)'}`);
      });
    },

    sendAudio(mulaw) {
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(mulaw); // binary frame, μ-law as received
        } catch {
          /* a dropped frame must never take the call down */
        }
      }
    },

    setAgentContext(text) {
      if (ws?.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({
          type: 'UpdateConfiguration',
          agent_context: text.slice(0, MAX_PROMPT),
        }));
      } catch {
        /* best effort — this is an accuracy hint, not a requirement */
      }
    },

    async stop() {
      const socket = ws;
      ws = null;
      if (!socket) return;
      try {
        // Required. An abandoned session bills until their 3-hour cap.
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'Terminate' }));
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
