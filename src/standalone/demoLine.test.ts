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
        // Speak it: one audio frame, then done.
        ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.from('audio').toString('base64') }));
        ws.send(JSON.stringify({ type: 'response.done' }));
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
  app.use(bodyParser.raw({ type: '*/*' })); // same parser as the real server
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
  });
});
