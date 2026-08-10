/**
 * The demo line, end to end, with no phone call.
 *
 * A real Express server, a real WebSocket upgrade, a real Twilio media-stream
 * client, a fake Deepgram standing in for the ear and a fake OpenAI Realtime
 * standing in for the mouth. Every layer this file owns is exercised: the
 * TwiML the number answers with, the socket handshake, the session config,
 * the greeting, the caller's words reaching the ticket agent, and the agent's
 * forced lines coming back as audio the caller would hear.
 *
 * The caller speaks through DEEPGRAM, not through the model. That is the
 * point: OpenAI's speech-to-text fabricated whole passages of fiction out of
 * silence and the agent answered them on live patient calls, so its session
 * receives no audio at all now. A test that fed words in through the model
 * would be testing a door that no longer exists.
 *
 * This exists because the demo line was tested by dialing it three times and
 * three times it was the wrong agent. That is not testing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';

// The ticket agent files tickets through real services; stub the submit path
// so a test never talks to the ticketing API.
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: { createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'DEMO-1' })) },
}));

let fakeOpenAI: WebSocketServer;
let fakeUrl: string;
/** Everything the "model" was told to say, in order. */
const forcedLines: string[] = [];
/** The full response.create payload for each of those lines. */
const responseCreates: Record<string, any>[] = [];
let sessionConfig: Record<string, any> | null = null;
/**
 * What the "model" actually speaks, given the line it was handed. null means
 * it reports nothing back. Default (unset) is a faithful reading.
 */
let speaks: ((asked: string) => string | null) | null = null;

let server: http.Server;
let baseUrl: string;

let fakeDeepgram: WebSocketServer;
/** Every ear socket the line has opened, newest last. */
const dgSockets: WebSocket[] = [];
/**
 * Ears opened since the process started. Monotonic on purpose: dgSockets
 * SHRINKS when a previous call's ear closes, so waiting on its length races
 * with that teardown and can be satisfied by a socket that is already dead.
 */
let dgOpened = 0;
/** How the adapter connected — URL and auth header — for one call each. */
const deepgramConnections: Array<{ url: string; auth: string }> = [];

/**
 * The caller says something. This is the ONLY way words enter the agent.
 *
 * Pass an array to speak one sentence in several settled segments, which is
 * what Deepgram actually sends when a caller pauses mid-sentence. Only the
 * last one carries speech_final — the flag that means they stopped talking.
 */
function callerSays(text: string | string[], opts: { speechStarted?: boolean; speechFinal?: boolean } = {}): void {
  const dg = dgSockets[dgSockets.length - 1];
  if (!dg) throw new Error('no ear is listening — the line never opened a transcriber socket');
  if (opts.speechStarted !== false) dg.send(JSON.stringify({ type: 'SpeechStarted' }));
  const segments = Array.isArray(text) ? text : [text];
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    dg.send(
      JSON.stringify({
        type: 'Results',
        is_final: true,
        speech_final: last && opts.speechFinal !== false,
        channel: { alternatives: [{ transcript: seg, confidence: 0.98 }] },
      }),
    );
  });
}

/** Deepgram's end-of-utterance backstop, when speech_final never arrives. */
function callerStoppedTalking(): void {
  const dg = dgSockets[dgSockets.length - 1];
  if (!dg) throw new Error('no ear is listening');
  dg.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 1.0 }));
}

/**
 * Wait for THIS call's ear. Pass the socket count taken before the call was
 * opened — sockets accumulate across tests, so an absolute count would pass
 * on a previous call's ear and speak into a dead socket.
 */
async function earReady(before: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (dgOpened > before) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for this call to open a transcriber socket');
}

