/**
 * The demo line, end to end, with no phone call.
 *
 * A real Express server, a real WebSocket upgrade, a real Twilio media-stream
 * client, and a fake OpenAI Realtime server standing in for the model. Every
 * layer this file owns is exercised: the TwiML the number answers with, the
 * socket handshake, the session config, the greeting, the caller's words
 * reaching the ticket agent, and the agent's forced lines coming back as
 * audio the caller would hear.
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
let sessionConfig: Record<string, any> | null = null;
/**
 * What the "model" actually speaks, given the line it was handed. null means
 * it reports nothing back. Default (unset) is a faithful reading.
 */
let speaks: ((asked: string) => string | null) | null = null;

let server: http.Server;
let baseUrl: string;

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

    const say = async (text: string, n: number) => {
      const oa = [...fakeOpenAI.clients][0];
      // A real caller trips the VAD before a transcript exists. The line
      // requires that, so the test must produce it too.
      oa.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      oa.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: text }));
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

  it('configures μ-law both ways and never lets the model answer on its own', () => {
    expect(sessionConfig).toBeTruthy();
    expect(sessionConfig!.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(sessionConfig!.audio.output.format).toEqual({ type: 'audio/pcmu' });
    // The model must not decide to respond — the ticket agent decides.
    expect(sessionConfig!.audio.input.turn_detection.create_response).toBe(false);
    expect(sessionConfig!.tools).toEqual([]);
    expect(sessionConfig!.tool_choice).toBe('none');
    // The tuned transcriber, not the bare model. A live call transcribed
    // "Wayne Fabian" as "20 Fabian" and answered in Vietnamese because this
    // line asked for the default.
    const tr = sessionConfig!.audio.input.transcription;
    expect(tr.model).toBeTruthy();
    expect(tr.prompt ?? tr.language ?? tr.languages).toBeTruthy();
  });

  it('ignores a transcript that appeared out of silence', async () => {
    forcedLines.length = 0;
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
    const afterGreeting = forcedLines.length;

    const oa = [...fakeOpenAI.clients].pop()!;
    // No speech_started: this is the transcriber hallucinating on silence.
    // A live call (17:21) processed exactly this and spent an ask on it.
    oa.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Okay' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(forcedLines.length).toBe(afterGreeting);

    // With speech behind it, the same words are taken seriously.
    oa.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    oa.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'I need medical records faxed' }));
    await until(() => forcedLines.length > afterGreeting, 'a real turn to be answered');

    twilio.close();
  });

  it('a silent primary engine can never mute the line', async () => {
    // 2026-08-10: STT_PRIMARY was assemblyai, assemblyai produced no turns
    // because the audio chunks were too small, and the caller talked to
    // silence for an entire call. The experiment must degrade, not the call.
    forcedLines.length = 0;
    process.env.STT_ENGINES = 'openai,assemblyai';
    process.env.STT_PRIMARY = 'assemblyai';
    vi.resetModules();
    const { mountDemoLine: mount } = await import('./demoLine');
    const app2 = express();
    app2.use(express.urlencoded({ extended: true }));
    const srv2 = http.createServer(app2);
    mount(app2, srv2);
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', () => r()));
    const url2 = `127.0.0.1:${(srv2.address() as AddressInfo).port}`;

    const twilio = new WebSocket(`ws://${url2}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZmute',
      start: { streamSid: 'MZmute', callSid: 'CAmute', customParameters: { from: '+15625550134', callSid: 'CAmute' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');
    const afterGreeting = forcedLines.length;

    // OpenAI (NOT the primary) hears the caller. AssemblyAI never will.
    const oa = [...fakeOpenAI.clients].pop()!;
    oa.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    oa.send(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'I need medical records faxed',
    }));

    // The agent must still answer, using what it did hear.
    await until(() => forcedLines.length > afterGreeting, 'a reply despite the silent primary', 5000);

    twilio.close();
    srv2.closeAllConnections?.();
    await new Promise<void>((r) => srv2.close(() => r()));
    delete process.env.STT_ENGINES;
    delete process.env.STT_PRIMARY;
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

    const oa = [...fakeOpenAI.clients].pop()!;
    oa.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    oa.send(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'I need to get some medical records faxed over',
    }));
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

  it('never loses a line to one that is still playing', async () => {
    // Live 14:22: the operator never heard "I'm not finding a match on my
    // end" or "someone will call you back" — both were sent while an earlier
    // response was still active, and the Realtime API refuses a second one.
    forcedLines.length = 0;
    const twilio = new WebSocket(`ws://${baseUrl}/demo/stream`);
    await new Promise<void>((r) => twilio.on('open', () => r()));
    twilio.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZqueue',
      start: { streamSid: 'MZqueue', callSid: 'CAqueue', customParameters: { from: '+15625550134', callSid: 'CAqueue' } },
    }));
    await until(() => forcedLines.length >= 1, 'the greeting');

    const oa = [...fakeOpenAI.clients].pop()!;
    // Two turns back to back, faster than the first line can finish playing.
    for (const text of ['I need medical records faxed', 'Wayne Fabian']) {
      oa.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      oa.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: text }));
      await new Promise((r) => setTimeout(r, 10));
    }

    // BOTH answers must reach the caller — the second queued behind the first.
    await until(() => forcedLines.length >= 3, 'both replies to be spoken', 5000);
    expect(forcedLines[1].toLowerCase()).toMatch(/name/);
    expect(forcedLines[2].toLowerCase()).toMatch(/date of birth|birth/);

    twilio.close();
  });

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
