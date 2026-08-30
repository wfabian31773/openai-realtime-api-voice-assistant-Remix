/**
 * HTTP surface for the tool library.
 *
 *   GET  /api/tools           → the manifest a platform reads to discover tools
 *   POST /api/tools/:name     → run one
 *
 * Same shape as the Eye Care scheduling service, on purpose: when the voice
 * agents move onto a managed platform, everything it can call speaks one
 * protocol regardless of which service answers.
 *
 * Auth is a bearer token. Same-origin is NOT trusted here — unlike the
 * scheduling service, this process also serves a public dashboard, so
 * "same-origin" would include a browser session.
 */
import type { Express, Request, Response } from 'express';
import { manifest, runTool, getTool, allTools } from './registry';

// Importing for side effects: each module registers its tools.
// EVERY tool module, explicitly.
//
// This file imported only opticalTools, so the HTTP surface published five
// tools and answered `no such tool: file_surgery_ticket` with a 404 — while the
// voice agent, which imports surgeryTools itself, had all seven. One registry,
// two different contents depending on which module happened to pull it in.
//
// Relying on an incidental import means every new queue silently omits itself
// from this surface until someone notices. `everyAgentToolIsReachable` in the
// test suite is the guard: it walks the agent registry and fails if any agent
// names a tool this file does not register.
import './sharedPatientTools';
import './opticalTools';
import './surgeryTools';
import './techTools';
import './medicalRecordsTools';
import './generalServiceTools';

function authorised(req: Request): boolean {
  const expected = process.env.VOICE_TOOL_API_KEY;
  // Fail CLOSED. An unset key means the surface is unavailable, not open.
  if (!expected) return false;
  const header = String(req.headers.authorization ?? '');
  const apiKey = String(req.headers['x-api-key'] ?? '');
  return header === `Bearer ${expected}` || apiKey === expected;
}

export function mountToolServer(app: Express): void {
  const configured = Boolean(process.env.VOICE_TOOL_API_KEY);
  console.info(
    `[TOOLS] ${allTools().length} registered (${manifest().length} agent-facing)` +
      `${configured ? '' : ' — VOICE_TOOL_API_KEY is NOT set, the HTTP surface will refuse every request'}`,
  );

  app.get('/api/tools', (req: Request, res: Response) => {
    if (!authorised(req)) return res.status(401).json({ error: 'Unauthorized' });
    // Primitives only on explicit request, and only for diagnostics.
    const includePrimitives = req.query.includePrimitives === 'true';
    res.set('Cache-Control', 'private, max-age=300');
    return res.json({ tools: manifest(includePrimitives), generatedAt: new Date().toISOString() });
  });

  app.post('/api/tools/:name', async (req: Request, res: Response) => {
    if (!authorised(req)) return res.status(401).json({ error: 'Unauthorized' });

    const name = String(req.params.name);
    const def = getTool(name);
    if (!def) {
      return res.status(404).json({
        success: false,
        error: `no such tool: ${name}`,
        // Agent-facing names only — telling a caller about primitives invites
        // it to call them.
        availableTools: manifest().map((t) => t.name),
      });
    }
    if (def.layer !== 'agent') {
      return res.status(403).json({ success: false, error: `${name} is not agent-callable` });
    }

    const started = Date.now();
    const body = (req.body ?? {}) as Record<string, unknown>;

    // `queue` tells the three shared patient tools what kind of place this
    // caller can be sent to — a surgery centre is the wrong answer for an
    // optician and the right one for a surgery coordinator. It is call context,
    // not a model argument, so it is in no tool's schema: agents get it
    // injected by `realtimeToolsFor`, HTTP callers pass it in the body.
    //
    // Defaulted to 'optical' HERE, and only here. These tools were Optical's
    // until Surgery needed them, so every caller that predates this line is an
    // optical caller, and quietly widening what they accept would hand one of
    // them a surgery centre as the office to file against — which is exactly
    // how VA-50803 came to be filed unassigned. The compatibility shim stays at
    // the boundary rather than inside the tool, and it logs when it fires, so
    // we can see whether anything actually relies on it before removing it.
    if (body.queue === undefined && (name === 'lookup_patient' || name === 'resolve_location')) {
      body.queue = 'optical';
      console.info(`[TOOLS] ${name} called with no queue — defaulted to 'optical'`);
    }

    const result = await runTool(name, body);
    const ms = Date.now() - started;

    // Every call, one line. The thing we lacked everywhere else today: a zero
    // in a log must mean "not called", never "not instrumented".
    const outcome =
      result.success === true
        ? 'ok'
        : 'missingFields' in result
          ? `refused:${result.missingFields.join(',')}`
          : `error:${(result as { error: string }).error}`;
    console.info(`[TOOLS] ${name} ${ms}ms ${outcome}`);

    // A refusal is a 200 with a machine-readable body, not an HTTP error: the
    // agent is meant to read it and re-ask, and platforms surface 4xx as tool
    // failure rather than handing the body back to the model.
    return res.json({ ...result, tool: name, elapsedMs: ms });
  });
}