beforeAll(async () => {
  // ---- fake OpenAI Realtime -------------------------------------------
  const oaServer = http.createServer();
  fakeOpenAI = new WebSocketServer({ server: oaServer });
  fakeOpenAI.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const evt = JSON.parse(raw.toString());
      if (evt.type === 'session.update') sessionConfig = evt.session;
      if (evt.type === 'response.create') {
        const m = /Say exactly this, word for word, and nothing else: "([\s\S]*)"$/.exec(
          evt.response?.instructions ?? '',
        );
        forcedLines.push(m ? m[1] : (evt.response?.instructions ?? ''));
        responseCreates.push(evt.response ?? {});
        // Speak it: one audio frame, then done — with a real gap, so a line
        // sent while this one is still playing would be lost exactly as it is
        // on a live call.
        ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.from('audio').toString('base64') }));
        // A real model reports what came out of its mouth, and it is not
        // always what it was handed. speaks() lets a test make it deviate.
        const asked = forcedLines[forcedLines.length - 1];
        const spoken = speaks ? speaks(asked) : asked;
        setTimeout(() => {
          try {
            if (spoken !== null) {
              ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: spoken }));
            }
            ws.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
          } catch { /* closed */ }
        }, 60);
      }
    });
    (ws as any)._isFakeOpenAI = true;
  });
  await new Promise<void>((r) => oaServer.listen(0, '127.0.0.1', () => r()));
  fakeUrl = `ws://127.0.0.1:${(oaServer.address() as AddressInfo).port}`;
  process.env.DEMO_OPENAI_URL = fakeUrl;

  // ---- fake Deepgram: the ear ------------------------------------------
  // The real adapter connects to this — same query string, same auth header,
  // same message parsing — so the caller's words travel the exact path a
  // real caller's words travel.
  const dgServer = http.createServer();
  fakeDeepgram = new WebSocketServer({ server: dgServer });
  fakeDeepgram.on('connection', (ws, req) => {
    deepgramConnections.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? '') });
    dgOpened += 1;
    dgSockets.push(ws);
    ws.on('close', () => {
      const i = dgSockets.indexOf(ws);
      if (i >= 0) dgSockets.splice(i, 1);
    });
  });
  await new Promise<void>((r) => dgServer.listen(0, '127.0.0.1', () => r()));
  process.env.DEEPGRAM_URL = `ws://127.0.0.1:${(dgServer.address() as AddressInfo).port}`;
  process.env.STT_ENGINES = 'deepgram';
  process.env.STT_PRIMARY = 'deepgram';

  // ---- the demo line itself --------------------------------------------
  const { mountDemoLine } = await import('./demoLine');
  const app = express();
  // The API server that actually mounts this uses express.urlencoded, and the
  // voice server uses a raw parser — the route must survive either, so the
  // test runs BOTH parsers ahead of it (urlencoded wins, giving an object).
  app.use(express.urlencoded({ extended: true }));
  app.use(bodyParser.raw({ type: '*/*' }));
  server = http.createServer(app);
  mountDemoLine(app, server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.DEMO_OPENAI_URL;
  for (const c of fakeOpenAI.clients) c.terminate();
  fakeOpenAI.close();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Wait until `check` passes, or fail loudly with what we did see. */
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}. Lines so far: ${JSON.stringify(forcedLines)}`);
}

describe('demo line — a call, end to end', () => {
  it('answers the number with TwiML that streams to its own socket', async () => {
    const res = await fetch(`http://${baseUrl}/demo/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B15625550134&CallSid=CAtest123&To=%2B16265482660',
    });
    const xml = await res.text();
    expect(res.headers.get('content-type')).toContain('xml');
    expect(xml).toContain('<Connect>');
    expect(xml).toContain(`wss://${baseUrl}/demo/stream`);
    expect(xml).toContain('name="from" value="+15625550134"');
  });

  it('carries a fax-records request through name, DOB and fax number — and nothing else', async () => {
    forcedLines.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    const framesToCaller: unknown[] = [];
    twilio.on('message', (raw) => framesToCaller.push(JSON.parse(raw.toString())));
    await new Promise<void>((r) => twilio.on('open', () => r()));

    twilio.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZtest',
        start: { streamSid: 'MZtest', callSid: 'CAtest123', customParameters: { from: '+15625550134', callSid: 'CAtest123' } },
      }),
    );

    // The greeting must arrive without the caller saying anything.
    await until(() => forcedLines.length >= 1, 'the greeting');
    expect(forcedLines[0]).toContain('Azul Vision');

    // Audio actually reaches the caller.
    await until(() => framesToCaller.some((f: any) => f.event === 'media'), 'audio to the caller');

    await earReady(earsBefore);
    const say = async (text: string, n: number) => {
      callerSays(text);
      await until(() => forcedLines.length >= n, `reply #${n} to "${text}"`);
    };

    await say('I need to get some medical records faxed over', 2);
    expect(forcedLines[1].toLowerCase()).toMatch(/name/);

    await say('Wayne Fabian', 3);
    expect(forcedLines[2].toLowerCase()).toMatch(/date of birth|birth/);

    await say('March 17th 1973', 4);
    expect(forcedLines[3].toLowerCase()).toMatch(/fax/);

    await say('562 555 0134', 5);
    // With the last field in hand it executes — no fourth question.
    expect(forcedLines[4].toLowerCase()).toMatch(/medical records/);

    // THREE questions total: name, date of birth, fax number. Nothing else.
    // This is the whole spec for this line, so it is asserted literally.
    const questions = forcedLines.slice(1, 4).filter((l) => l.includes('?'));
    expect(questions).toHaveLength(3);
    // A fax request never asks for a callback number.
    expect(forcedLines.join(' ').toLowerCase()).not.toMatch(/callback number|phone number/);

    twilio.close();
  });

  it('gives the model a mouth and no ears at all', () => {
    expect(sessionConfig).toBeTruthy();
    expect(sessionConfig!.audio.output.format).toEqual({ type: 'audio/pcmu' });
    // No input configuration whatsoever: nothing to transcribe with, nothing
    // to detect turns with. The session cannot hear, so it cannot invent a
    // caller — which is what it did on live patient calls.
    expect(sessionConfig!.audio.input).toBeUndefined();
    expect(sessionConfig!.tools).toEqual([]);
    expect(sessionConfig!.tool_choice).toBe('none');
  });

  it('sends the caller\'s audio to the transcriber and NOT to the model', async () => {
    forcedLines.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZaudio',
      start: { streamSid: 'MZaudio', callSid: 'CAaudio', customParameters: { from: '+15625550134', callSid: 'CAaudio' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');
    await earReady(earsBefore);

    // Watch what the model's socket receives from here on. clients is a Set
    // that drops closed sockets, so take the newest rather than an index.
    const toModel: string[] = [];
    const oa = [...fakeOpenAI.clients].pop()!;
    oa.on('message', (d) => toModel.push(JSON.parse(d.toString()).type));

    // 20 frames of caller audio, exactly as Twilio sends them.
    const frame = Buffer.alloc(160, 0x7f).toString('base64');
    for (let i = 0; i < 20; i++) {
      twilio.send(JSON.stringify({ event: 'media', streamSid: 'MZaudio', media: { payload: frame } }));
    }
    await new Promise((r) => setTimeout(r, 150));

    expect(toModel).not.toContain('input_audio_buffer.append');
    twilio.close();
  });

  it('refuses a transcript from the model even if one arrives', async () => {
    // Belt and braces. We send that session no audio, so a transcript from it
    // can only be fabricated — which is exactly what happened to patients:
    // "I sensed you were my fated master…" recorded as the caller, and the
    // agent answering it. It must never reach the agent again.
    forcedLines.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZhallucination',
        start: { streamSid: 'MZhallucination', callSid: 'CAhallucination', customParameters: { from: '+15625550134', callSid: 'CAhallucination' } },
      }),
    );
    await until(() => forcedLines.length >= 1, 'the greeting');
    await earReady(earsBefore);
    const afterGreeting = forcedLines.length;

    const oa = [...fakeOpenAI.clients].pop()!;
    oa.send(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'I sensed you were my fated master, so I traveled all this way.',
    }));
    await new Promise((r) => setTimeout(r, 150));
    expect(forcedLines.length).toBe(afterGreeting);

    // The real ear still drives the call.
    callerSays('I need medical records faxed');
    await until(() => forcedLines.length > afterGreeting, 'a real turn to be answered');

    twilio.close();
  });

  it('a silent primary engine can never mute the line', { timeout: 15_000 }, async () => {
    // 2026-08-10: STT_PRIMARY was assemblyai, assemblyai produced no turns
    // because the audio chunks were too small, and the caller talked to
    // silence for an entire call. The experiment must degrade, not the call.
    forcedLines.length = 0;
    // Restored in a finally below: when this test failed without restoring,
    // every later test silently ran with a primary that never speaks.
    const savedEngines = process.env.STT_ENGINES;
    const savedPrimary = process.env.STT_PRIMARY;
    process.env.STT_ENGINES = 'deepgram,assemblyai';
    process.env.STT_PRIMARY = 'assemblyai';
    try {
    vi.resetModules();
    const { mountDemoLine: mount } = await import('./demoLine');
    const app2 = express();
    app2.use(express.urlencoded({ extended: true }));
    const srv2 = http.createServer(app2);
    mount(app2, srv2);
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', () => r()));
    const url2 = `127.0.0.1:${(srv2.address() as AddressInfo).port}`;

    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${url2}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZmute',
      start: { streamSid: 'MZmute', callSid: 'CAmute', customParameters: { from: '+15625550134', callSid: 'CAmute' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');
    const afterGreeting = forcedLines.length;

    // Deepgram (NOT the primary) hears the caller. AssemblyAI never will —
    // it has no key here, so its socket never opens, exactly as on the live
    // call where it produced no turns at all.
    await earReady(earsBefore);
    callerSays('I need medical records faxed');

    // The agent must still answer, using what it did hear.
    await until(() => forcedLines.length > afterGreeting, 'a reply despite the silent primary', 5000);

    twilio.close();
    srv2.closeAllConnections?.();
    await new Promise<void>((r) => srv2.close(() => r()));
    } finally {
      process.env.STT_ENGINES = savedEngines;
      process.env.STT_PRIMARY = savedPrimary;
      vi.resetModules();
    }
  });

  it('serves ANY line from its own URL — the webhook is the switch', async () => {
    // Operator, 2026-08-10: put the morning's wins into production without a
    // cutover we cannot undo. Pointing a number at /line/<slug>/voice does
    // that, and pointing it back is an instant, deploy-free rollback.
    const res = await fetch(`http://${baseUrl}/line/answering-service/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B15625550134&CallSid=CAans1',
    });
    const xml = await res.text();
    expect(xml).toContain('name="slug" value="answering-service"');
    expect(xml).toContain(`wss://${baseUrl}/demo/stream`);

    // And the call actually runs as that line.
    forcedLines.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZans',
      start: {
        streamSid: 'MZans',
        callSid: 'CAans1',
        customParameters: { slug: 'answering-service', from: '+15625550134', callSid: 'CAans1' },
      },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting on the answering-service line');

    await earReady(earsBefore);
    callerSays('I need to get some medical records faxed over');
    await until(() => forcedLines.length >= 2, 'the ticket agent to answer on that line');
    expect(forcedLines[1].toLowerCase()).toMatch(/name/);

    twilio.close();
  });

  it('refuses a malformed line rather than answering as something unknown', async () => {
    const res = await fetch(`http://${baseUrl}/line/..%2Fetc/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B15625550134&CallSid=CAbad',
    });
    expect(res.status).toBe(400);
  });

  it('never loses a line to one that is still playing', { timeout: 15_000 }, async () => {
    // Live 14:22: the operator never heard "I'm not finding a match on my
    // end" or "someone will call you back" — both were sent while an earlier
    // response was still active, and the Realtime API refuses a second one.
    forcedLines.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZqueue',
      start: { streamSid: 'MZqueue', callSid: 'CAqueue', customParameters: { from: '+15625550134', callSid: 'CAqueue' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');

    await earReady(earsBefore);
    // Two turns back to back, faster than the first line can finish playing.
    for (const text of ['I need medical records faxed', 'Wayne Fabian']) {
      callerSays(text);
      await new Promise((r) => setTimeout(r, 10));
    }

    // BOTH answers must reach the caller — the second queued behind the first.
    await until(() => forcedLines.length >= 3, 'both replies to be spoken', 5000);
    expect(forcedLines[1].toLowerCase()).toMatch(/name/);
    expect(forcedLines[2].toLowerCase()).toMatch(/date of birth|birth/);

    twilio.close();
  });

  it('generates every line out of band, so there is no conversation to answer', async () => {
    // The root cause of the hiccups paragraph. The caller's audio is in the
    // session, so an in-conversation response.create asks the model to
    // produce the next turn of a REAL conversation and demotes our line to a
    // suggestion. An out-of-band response with empty input has no
    // conversation at all — the line is the only content in existence.
    forcedLines.length = 0;
    responseCreates.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZoob',
      start: { streamSid: 'MZoob', callSid: 'CAoob', customParameters: { from: '+15625550134', callSid: 'CAoob' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');

    expect(responseCreates.length).toBeGreaterThan(0);
    for (const r of responseCreates) {
      expect(r.conversation).toBe('none');
      expect(r.input).toEqual([]);
    }
    twilio.close();
  });

  it('never deletes audio Twilio has already been handed', async () => {
    // `clear` discards buffered agent audio. The model generated "I'm not
    // finding a match on my end" in full and the caller never heard a word of
    // it, because he was talking while it played and we cleared the buffer.
    forcedLines.length = 0;
    const frames: Record<string, any>[] = [];
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    twilio.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZnoclear',
      start: { streamSid: 'MZnoclear', callSid: 'CAnoclear', customParameters: { from: '+15625550134', callSid: 'CAnoclear' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');

    await earReady(earsBefore);
    // The caller talks straight over the greeting, repeatedly.
    for (let i = 0; i < 3; i++) {
      dgSockets[dgSockets.length - 1].send(JSON.stringify({ type: 'SpeechStarted' }));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(frames.some((f) => f.event === 'clear')).toBe(false);
    twilio.close();
  });

  it('knows which lines the caller actually heard, and which he did not', async () => {
    // Twilio's mark is the only signal that means "played out to the caller".
    // Everything else — our words, the model's words, the audio we handed
    // over — can be perfect while the caller hears silence.
    forcedLines.length = 0;
    const logged: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...a) => { logged.push(a.join(' ')); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { logged.push(a.join(' ')); });
    try {
      // ---- a line Twilio confirms playing --------------------------------
      const played = new WebSocket(`ws://${baseUrl}/demo/stream`);
      // Stand in for a phone that plays what it is given: echo marks back.
      played.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f.event === 'mark') played.send(JSON.stringify({ event: 'mark', mark: f.mark }));
      });
      await new Promise<void>((r) => played.on('open', () => r()));
      played.send(JSON.stringify({
        event: 'start',
        streamSid: 'MZheardit',
        start: { streamSid: 'MZheardit', callSid: 'CAheardit', customParameters: { from: '+15625550134', callSid: 'CAheardit' } },
      }));
      await until(() => logged.some((l) => l.includes('CAheardit greeting sent')), 'the greeting');
      await until(() => forcedLines.length >= 1, 'the line to be sent');
      // Give the mark its round trip before hanging up.
      await new Promise((r) => setTimeout(r, 200));
      played.close();
      await until(() => logged.some((l) => l.includes('transcript CAheardit')), 'the transcript');
      expect(logged.find((l) => l.includes('transcript CAheardit'))!).not.toContain('NOT HEARD');

      // ---- a line Twilio never plays -------------------------------------
      const silent = new WebSocket(`ws://${baseUrl}/demo/stream`); // marks ignored
      await new Promise<void>((r) => silent.on('open', () => r()));
      silent.send(JSON.stringify({
        event: 'start',
        streamSid: 'MZsilent',
        start: { streamSid: 'MZsilent', callSid: 'CAsilent', customParameters: { from: '+15625550134', callSid: 'CAsilent' } },
      }));
      await until(() => logged.some((l) => l.includes('CAsilent greeting sent')), 'the greeting');
      await new Promise((r) => setTimeout(r, 200));
      silent.close();
      await until(() => logged.some((l) => l.includes('transcript CAsilent')), 'the transcript');
      expect(logged.find((l) => l.includes('transcript CAsilent'))!).toContain('NOT HEARD');
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('stays on the line until Twilio says the goodbye finished playing', async () => {
    // Live 18:23 and 18:24: "Thanks for calling Azul Vision — take care" is
    // stamped NOT HEARD in both. <Connect><Stream> binds the call to this
    // socket, so we were hanging up on our own sign-off the moment the model
    // finished GENERATING it.
    forcedLines.length = 0;
    const logged: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...a) => { logged.push(a.join(' ')); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { logged.push(a.join(' ')); });
    try {
      const earsBefore = dgOpened;
      let closedAt = 0;
      let lastMarkAt = 0;
      const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
      twilio.on('close', () => { closedAt = Date.now(); });
      // A phone that plays audio takes time to do it. Confirm the mark late,
      // so ending on generation and ending on playback are distinguishable.
      twilio.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f.event === 'mark') {
          setTimeout(() => {
            lastMarkAt = Date.now();
            try { twilio.send(JSON.stringify({ event: 'mark', mark: f.mark })); } catch { /* closed */ }
          }, 120);
        }
      });
      await new Promise<void>((r) => twilio.on('open', () => r()));
      twilio.send(JSON.stringify({
        event: 'start',
        streamSid: 'MZbye',
        start: { streamSid: 'MZbye', callSid: 'CAbye', customParameters: { from: '+15625550134', callSid: 'CAbye' } },
      }));
      await until(() => forcedLines.length >= 1, 'the greeting');
      await earReady(earsBefore);

      // Drive the call to its end so the agent reaches its sign-off.
      for (const said of [
        'I need medical records faxed', 'Wayne Fabian', 'March 17th 1973', '562 555 0134',
      ]) {
        const before = forcedLines.length;
        callerSays(said);
        await until(() => forcedLines.length > before, `a reply to "${said}"`, 8000);
      }
      // Whatever ends the call, it must not be us closing the socket early.
      callerSays('No, that is everything');
      await until(() => closedAt > 0, 'the call to end', 10_000);

      expect(lastMarkAt).toBeGreaterThan(0);
      // The socket closed AFTER Twilio confirmed playback, not before it.
      expect(closedAt).toBeGreaterThanOrEqual(lastMarkAt);
      const block = logged.find((l) => l.includes('transcript CAbye'));
      expect(block).toBeTruthy();
      expect(block!).not.toContain('NOT HEARD');
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  }, 20_000);

  it('treats a sentence split across pauses as ONE turn, not several', async () => {
    // Live 19:11. "Yes. I'm calling to see if" arrived as a settled segment,
    // the agent asked for a name, then "you could tell me when my last
    // appointment was, please" arrived and it asked for the name AGAIN.
    // The caller: "What are you doing? You're repeating everything twice."
    forcedLines.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZsplit',
      start: { streamSid: 'MZsplit', callSid: 'CAsplit', customParameters: { from: '+15625550134', callSid: 'CAsplit' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');
    await earReady(earsBefore);

    callerSays(["Yes. I'm calling to see if", 'you could tell me when my last appointment was, please']);
    await until(() => forcedLines.length >= 2, 'one reply to the whole sentence');
    await new Promise((r) => setTimeout(r, 400));
    // ONE reply, not one per fragment.
    expect(forcedLines).toHaveLength(2);
    // And it heard the whole sentence, so it knows this is about appointments.
    expect(forcedLines[1].toLowerCase()).toMatch(/book|schedule|appointment/);

    twilio.close();
  }, 15_000);

  it('still delivers the sentence when speech_final never comes', async () => {
    // Deepgram can miss speech_final on a caller who runs straight on.
    // UtteranceEnd is the backstop; without it the words sit in the buffer
    // and the caller talks to a line that never answers.
    forcedLines.length = 0;
    const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZnofinal',
      start: { streamSid: 'MZnofinal', callSid: 'CAnofinal', customParameters: { from: '+15625550134', callSid: 'CAnofinal' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');
    await earReady(earsBefore);

    callerSays('I need medical records faxed', { speechFinal: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(forcedLines).toHaveLength(1); // nothing acted on yet — correct
    callerStoppedTalking();
    await until(() => forcedLines.length >= 2, 'the turn to land on UtteranceEnd');

    twilio.close();
  }, 15_000);

  it('records what the caller HEARD, not what we asked the model to say', async () => {
    // "There are things the agent is saying that are not in the transcripts —
    // I'm hearing something but the transcripts show something else." The
    // model is a mouthpiece that still writes; the record has to be the
    // audio, or every transcript we read afterwards is fiction.
    forcedLines.length = 0;
    speaks = (asked) => `Sure! ${asked} Is there anything else I can help with?`;
    const logged: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...a) => { logged.push(a.join(' ')); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { logged.push(a.join(' ')); });
    try {
      const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
      await new Promise<void>((r) => twilio.on('open', () => r()));
      twilio.send(JSON.stringify({
        event: 'start',
        streamSid: 'MZheard',
        start: { streamSid: 'MZheard', callSid: 'CAheard', customParameters: { from: '+15625550134', callSid: 'CAheard' } },
      }));
      await until(() => forcedLines.length >= 1, 'the greeting');
      const greeting = forcedLines[0];
      await until(() => logged.some((l) => l.includes('did not read the line as written')), 'the model to report back');
      twilio.close();
      await until(() => logged.some((l) => l.includes('transcript CAheard')), 'the end-of-call transcript');

      const block = logged.find((l) => l.includes('transcript CAheard'))!;
      // The improvised words are in the record...
      expect(block).toContain(`AGENT: Sure! ${greeting} Is there anything else I can help with?`);
      // ...and the line we actually wrote is right beside them, so the gap
      // between script and call is readable instead of invisible.
      expect(block).toContain(`^ not what we wrote: "${greeting}"`);
      expect(logged.some((l) => l.includes('did not read the line as written'))).toBe(true);
    } finally {
      speaks = null;
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('marks a line the model never confirmed speaking', async () => {
    // Silence from the model about what it played is not proof it played.
    forcedLines.length = 0;
    speaks = () => null; // audio went out; no transcript ever came back
    const logged: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...a) => { logged.push(a.join(' ')); });
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { logged.push(a.join(' ')); });
    try {
      const earsBefore = dgOpened;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
      await new Promise<void>((r) => twilio.on('open', () => r()));
      twilio.send(JSON.stringify({
        event: 'start',
        streamSid: 'MZunconf',
        start: { streamSid: 'MZunconf', callSid: 'CAunconf', customParameters: { from: '+15625550134', callSid: 'CAunconf' } },
      }));
      await until(() => forcedLines.length >= 1, 'the greeting');
      await until(() => logged.some((l) => l.includes('never transcribed')), 'the line to finish playing');
      twilio.close();
      await until(() => logged.some((l) => l.includes('transcript CAunconf')), 'the end-of-call transcript');

      const block = logged.find((l) => l.includes('transcript CAunconf'))!;
      expect(block).toContain('[unconfirmed:');
    } finally {
      speaks = null;
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
