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
import { ticketAgentFor } from '../core/router';
import { buildTranscriptionConfig, activeKeywords, TRANSCRIPTION_PROMPT } from '../config/transcription';
import { buildSideTranscribers, configuredEngines, primaryEngine, type Transcriber } from './transcribers';
import { cachedConfig } from '../core/ticketAgentConfig';
import { seedLedger, releaseLedger } from '../services/callFactsLedger';
import type { CoreAction } from '../core/types';

/** The line this call is for. Any slug: the URL a number points at decides. */
const DEFAULT_SLUG = 'demo';
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
 * Said once when the caller keeps talking after the line has finished, then
 * the call is closed. Anything is better than the open, silent line a caller
 * experiences as a dropped call.
 */
/**
 * Said when no transcriber came up, then the call ends. A caller who is told
 * straight away has lost ten seconds; a caller left talking to a line that
 * cannot hear has lost their whole call and still needs to ring back.
 */
const DEAF_LINE =
  "I'm sorry — we're having a technical problem with this line and I can't hear you. " +
  'Please call our office directly and someone will help you right away.';

const WRAP_AFTER_END =
  "I've got everything I need and someone will follow up with you. Thanks for calling Azul Vision — take care.";

/**
 * ~100ms of 8kHz G.711 mu-law (1 byte per sample). Twilio streams 20ms
 * frames; AssemblyAI requires 50-1000ms and closes the socket with 3007
 * outside that range. 100ms sits comfortably inside every vendor's window.
 */
const PCMU_CHUNK_BYTES = 800;

/**
 * How long the agent will wait for the PRIMARY engine before acting on
 * whatever another engine heard. A vendor experiment must never be able to
 * mute the line: on 2026-08-10 the primary produced nothing and the caller
 * talked to silence for a whole call.
 */
const PRIMARY_GRACE_MS = 1200;

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
  /** Which line answered — demo, answering-service, whatever points here. */
  slug: string;
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
  /**
   * Twilio sends 20ms frames (160 bytes of 8kHz mu-law). AssemblyAI requires
   * 50-1000ms per chunk and closes with 3007 outside that, so forwarding
   * Twilio's frames unchanged produced a connected socket that never emitted
   * a single turn — and, because the agent only acts on the primary engine, a
   * caller who talked to total silence. Frames are accumulated to ~100ms.
   */
  pcmuBuffer: Buffer[];
  pcmuBytes: number;
  /** Set when a bench row is already scheduled, so it prints once per turn. */
  benchPending: boolean;
  /** Waiting on the primary engine before falling back to another. */
  primaryGrace: ReturnType<typeof setTimeout> | null;
  /**
   * WHY the call ended, and what the model socket did. "The calls are
   * dropping" has two completely different causes that feel identical to a
   * caller — our socket closing (Twilio ends the call instantly, because
   * <Connect><Stream> is bound to it) versus the agent going mute on an open
   * line — and neither is visible in a transcript. Both are recorded now.
   */
  endReason: string | null;
  openaiClose: string | null;
  /**
   * ONE response at a time. The Realtime API refuses a response.create while
   * another is active, so firing a line per turn without waiting silently
   * DROPPED lines — the operator never heard "I'm not finding a match" or
   * "someone will call you back", both of which are in the transcript — and
   * whatever did queue played in a burst afterwards ("the next thing I heard
   * was the agent offering several appointments at once").
   */
  responseActive: boolean;
  pendingSpeech: string[];
  /**
   * The words we asked for, and where that line sits in the transcript.
   *
   * The model is a mouthpiece, but it is still a model: told to "say exactly
   * this", it sometimes warms the line up, reorders it, or adds a sentence of
   * its own — and a line the caller interrupts is cut off partway. Recording
   * the REQUEST as though it were the RECORD is exactly the complaint that
   * found this: "there are things the agent is saying that are not in the
   * transcripts — I'm hearing something but the transcripts show something
   * else." The model reports what it actually spoke. That is what the
   * transcript holds now; the line as written is kept beside it whenever the
   * two differ, so the gap is visible instead of invisible.
   */
  requestedLine: string | null;
  requestedIndex: number | null;
  spokenHeard: boolean;
  /**
   * Playback, from Twilio — the ONLY thing that means the caller heard it.
   *
   * Everything else in this file is upstream of the caller's ear: the words
   * we chose, the words the model generated, the audio we handed to Twilio.
   * All three can be complete and correct while the caller hears silence, and
   * for a whole afternoon they were. A `mark` sent after a line comes back
   * only once Twilio has finished playing everything queued before it, so an
   * agent line with no returning mark is a line nobody heard.
   */
  agentLines: number[];
  pendingMarks: Map<string, number>;
  playedLines: Set<number>;
  /**
   * The mark we are holding the call open for, and the belt-and-braces timer
   * behind it.
   *
   * <Connect><Stream> binds the call to this socket, so closing it hangs up
   * INSTANTLY — including on however many seconds of goodbye Twilio has
   * buffered but not yet played. Ending on response.done ended the call when
   * the model finished GENERATING, which is why every sign-off in the 18:23
   * and 18:24 calls is stamped NOT HEARD. We wait for Twilio to say it
   * played.
   */
  finalMark: string | null;
  finalMarkTimer: ReturnType<typeof setTimeout> | null;
  /** μ-law bytes forwarded for the line currently playing (8000 = 1 second). */
  responseAudioBytes: number;
  /** No transcriber started: the line cannot hear a word the caller says. */
  deaf: boolean;
}

