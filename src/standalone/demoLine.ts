/**
 * THE DEMO LINE — a standalone voice agent.
 *
 * Operator directive, 2026-08-09: "Why couldn't you just stand up a simple
 * agent outside of all this nonsense? Its own entity, its own identity, its
 * own everything so that we could test."
 *
 * So this file owns a phone call end to end and shares NOTHING with the old
 * core. No conferences, no SIP headers, no agent allowlists, no ramp, no
 * greeting resolver, no observeCall. Twilio streams the audio here over a
 * WebSocket, this file talks to OpenAI directly, and the ticket agent decides
 * every word. If this line misbehaves, the bug is in one of two files:
 * this one, or src/core/ticketAgent.ts.
 *
 * The one thing it deliberately reuses is the AGENT — createTicketAgent via
 * newCoreFor('demo') — because the whole point is to test that agent, wired
 * to the real ticket-filing services. Reusing the agent is the goal; reusing
 * the transport is what we are escaping.
 *
 * Wiring (once): point the Twilio number at POST https://<host>/demo/voice.
 * After that the agent's wording is tuned from the ticket_agent_config 'demo'
 * row with no deploy.
 */
import type { Express, Request, Response } from 'express';
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { newCoreFor } from '../core/router';
import { cachedConfig } from '../core/ticketAgentConfig';
import { seedLedger, releaseLedger } from '../services/callFactsLedger';
import type { CoreAction } from '../core/types';

const SLUG = 'demo';
const STREAM_PATH = '/demo/stream';
const MODEL = 'gpt-realtime';
const VOICE = 'sage';

/** The model is a speaker, not a participant. It gets no agenda and no tools. */
const MOUTHPIECE_INSTRUCTIONS = [
  'You are the VOICE of a scripted system, not a decision maker.',
  '- Say exactly the words you are given, and nothing else.',
  '- Never ask a question you were not given. Never add a follow-up.',
  '- Never offer to check, look up, transfer, schedule, or confirm anything.',
  '- If you were given nothing to say, stay silent and wait.',
  'Speak naturally and warmly, but the words are not yours to choose.',
].join('\n');

const FALLBACK_GREETING = 'Thank you for calling Azul Vision. How can I help you today?';

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );
}

/**
 * Twilio posts form-encoded bodies. Which shape they arrive in depends on
 * which server mounted us — the API server runs express.urlencoded (object),
 * the voice server parses everything raw (Buffer). Handle all three rather
 * than depend on the host's middleware order.
 */
function formFields(body: unknown): URLSearchParams {
  if (Buffer.isBuffer(body)) return new URLSearchParams(body.toString('utf8'));
  if (typeof body === 'string') return new URLSearchParams(body);
  if (body && typeof body === 'object') {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string') p.set(k, v);
    }
    return p;
  }
  return new URLSearchParams();
}

/** One live call. Everything about it lives here and dies with it. */
interface DemoCall {
  callId: string;
  streamSid: string | null;
  callerPhone: string;
  twilio: WebSocket;
  openai: WebSocket | null;
  transcript: string[];
  closing: boolean;
  /** Set while the agent is speaking a line we forced, for barge-in cleanup. */
  speaking: boolean;
}

const calls = new Map<WebSocket, DemoCall>();

