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
import { buildTranscriptionConfig, activeKeywords, TRANSCRIPTION_PROMPT } from '../config/transcription';
import { buildSideTranscribers, configuredEngines, primaryEngine, type Transcriber } from './transcribers';
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

/**
 * What this build of the line actually DOES, stamped on every call.
 *
 * Half of 2026-08-09 was spent arguing about which build answered a call —
 * asking the operator to check a deploy number, guessing from behaviour,
 * being wrong. A version number would need maintaining and would lie the
 * first time someone forgot. This describes CAPABILITIES instead, so the
 * call record answers "which build was this?" without anyone remembering
 * anything. Add a behaviour, add it here.
 */
const LINE_CAPABILITIES = ['tuned-transcriber', 'speech-gated-turns', 'no-self-response', 'stt-bench'].join(',');

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
  /**
   * Did the VAD actually hear the caller since we last accepted a turn?
   * Transcription models hallucinate words out of silence and line noise, and
   * those phantom turns drive the state machine: a live call (17:21) processed
   * an "Okay" the caller never said, then heard him say "I haven't even spoken
   * a single word yet" — by which point an ask had already been spent. Worse,
   * hallucinated Spanish fragments trip the language switch, so the agent
   * starts answering in Spanish to a silent line.
   */
  heardSpeech: boolean;
  /** Extra engines listening to the same audio (the bench). */
  sideEars: Transcriber[];
  /** Whose words the agent acts on. */
  primary: string;
  /** Every engine's final text for the current turn, for the comparison log. */
  heard: Map<string, string>;
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
    res.json({ ok: true, line: SLUG, active: calls.size, streamPath: STREAM_PATH, capabilities: LINE_CAPABILITIES.split(',') });
  });

  /**
   * Prove each transcriber actually connects — BEFORE a call is spent finding
   * out. Opens a real socket to every configured engine with the real key and
   * the real parameters, then closes it, and reports exactly what failed.
   *
   * A wrong key gives a silent failure that looks identical to a bad
   * transcript: the engine's column just reads "—". That would make a vendor
   * look terrible in a comparison it was never part of.
   */
  app.get('/demo/stt-check', async (_req: Request, res: Response) => {
    const engines = configuredEngines();
    const results: Array<Record<string, unknown>> = [];

    for (const name of engines) {
      if (name === 'openai') {
        results.push({
          engine: 'openai',
          ok: Boolean(process.env.OPENAI_API_KEY),
          note: 'transcribes inside the realtime session; no separate socket',
        });
        continue;
      }
      const ear = buildSideTranscribers({ ...process.env, STT_ENGINES: name } as NodeJS.ProcessEnv)[0];
      if (!ear) {
        results.push({ engine: name, ok: false, error: 'no adapter built' });
        continue;
      }
      const started = Date.now();
      try {
        await Promise.race([
          ear.start({
            keyterms: activeKeywords(),
            prompt: TRANSCRIPTION_PROMPT,
            onTurn: () => undefined,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 8s')), 8000)),
        ]);
        results.push({ engine: name, ok: true, connectMs: Date.now() - started });
      } catch (e) {
        results.push({
          engine: name,
          ok: false,
          connectMs: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        await ear.stop().catch(() => undefined);
      }
    }

    // The keyterms are part of the test: if the roster query failed, every
    // engine is running on seed words instead of this practice's real
    // provider surnames and offices, and the comparison is skewed for all of
    // them equally but for no good reason. A boot-time [ROSTER] failure is
    // one line in a wall of deploy noise; here it is unmissable.
    const { rosterStatus } = await import('../services/providerRoster');
    const roster = rosterStatus();
    const keyterms = activeKeywords();

    const allOk = results.every((r) => r.ok);
    console.info(`[STT-CHECK] ${results.map((r) => `${r.engine}=${r.ok ? 'ok' : 'FAIL'}`).join(' ')}`);
    res.status(allOk ? 200 : 503).json({
      ok: allOk,
      primary: primaryEngine(),
      engines: results,
      keyterms: {
        count: keyterms.length,
        rosterLoaded: roster.loaded,
        providers: roster.providers,
        offices: roster.offices,
        note: roster.loaded
          ? 'real provider and office names are boosted on every engine'
          : 'ROSTER NOT LOADED — engines are running on the seed word list only',
        sample: keyterms.slice(0, 8),
      },
      hint: allOk ? 'all engines connected — make the call' : 'fix the failing engine before spending a call',
    });
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
          if (call && msg.media?.payload) {
            // The SAME bytes to every engine — that is what makes the
            // comparison fair. Decoded once, μ-law, never resampled.
            if (call.sideEars.length) {
              const pcmu = Buffer.from(msg.media.payload, 'base64');
              for (const ear of call.sideEars) ear.sendAudio(pcmu);
            }
          }
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

  console.info(
    `[DEMO-LINE] ready — POST /demo/voice, stream ${STREAM_PATH} [${LINE_CAPABILITIES}] ` +
      `engines=${configuredEngines().join('+')} primary=${primaryEngine()}`,
  );
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
    heardSpeech: false,
    sideEars: [],
    primary: primaryEngine(),
    heard: new Map(),
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
  console.info(
    `[DEMO-LINE] ${callId} started (caller ${callerPhone || 'unknown'}) ` +
      `engines=${configuredEngines().join('+')} primary=${call.primary}`,
  );

  startSideEars(call);
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
            // The SAME tuned transcriber the production lines use: the
            // practice's languages, a prompt describing an eye-care phone
            // call, and surname keywords. Asking for the bare model here —
            // which is what this line did at first — is why a live call
            // transcribed "Wayne Fabian" as "20 Fabian", produced "Not
            // Dwyane Wade", and once answered in Vietnamese. The state
            // machine was reading noise and behaving correctly on it.
            transcription: buildTranscriptionConfig(),
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
        call.heardSpeech = true;
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
        if (!text) break;
        // No speech was detected since the last turn, so whatever the
        // transcriber produced came from silence. Dropping it is always right:
        // the caller cannot have answered a question they never heard, and a
        // phantom answer is worse than no answer — it spends an ask and can
        // flip the whole call into another language.
        if (!call.heardSpeech) {
          console.info(`[DEMO-LINE] ${call.callId} ignored a transcript with no speech behind it: "${text.slice(0, 60)}"`);
          break;
        }
        call.heard.set('openai', text);
        void acceptTurn(call, text, 'openai');
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

/**
 * Open the extra engines. Each one is independent: a failure to connect costs
 * us that engine's opinion and nothing else, which is exactly the property a
 * bench needs — a broken vendor must not look like a bad transcript.
 */
function startSideEars(call: DemoCall): void {
  const ears = buildSideTranscribers();
  if (!ears.length) return;
  const keyterms = activeKeywords();
  for (const ear of ears) {
    ear
      .start({
        keyterms,
        prompt: TRANSCRIPTION_PROMPT,
        onSpeechStarted: () => {
          call.heardSpeech = true;
        },
        onTurn: (turn) => {
          if (!turn.isFinal) return; // partials are noise in a comparison
          call.heard.set(turn.engine, turn.text);
          if (turn.engine === call.primary) void acceptTurn(call, turn.text, turn.engine);
        },
        onError: (e) => console.warn(`[STT] ${ear.name} error on ${call.callId}:`, e),
      })
      .then(() => {
        call.sideEars.push(ear);
        console.info(`[STT] ${ear.name} listening on ${call.callId}`);
      })
      .catch((e) => {
        console.error(`[STT] ${ear.name} could NOT start on ${call.callId} — its column will be blank:`, e);
      });
  }
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

/**
 * One turn, every engine's answer, side by side — then the agent acts on the
 * primary's version only.
 *
 * The log line is the deliverable of the whole bench:
 *
 *   [STT-BENCH] ...  openai="20 Fabian" | assemblyai="Wayne Fabian" | deepgram="Wayne Fabian"
 *
 * A short settle window lets the slower engines land before we print, so the
 * row is complete. The AGENT is never delayed by it — if the primary is ready,
 * it acts immediately; the comparison print is what waits.
 */
async function acceptTurn(call: DemoCall, text: string, engine: string): Promise<void> {
  if (engine !== call.primary) return; // a side engine's turn is data, not input
  call.heardSpeech = false;

  const expected = configuredEngines().length;
  const settleMs = expected > 1 ? 400 : 0;
  setTimeout(() => {
    const row = configuredEngines()
      .map((e) => `${e}="${call.heard.get(e) ?? '—'}"`)
      .join(' | ');
    console.info(`[STT-BENCH] ${call.callId} ${row}`);
    call.transcript.push(`BENCH: ${row}`);
    call.heard.clear();
  }, settleMs);

  await onCallerSaid(call, text);
}

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
  // Tell the ears what we just asked. Right after "and the patient's date of
  // birth?", a transcriber that knows this is expecting a date — which is
  // precisely where today's calls fell apart.
  for (const ear of call.sideEars) ear.setAgentContext?.(said);
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
  void recordCall(call);

  for (const ear of call.sideEars) {
    // Never awaited: an unresponsive vendor must not hold the call open, and
    // an unterminated session bills until their cap.
    void ear.stop().catch(() => undefined);
  }
  call.sideEars = [];

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

/**
 * Write the call to call_logs so a demo call can be READ, not recited.
 * Every round of "paste me the logs" costs the operator a call and me a turn;
 * the transcript belongs somewhere both of us can query. Best effort by
 * design — a logging failure must never affect the call, which by this point
 * has already ended anyway.
 */
async function recordCall(call: DemoCall): Promise<void> {
  try {
    const { storage } = await import('../../server/storage');
    const agent = await storage.getAgentBySlug(SLUG);
    await storage.createCallLog({
      callSid: call.callId,
      agentId: agent?.id,
      direction: 'inbound',
      from: call.callerPhone ? `+1${call.callerPhone}` : 'unknown',
      to: '+16265482660',
      dialedNumber: '+16265482660',
      status: 'completed',
      transcript: call.transcript.join('\n'),
      agentUsed: SLUG,
      agentVersion: LINE_CAPABILITIES,
      environment: process.env.APP_ENV ?? 'development',
    } as never);
    console.info(`[DEMO-LINE] ${call.callId} written to call_logs`);
  } catch (e) {
    console.warn(`[DEMO-LINE] could not write call_logs for ${call.callId}:`, e);
  }
}

function send(ws: WebSocket, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.warn('[DEMO-LINE] send failed:', e);
  }
}