const calls = new Map<WebSocket, DemoCall>();

export function mountDemoLine(app: Express, server: HttpServer): void {
  // The keyterms every transcriber gets come from this roster, and it is
  // per-process module state. This process is not the voice server, so
  // nothing here had ever started it: rosterLoaded was false forever and all
  // three engines ran on seed words. Starting it is idempotent.
  void import('../services/providerRoster')
    .then(({ startProviderRosterRefresh }) => startProviderRosterRefresh())
    .catch((e) => console.warn('[DEMO-LINE] roster refresh unavailable (seed keyterms only):', e));

  // ---------------------------------------------------------------- webhook
  // Twilio asks what to do with the call. The answer is always the same:
  // stream the audio to us. No IVR, no conference, no lookup, no branching.
  /**
   * Answer a call and stream its audio here. The URL a phone number points at
   * chooses the line — that IS the switch, and changing it back in Twilio is
   * an instant, deploy-free rollback to whatever answered before.
   */
  const answer = (slug: string) => (req: Request, res: Response) => {
    const f = formFields(req.body);
    const from = f.get('From') ?? '';
    const callSid = f.get('CallSid') ?? '';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
    console.info(`[LINE:${slug}] call ${callSid} from ${from} → streaming to wss://${host}${STREAM_PATH}`);

    res.set('Content-Type', 'text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${xmlEscape(host)}${STREAM_PATH}">
      <Parameter name="slug" value="${xmlEscape(slug)}"/>
      <Parameter name="from" value="${xmlEscape(from)}"/>
      <Parameter name="callSid" value="${xmlEscape(callSid)}"/>
    </Stream>
  </Connect>
</Response>`,
    );
  };

  app.post('/demo/voice', answer(DEFAULT_SLUG));
  // Any line: /line/answering-service/voice, /line/no-ivr/voice, ...
  app.post('/line/:slug/voice', (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      console.warn(`[LINE] refusing a malformed slug "${req.params.slug}"`);
      res.status(400).send('bad line');
      return;
    }
    answer(slug)(req, res);
  });

  // A plain GET so the line can be proved reachable from a browser.
  app.get('/demo/health', (_req: Request, res: Response) => {
    res.json({ ok: true, line: DEFAULT_SLUG, active: calls.size, streamPath: STREAM_PATH, capabilities: LINE_CAPABILITIES.split(',') });
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
          // The caller's audio does NOT go to OpenAI. That session is a
          // speaker and nothing else now. See MOUTHPIECE_INSTRUCTIONS.
          break;
        }
        case 'mark': {
          // Twilio finished playing everything queued before this mark.
          const call = calls.get(twilio);
          const name = String(msg.mark?.name ?? '');
          const idx = call?.pendingMarks.get(name);
          if (call && idx !== undefined) {
            call.pendingMarks.delete(name);
            call.playedLines.add(idx);
          }
          // The caller has now heard the last thing we had to say. THIS is
          // the moment it is safe to hang up.
          if (call && call.finalMark && call.finalMark === name) {
            if (call.finalMarkTimer) clearTimeout(call.finalMarkTimer);
            call.finalMarkTimer = null;
            call.finalMark = null;
            void endCall(twilio, 'wrap complete (heard)');
          }
          break;
        }
        case 'stop':
          void endCall(twilio, 'twilio stop');
          break;
        default:
          break; // 'connected' — nothing to do
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
    slug: String(params.slug ?? msg.start?.slug ?? DEFAULT_SLUG),
    streamSid: msg.start?.streamSid ?? msg.streamSid ?? null,
    callerPhone,
    twilio,
    openai: null,
    transcript: [],
    closing: false,
    speaking: false,
    heardSpeech: false,
    sideEars: [],
    primary: primaryEngine() ?? '',
    heard: new Map(),
    pcmuBuffer: [],
    pcmuBytes: 0,
    benchPending: false,
    primaryGrace: null,
    endReason: null,
    openaiClose: null,
    responseActive: false,
    pendingSpeech: [],
    requestedLine: null,
    requestedIndex: null,
    spokenHeard: false,
    agentLines: [],
    pendingMarks: new Map(),
    playedLines: new Set(),
    deaf: false,
    finalMark: null,
    finalMarkTimer: null,
    responseAudioBytes: 0,
  };
  calls.set(twilio, call);

  // The agent reads the caller's number from the ledger when it needs a
  // callback, so seed it before the first word — same as every other line.
  try {
    seedLedger(callId, { callerPhone: callerPhone || undefined });
  } catch (e) {
    console.warn(`[DEMO-LINE] ledger seed failed for ${callId}:`, e);
  }

  const mod = ticketAgentFor(call.slug);
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
          // NO input configuration at all: no format, no transcription, no
          // turn detection. This session never receives a byte of the
          // caller's audio, so there is nothing for it to transcribe and
          // nothing for a VAD to detect. Deepgram is the ear.
          output: { format: { type: 'audio/pcmu' }, voice: VOICE },
        },
        tools: [],
        tool_choice: 'none',
      },
    });

    if (call.deaf) {
      // Never greet a caller warmly on a line that cannot hear them. They
      // will talk for a minute before realising, and that minute is worse
      // than being told immediately.
      call.closing = true;
      speak(call, DEAF_LINE);
      return;
    }
    const greeting = greetingFor(call.slug);
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
          // Count what we hand over: μ-law at 8kHz is one byte per sample, so
          // these bytes ARE the playback time. That is how long the caller
          // still needs before a hang-up is safe.
          call.responseAudioBytes += base64Bytes(String(evt.delta ?? ''));
          call.twilio.send(
            JSON.stringify({ event: 'media', streamSid: call.streamSid, media: { payload: evt.delta } }),
          );
        }
        break;

      // What the model ACTUALLY said. The GA event and the older beta name
      // both appear in the wild, so both are honoured.
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        recordWhatWasSpoken(call, String(evt.transcript ?? ''));
        break;

      case 'response.done':
        call.speaking = false;
        call.responseActive = false;
        // The line played and the model never told us what came out of it, so
        // the transcript is holding a line nobody can confirm was spoken.
        // Say so rather than let it read as fact.
        if (call.requestedIndex !== null && !call.spokenHeard) {
          const status = String(evt.response?.status ?? '');
          const why = status && status !== 'completed' ? status : 'no transcript from the model';
          call.transcript[call.requestedIndex] += `   [unconfirmed: ${why}]`;
          console.warn(
            `[DEMO-LINE] ${call.callId} played a line the model never transcribed (${why}): ` +
              `"${(call.requestedLine ?? '').slice(0, 60)}"`,
          );
        }
        // All of this line's audio is now queued at Twilio. A mark behind it
        // comes back when Twilio has finished PLAYING it — the moment the
        // caller has actually heard the line, and the only such moment we
        // ever get.
        if (call.requestedIndex !== null && call.streamSid && call.twilio.readyState === WebSocket.OPEN) {
          const name = `line-${call.requestedIndex}`;
          call.pendingMarks.set(name, call.requestedIndex);
          call.twilio.send(JSON.stringify({ event: 'mark', streamSid: call.streamSid, mark: { name } }));
          // If this was the last thing we intend to say, the call must stay up
          // until Twilio confirms it PLAYED — not until the model finished
          // writing it.
          if (call.closing && !call.pendingSpeech.length) call.finalMark = name;
        }
        call.requestedIndex = null;
        call.requestedLine = null;
        if (call.pendingSpeech.length) {
          drainSpeech(call);
          break; // the wrap waits until everything queued has been heard
        }
        if (call.closing) waitForPlaybackThenEnd(call);
        break;

      // A transcript from THIS session can no longer exist — we send it no
      // audio and ask it for no transcription. If one ever appears it is not
      // the caller, so it must never reach the agent.
      case 'conversation.item.input_audio_transcription.completed':
        console.error(
          `[DEMO-LINE][ALERT] ${call.callId} the model produced a transcript from a session ` +
            `we send no audio to — IGNORED: "${String(evt.transcript ?? '').slice(0, 120)}"`,
        );
        break;

      case 'error':
        console.error(`[DEMO-LINE] openai error on ${call.callId}:`, JSON.stringify(evt.error ?? evt));
        break;

      default:
        break;
    }
  });

  ws.on('error', (e) => console.error(`[DEMO-LINE] openai socket error on ${call.callId}:`, e));
  ws.on('close', (code, reason) => {
    call.openaiClose = `${code}${reason?.toString() ? ` ${reason.toString()}` : ''}`;
    if (call.closing) return;
    // The model socket died mid-call. Nothing can speak any more, so holding
    // the line open just gives the caller silence they will describe as a
    // dropped call. End it deliberately and say so in the record.
    console.error(`[DEMO-LINE] openai socket closed MID-CALL on ${call.callId}: ${call.openaiClose}`);
    call.endReason = `openai socket closed mid-call (${call.openaiClose})`;
    void endCall(call.twilio, call.endReason);
  });
}

/**
 * Open the extra engines. Each one is independent: a failure to connect costs
 * us that engine's opinion and nothing else, which is exactly the property a
 * bench needs — a broken vendor must not look like a bad transcript.
 */
function startSideEars(call: DemoCall): void {
  const ears = buildSideTranscribers();
  // Nothing is listening. Since OpenAI stopped being an ear this is a real
  // possibility — a bad STT_ENGINES, a missing key — and the failure mode is
  // the worst one there is: a caller talking to a line that answers warmly
  // and hears nothing. Say so and hand them to a human path.
  if (!ears.length) {
    console.error(`[DEMO-LINE][ALERT] ${call.callId} NO TRANSCRIBER — the line cannot hear the caller`);
    call.deaf = true;
    return;
  }
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
          // EVERY final turn goes to acceptTurn, which decides what to do
          // with it. Filtering on the primary here left the failover inside
          // acceptTurn unreachable by any side ear — it was only ever entered
          // from the OpenAI path, and that path is gone. A slow or broken
          // primary would then have left the caller talking to silence with
          // a working engine sitting right there.
          void acceptTurn(call, turn.text, turn.engine);
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
function greetingFor(slug: string): string {
  try {
    return cachedConfig(slug).greeting?.trim() || FALLBACK_GREETING;
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
  // Record every engine's answer, whoever produced it, and print the row
  // ONCE per turn. Gating the row on the primary meant that when the primary
  // went quiet we lost the comparison too — precisely when it was needed.
  call.heard.set(engine, text);
  if (!call.benchPending) {
    call.benchPending = true;
    setTimeout(() => {
      call.benchPending = false;
      const row = configuredEngines()
        .map((e) => `${e}="${call.heard.get(e) ?? '—'}"`)
        .join(' | ');
      // The bench belongs in the LOG, not in the transcript. That transcript
      // is a patient record; vendor diagnostics interleaved with what the
      // caller said made it unreadable, and the operator had to ask what
      // "BENCH" even was. Keep the comparison, keep it out of the record.
      console.info(`[STT-BENCH] ${call.callId} ${row}`);
      call.heard.clear();
    }, configuredEngines().length > 1 ? 400 : 0);
  }

  if (engine === call.primary) {
    call.heardSpeech = false;
    if (call.primaryGrace) {
      clearTimeout(call.primaryGrace);
      call.primaryGrace = null;
    }
    await onCallerSaid(call, text);
    return;
  }

  // A NON-primary engine heard something. Give the primary a moment, then act
  // on this rather than leaving the caller in silence. A vendor being slow or
  // broken must degrade the experiment, never the call.
  //
  // But ONLY if this speech has not already been answered. heardSpeech is set
  // by the VAD and cleared the moment any engine's words are acted on, so a
  // slower engine reporting the SAME utterance finds it false and stops here.
  // Without this the agent answered every turn twice — the live 13:34
  // scheduling call was asked "new patient or existing patient?" and "may I
  // have the patient's name?" twice each, from one sentence.
  if (!call.heardSpeech) return;
  if (call.primaryGrace) return; // already waiting
  call.primaryGrace = setTimeout(() => {
    call.primaryGrace = null;
    const fallback = call.heard.get(engine) ?? text;
    console.warn(
      `[STT-BENCH] ${call.callId} primary "${call.primary}" produced nothing for this turn — ` +
        `falling back to "${engine}" so the caller is not left in silence`,
    );
    call.heardSpeech = false;
    void onCallerSaid(call, fallback);
  }, PRIMARY_GRACE_MS);
}

async function onCallerSaid(call: DemoCall, text: string): Promise<void> {
  call.transcript.push(`CALLER: ${text}`);
  const mod = ticketAgentFor(call.slug);

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
    const state = mod.stateOf(call.callId);
    // A FINISHED machine that keeps being spoken to is the "dropped call" the
    // operator reported: the line is still open, the caller says "Hello?
    // Hello? Hello?", and nothing answers. Silence while COLLECTING is the
    // agent waiting its turn; silence at the END is an abandoned caller.
    if (state === null || /ENDED|DONE/.test(state)) {
      console.warn(`[DEMO-LINE] ${call.callId} caller still talking after the line finished (${state}) — closing the call`);
      call.closing = true;
      speak(call, WRAP_AFTER_END);
      return;
    }
    // Silence is a real answer here (the agent is waiting), but it is also
    // how a stuck state machine looks — so it is never silent in the log.
    console.info(`[DEMO-LINE] ${call.callId} state=${state} — nothing to say`);
    return;
  }

  const said = lines.join(' ');
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
  if (call.responseActive) {
    // Queued, not dropped. This is the line the caller would otherwise never
    // have heard.
    call.pendingSpeech.push(words);
    console.info(`[DEMO-LINE] ${call.callId} queued behind the line still playing: "${words.slice(0, 60)}"`);
    return;
  }
  emitSpeech(call, words);
}

function emitSpeech(call: DemoCall, words: string): void {
  if (call.openai?.readyState !== WebSocket.OPEN) return;
  call.speaking = true;
  call.responseActive = true;
  // Only NOW is it true that the caller will hear this, so only now does it
  // belong in the record — provisionally. What the model actually says
  // replaces this the moment it reports it back.
  call.transcript.push(`AGENT: ${words}`);
  call.requestedLine = words;
  call.requestedIndex = call.transcript.length - 1;
  call.agentLines.push(call.requestedIndex);
  call.spokenHeard = false;
  call.responseAudioBytes = 0; // this line's playback time, measured fresh
  send(call.openai, {
    type: 'response.create',
    response: {
      // THE root fix. Without these two fields this is an IN-CONVERSATION
      // response: the caller's audio is in the session, so every utterance is
      // a user turn, and response.create means "produce the next assistant
      // turn in this conversation" — with our words demoted to a suggestion.
      // That is why a caller complaining about hiccups got a paragraph of
      // hiccup remedies instead of "are you calling for a new patient or an
      // existing patient?". The model was not disobeying an instruction; it
      // was answering the conversation we handed it. No wording fixes that.
      //
      // Out-of-band (conversation 'none') with an EMPTY input gives the model
      // no conversation at all. The line is then the only content that
      // exists, and there is nothing to answer, agree with, or improvise on.
      conversation: 'none',
      input: [],
      output_modalities: ['audio'],
      // The session's instructions do NOT apply here: instructions on a
      // response REPLACE the session default for that response. So every
      // line the agent has ever spoken was generated with the mouthpiece
      // rules switched off, leaving one sentence and a model free to warm it
      // up, and that is why words reached the caller that were never in the
      // script. The rules ride along with every line now.
      instructions: `${MOUTHPIECE_INSTRUCTIONS}\nSay exactly this, word for word, and nothing else: "${words}"`,
    },
  });
}

/**
 * Replace the line we ASKED for with the line the caller actually HEARD.
 *
 * Two ways they differ, and both matter: the model rewrites or embellishes
 * what it was told to read, or the caller barges in and cuts it off partway.
 * Either way the written line is a guess about the call and the spoken line
 * is the call, so the spoken line wins and the guess is kept beside it.
 */
function recordWhatWasSpoken(call: DemoCall, spokenRaw: string): void {
  const spoken = spokenRaw.trim();
  if (!spoken) return;
  const idx = call.requestedIndex;
  const asked = call.requestedLine ?? '';
  call.spokenHeard = true;
  if (idx === null || !call.transcript[idx]?.startsWith('AGENT: ')) {
    // Speech we never asked for — nothing of ours is waiting on a report.
    // That is the mouthpiece rule broken, so it is loud in both records.
    call.transcript.push(`AGENT: ${spoken}   [UNPROMPTED — the model spoke on its own]`);
    console.error(`[DEMO-LINE] ${call.callId} the model spoke UNPROMPTED: "${spoken.slice(0, 120)}"`);
    return;
  }
  call.transcript[idx] = `AGENT: ${spoken}`;
  if (sameWords(spoken, asked)) return;
  call.transcript[idx] += `\n  ^ not what we wrote: "${asked}"`;
  console.warn(
    `[DEMO-LINE] ${call.callId} the model did not read the line as written.\n` +
      `  wrote: ${asked}\n  spoke: ${spoken}`,
  );
}

/** Same words, ignoring punctuation, casing and spacing. */
function sameWords(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return norm(a) === norm(b);
}

/** Byte length of base64 without allocating a Buffer for every 20ms frame. */
function base64Bytes(b64: string): number {
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/**
 * Hold the call open until the caller has actually heard the last line.
 *
 * The mark is the real signal. The timer behind it is only for the case where
 * the mark never comes back — a caller who hangs up mid-goodbye, a socket that
 * dies — and it is sized from the audio we sent rather than guessed: μ-law at
 * 8kHz is one byte per sample, so the bytes forwarded ARE the playback
 * milliseconds, times an eighth. A second of slack covers Twilio's own buffer.
 */
function waitForPlaybackThenEnd(call: DemoCall): void {
  if (!call.finalMark || call.twilio.readyState !== WebSocket.OPEN) {
    void endCall(call.twilio, 'wrap complete');
    return;
  }
  const playMs = Math.ceil(call.responseAudioBytes / 8) + 1000;
  console.info(
    `[DEMO-LINE] ${call.callId} holding the line ~${playMs}ms for the last line to finish playing`,
  );
  call.finalMarkTimer = setTimeout(() => {
    call.finalMarkTimer = null;
    console.warn(`[DEMO-LINE] ${call.callId} no playback mark came back — ending anyway`);
    void endCall(call.twilio, 'wrap complete (no mark)');
  }, playMs);
}

/** The next queued line, once the one before it has finished playing. */
function drainSpeech(call: DemoCall): void {
  const next = call.pendingSpeech.shift();
  if (next !== undefined) emitSpeech(call, next);
}

// ---------------------------------------------------------------- teardown

async function endCall(twilio: WebSocket, reason: string): Promise<void> {
  const call = calls.get(twilio);
  if (!call) return;
  call.endReason = call.endReason ?? reason;
  calls.delete(twilio);
  console.info(`[DEMO-LINE] ${call.callId} ending (${reason})`);

  const mod = ticketAgentFor(call.slug);
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

  // A line still in flight when the call ended is a line nobody can promise
  // was heard — the caller may have hung up in the middle of it.
  if (call.requestedIndex !== null && !call.spokenHeard) {
    call.transcript[call.requestedIndex] += '   [unconfirmed: the call ended while this was playing]';
  }
  // Now the part that matters: which lines did Twilio actually PLAY. Anything
  // the caller never heard is said so in the record, instead of sitting there
  // looking like it was heard.
  const unheard = call.agentLines.filter((i) => !call.playedLines.has(i));
  for (const i of unheard) call.transcript[i] += '   [NOT HEARD — Twilio never finished playing this]';
  if (unheard.length) {
    console.warn(
      `[DEMO-LINE] ${call.callId} ${unheard.length} of ${call.agentLines.length} agent lines never finished playing`,
    );
  }
  call.transcript.push(`END: ${call.endReason ?? 'unknown'} | openai socket: ${call.openaiClose ?? 'still open'}`);
  console.info(`[DEMO-LINE] ===== transcript ${call.callId} =====\n${call.transcript.join('\n')}\n=====`);
  void recordCall(call);

  if (call.primaryGrace) {
    clearTimeout(call.primaryGrace);
    call.primaryGrace = null;
  }
  if (call.finalMarkTimer) {
    clearTimeout(call.finalMarkTimer);
    call.finalMarkTimer = null;
  }
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
    const agent = await storage.getAgentBySlug(call.slug);
    await storage.createCallLog({
      callSid: call.callId,
      agentId: agent?.id,
      direction: 'inbound',
      from: call.callerPhone ? `+1${call.callerPhone}` : 'unknown',
      to: '+16265482660',
      dialedNumber: '+16265482660',
      status: 'completed',
      transcript: call.transcript.join('\n'),
      agentUsed: call.slug,
      agentVersion: LINE_CAPABILITIES,
      callDisposition: `end=${call.endReason ?? 'unknown'}; openai=${call.openaiClose ?? 'open'}`,
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