export function mountDemoLine(app: Express, server: HttpServer): void {
  // ---------------------------------------------------------------- webhook
  // Twilio asks what to do with the call. The answer is always the same:
  // stream the audio to us. No IVR, no conference, no lookup, no branching.
  app.post('/demo/voice', (req: Request, res: Response) => {
    const f = formFields(req.body);
    const from = f.get('From') ?? '';
    const callSid = f.get('CallSid') ?? '';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
    console.info(`[DEMO-LINE] call ${callSid} from ${from} → streaming to wss://${host}${STREAM_PATH}`);

    res.set('Content-Type', 'text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${xmlEscape(host)}${STREAM_PATH}">
      <Parameter name="from" value="${xmlEscape(from)}"/>
      <Parameter name="callSid" value="${xmlEscape(callSid)}"/>
    </Stream>
  </Connect>
</Response>`,
    );
  });

  // A plain GET so the line can be proved reachable from a browser.
  app.get('/demo/health', (_req: Request, res: Response) => {
    res.json({ ok: true, line: SLUG, active: calls.size, streamPath: STREAM_PATH });
  });

  // ------------------------------------------------------------- the socket
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let path = '';
    try {
      path = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      /* malformed URL — not ours */
    }
    if (path !== STREAM_PATH) return; // another handler owns it, or nobody does
    wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (twilio: WebSocket) => {
    twilio.on('message', (raw) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.event) {
        case 'start':
          onStart(twilio, msg);
          break;
        case 'media': {
          const call = calls.get(twilio);
          if (call?.openai?.readyState === WebSocket.OPEN && msg.media?.payload) {
            send(call.openai, { type: 'input_audio_buffer.append', audio: msg.media.payload });
          }
          break;
        }
        case 'stop':
          void endCall(twilio, 'twilio stop');
          break;
        default:
          break; // 'connected', 'mark' — nothing to do
      }
    });

    twilio.on('close', () => void endCall(twilio, 'twilio socket closed'));
    twilio.on('error', (e) => console.warn('[DEMO-LINE] twilio socket error:', e));
  });

  console.info(`[DEMO-LINE] ready — POST /demo/voice, stream ${STREAM_PATH}`);
}

// --------------------------------------------------------------- call setup

function onStart(twilio: WebSocket, msg: Record<string, any>): void {
  const params = msg.start?.customParameters ?? {};
  const callId: string = params.callSid || msg.start?.callSid || `demo-${msg.streamSid}`;
  const callerPhone: string = String(params.from ?? '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');

  const call: DemoCall = {
    callId,
    streamSid: msg.start?.streamSid ?? msg.streamSid ?? null,
    callerPhone,
    twilio,
    openai: null,
    transcript: [],
    closing: false,
    speaking: false,
  };
  calls.set(twilio, call);

  // The agent reads the caller's number from the ledger when it needs a
  // callback, so seed it before the first word — same as every other line.
  try {
    seedLedger(callId, { callerPhone: callerPhone || undefined });
  } catch (e) {
    console.warn(`[DEMO-LINE] ledger seed failed for ${callId}:`, e);
  }

  const mod = newCoreFor(SLUG);
  if (!mod) {
    console.error('[DEMO-LINE] FATAL: no ticket agent module for the demo line');
    void endCall(twilio, 'no module');
    return;
  }
  mod.start(callId);
  console.info(`[DEMO-LINE] ${callId} started (caller ${callerPhone || 'unknown'})`);

  connectOpenAI(call);
}

function connectOpenAI(call: DemoCall): void {
  const key = process.env.OPENAI_API_KEY;
  if (!key && !process.env.DEMO_OPENAI_URL) {
    console.error('[DEMO-LINE] FATAL: OPENAI_API_KEY is not set');
    void endCall(call.twilio, 'no api key');
    return;
  }

  // DEMO_OPENAI_URL points the line at a local fake so the ENTIRE path —
  // Twilio socket in, agent, forced lines, audio out — runs in a test
  // without a phone call. Unset in production, where it is the real API.
  const override = process.env.DEMO_OPENAI_URL;
  const ws = override
    ? new WebSocket(override)
    : new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
  call.openai = ws;

  ws.on('open', () => {
    // g711 μ-law both directions: exactly what Twilio streams, so no
    // resampling anywhere and no static.
    send(ws, {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: MODEL,
        instructions: MOUTHPIECE_INSTRUCTIONS,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            noise_reduction: { type: 'far_field' },
            transcription: { model: 'gpt-4o-transcribe' },
            // create_response FALSE is the whole design. The model never
            // decides to answer; the ticket agent decides, and we forward
            // its words. That is what stops two agents talking at once.
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'low',
              create_response: false,
              interrupt_response: true,
            },
          },
          output: { format: { type: 'audio/pcmu' }, voice: VOICE },
        },
        tools: [],
        tool_choice: 'none',
      },
    });

    const greeting = greetingFor();
    call.transcript.push(`AGENT: ${greeting}`);
    speak(call, greeting);
    console.info(`[DEMO-LINE] ${call.callId} greeting sent`);
  });

  ws.on('message', (raw) => {
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (evt.type) {
      // Agent audio → straight back down the Twilio socket.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (call.streamSid && call.twilio.readyState === WebSocket.OPEN) {
          call.twilio.send(
            JSON.stringify({ event: 'media', streamSid: call.streamSid, media: { payload: evt.delta } }),
          );
        }
        break;

      // The caller interrupted: drop the audio Twilio has already buffered,
      // or the agent keeps talking over them for seconds.
      case 'input_audio_buffer.speech_started':
        if (call.speaking && call.streamSid && call.twilio.readyState === WebSocket.OPEN) {
          call.twilio.send(JSON.stringify({ event: 'clear', streamSid: call.streamSid }));
        }
        break;

      case 'response.done':
        call.speaking = false;
        if (call.closing) void endCall(call.twilio, 'wrap complete');
        break;

      // The caller finished a sentence. This is the only input the agent gets.
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(evt.transcript ?? '').trim();
        if (text) void onCallerSaid(call, text);
        break;
      }

      case 'error':
        console.error(`[DEMO-LINE] openai error on ${call.callId}:`, JSON.stringify(evt.error ?? evt));
        break;

      default:
        break;
    }
  });

  ws.on('error', (e) => console.error(`[DEMO-LINE] openai socket error on ${call.callId}:`, e));
  ws.on('close', () => {
    if (!call.closing) console.warn(`[DEMO-LINE] openai socket closed early on ${call.callId}`);
  });
}

/** The greeting is config, not code — edit ticket_agent_config.greeting. */
function greetingFor(): string {
  try {
    return cachedConfig(SLUG).greeting?.trim() || FALLBACK_GREETING;
  } catch {
    return FALLBACK_GREETING;
  }
}

// ------------------------------------------------------------- the dialogue

async function onCallerSaid(call: DemoCall, text: string): Promise<void> {
  call.transcript.push(`CALLER: ${text}`);
  const mod = newCoreFor(SLUG);
  if (!mod) return;

  let action: CoreAction | null;
  try {
    action = await mod.onUtterance(call.callId, text);
  } catch (e) {
    console.error(`[DEMO-LINE] ticket agent threw on ${call.callId}:`, e);
    return;
  }

  const lines: string[] = [];
  let hangUp = false;
  while (action) {
    if (action.say) lines.push(action.say);
    if (action.alert) console.error(`[DEMO-LINE][ALERT] ${action.alert}`);
    if (action.endCall) hangUp = true;
    action = action.followUp ? await action.followUp() : null;
  }

  if (!lines.length) {
    // Silence is a real answer here (the agent is waiting), but it is also
    // how a stuck state machine looks — so it is never silent in the log.
    console.info(`[DEMO-LINE] ${call.callId} state=${mod.stateOf(call.callId)} — nothing to say`);
    return;
  }

  const said = lines.join(' ');
  call.transcript.push(`AGENT: ${said}`);
  console.info(`[DEMO-LINE] ${call.callId} state=${mod.stateOf(call.callId)} say="${said.slice(0, 120)}"`);
  speak(call, said);
  if (hangUp) call.closing = true; // hang up once this line finishes playing
}

/** Force exact words. The model is told to read, not to compose. */
function speak(call: DemoCall, words: string): void {
  if (call.openai?.readyState !== WebSocket.OPEN) return;
  call.speaking = true;
  send(call.openai, {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions: `Say exactly this, word for word, and nothing else: "${words}"`,
    },
  });
}

// ---------------------------------------------------------------- teardown

async function endCall(twilio: WebSocket, reason: string): Promise<void> {
  const call = calls.get(twilio);
  if (!call) return;
  calls.delete(twilio);
  console.info(`[DEMO-LINE] ${call.callId} ending (${reason})`);

  const mod = newCoreFor(SLUG);
  try {
    // A caller who hangs up mid-flow still gets their ticket filed, if we
    // learned enough to act on it. That rule lives in the agent.
    const r = await mod?.finalize?.(call.callId);
    if (r?.filed) console.info(`[DEMO-LINE] ${call.callId} hang-up ticket filed`);
    if (r?.alert) console.error(`[DEMO-LINE][ALERT] ${r.alert}`);
  } catch (e) {
    console.warn(`[DEMO-LINE] finalize failed for ${call.callId}:`, e);
  }
  try {
    mod?.release(call.callId);
    releaseLedger(call.callId);
  } catch {
    /* teardown is best effort */
  }

  console.info(`[DEMO-LINE] ===== transcript ${call.callId} =====\n${call.transcript.join('\n')}\n=====`);

  try {
    call.openai?.close();
  } catch {
    /* already gone */
  }
  try {
    if (twilio.readyState === WebSocket.OPEN) twilio.close();
  } catch {
    /* already gone */
  }
}

function send(ws: WebSocket, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.warn('[DEMO-LINE] send failed:', e);
  }
}
