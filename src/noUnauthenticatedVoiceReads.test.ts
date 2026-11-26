/**
 * NO UNAUTHENTICATED READS ON THE VOICE ROUTES (2026-11-26).
 *
 * The public server (server/index.ts) proxies every /api/voice/* request to the
 * old core (src/server.ts, port 8000), and the old core has no login session.
 * So any GET registered in src/voiceAgentRoutes.ts answers anyone on the
 * published host. Until this change four did:
 *
 *   /api/voice/diagnostics                 call counts, failure rate, latency
 *   /api/voice/diagnostics/active          live traces with full OpenAI call ids
 *   /api/voice/diagnostics/recent-failures failure text, call id tails
 *   /api/voice/azul/tool-timeline/:id      a call's tool timeline
 *
 * The three diagnostics routes answered 200 to a request with no session on
 * the published host on 2026-11-26 (`/api/call-logs` answered 401 beside them).
 * Nothing read the diagnostics routes after the Operations Monitor was rebuilt
 * on call_logs; the SD Pilot page, the tool timeline's one reader, now reads the
 * copy on the call row through `/api/call-logs`, which requires a login.
 *
 * Three checks:
 *   1. The real old-core routes, mounted on Express and asked over a socket
 *      with no cookie, answer 404 on all four paths and return nothing. The
 *      control: /api/voice/hold-music, which Twilio fetches, still answers.
 *   2. Every GET the voice routes register is on the list below, with the
 *      reason it may answer without a login. A new GET fails here until
 *      somebody writes that reason down (or puts the route behind a login in
 *      server/routes.ts, where the session lives).
 *   3. The SD Pilot page reads the call row, and no client code asks for a
 *      removed path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// The route file builds service singletons at import; give them dummy values.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';
process.env.OPENAI_API_KEY ??= 'sk-test-not-a-key';
process.env.TWILIO_ACCOUNT_SID ??= 'AC00000000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN ??= 'test-not-a-token';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const REMOVED_PATHS = [
  '/api/voice/diagnostics',
  '/api/voice/diagnostics/active',
  '/api/voice/diagnostics/recent-failures',
  '/api/voice/azul/tool-timeline/CA00000000000000000000000000000000',
];

/**
 * Every GET the voice routes may register, and why it may answer with no login.
 * Keyed by the path as written in the source.
 */
const ALLOWED_OPEN_GETS: Record<string, string> = {
  '/api/voice/hold-music':
    'Twilio fetches it as a warm transfer\'s holdUrl; static TwiML, no call data.',
  '/api/health/sip':
    'Counts and a status word; /api/health is not proxied by the public server.',
  '/api/ticketing-sync/status':
    'Three counts; not under /api/voice, so the public server does not proxy it.',
  '/voice/health':
    'Deploy marker, build and lane readiness; carries no call, caller or patient data.',
  '${BOOKING_PATH_PREFIX}/:token':
    'The texted booking page; the 256-bit token is the credential and nothing from the record shows before the date of birth matches (v211).',
};

/** The route files that serve /api/voice/* and /voice/*. */
function voiceRouteFiles(): string[] {
  const files = ['src/voiceAgentRoutes.ts'];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith('.ts') && !rel.endsWith('.test.ts')) files.push(rel);
    }
  };
  walk('src/voiceAgent');
  walk('src/runtime');
  return files;
}

/** Every `app.get(...)` / `app.all(...)` path a file registers, as written. */
function openGetPaths(source: string): string[] {
  const out: string[] = [];
  const re = /\bapp\.(?:get|all)\(\s*(['"`])((?:(?!\1).)*)\1/g;
  for (const m of source.matchAll(re)) out.push(m[2]);
  return out;
}

describe('the removed voice read routes answer nobody', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const { setupVoiceAgentRoutes } = await import('./voiceAgentRoutes');
    const app = express();
    setupVoiceAgentRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('the control: a Twilio-fetched GET on the same app still answers', async () => {
    const res = await fetch(`${base}/api/voice/hold-music`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Response>');
  });

  for (const p of REMOVED_PATHS) {
    it(`${p} answers 404 with no data to a request with no session`, async () => {
      const res = await fetch(`${base}${p}`);
      const body = await res.text();
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('application/json');
      // Express's own "no route" page, which echoes only the path asked for.
      expect(body).toContain(`Cannot GET ${p}`);
      for (const key of ['activeCalls', 'traces', 'failures', 'totalCalls', 'events', 'traceId']) {
        expect(body).not.toContain(`"${key}"`);
      }
    });
  }
});

describe('every open voice GET is one we meant to leave open', () => {
  it('the scan finds the routes it is meant to see (not vacuous)', () => {
    const all = voiceRouteFiles().flatMap((f) => openGetPaths(read(f)));
    expect(all).toContain('/api/voice/hold-music');
    expect(all).toContain('/voice/health');
  });

  it('no file registers a GET that is not on the list', () => {
    const unexpected = voiceRouteFiles().flatMap((f) =>
      openGetPaths(read(f))
        .filter((p) => !(p in ALLOWED_OPEN_GETS))
        .map((p) => `${f}: ${p}`),
    );
    expect(unexpected).toEqual([]);
  });

  it('none of the removed paths is registered anywhere in the voice routes', () => {
    const all = voiceRouteFiles().flatMap((f) => openGetPaths(read(f)));
    for (const p of all) {
      expect(p.startsWith('/api/voice/diagnostics')).toBe(false);
      expect(p.startsWith('/api/voice/azul/tool-timeline')).toBe(false);
    }
  });
});

describe('the SD Pilot page reads the timeline behind the login', () => {
  const page = read('client/src/pages/SdPilotPage.tsx');

  it('the live card reads the call row, not the removed route', () => {
    expect(page).not.toContain('tool-timeline');
    expect(page).toMatch(/const toolEvents = call\.toolTimeline\?\.events \?\? \[\]/);
    expect(page).toContain('<ToolTimeline events={toolEvents} />');
  });

  it('the call row it reads comes from /api/call-logs, which requires a login', () => {
    expect(page).toContain('/call-logs?agentUsed=');
    expect(read('server/routes.ts')).toMatch(/app\.get\('\/api\/call-logs', isAuthenticated,/);
  });

  it('no client code asks for a removed path', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(path.join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(rel) && /voice\/(diagnostics|azul\/tool-timeline)/.test(read(rel))) {
          offenders.push(rel);
        }
      }
    };
    walk('client/src');
    expect(offenders).toEqual([]);
  });
});
