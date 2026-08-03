// Liveness/readiness endpoints and the initialization failure gate.
// Extracted from server/index.ts so the probe behavior is unit-testable.
import type { Express, Request, Response, NextFunction } from "express";

export interface HealthState {
  /** true once routes/auth/DB initialization completed successfully */
  isReady: boolean;
  /** true if initialization threw — the server must refuse traffic */
  initFailed: boolean;
}

export function createHealthState(): HealthState {
  return { isReady: false, initFailed: false };
}

// Twilio treats ANY 5xx as failure regardless of content — voice webhooks must
// get HTTP 200 with valid TwiML even when we're refusing all other traffic.
export const INIT_FAILED_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We're sorry, our system is temporarily unavailable. Please try your call again in a few moments.</Say>
  <Hangup/>
</Response>`;

/**
 * Registers, in order:
 *  - GET /healthz — liveness AND deployment probe. Responds 200 instantly during
 *    startup (so the platform's startup probe passes while init is in progress),
 *    but flips to 503 permanently if initialization fails, so a broken
 *    deployment is marked unhealthy instead of silently passing health checks.
 *  - GET /readyz — readiness. 200 only after init succeeded; 503 while
 *    initializing or after failure. Bodies are generic — no error internals
 *    are exposed on this unauthenticated endpoint (details go to server logs).
 *  - Failure gate middleware — when init failed, refuses ALL other traffic
 *    before any downstream middleware (including the voice proxy): voice
 *    webhook paths get the TwiML apology with HTTP 200, everything else 503.
 *
 * Must be called BEFORE any other middleware is registered on `app`.
 */
export function registerHealthEndpoints(app: Express, state: HealthState): void {
  app.get("/healthz", (_req: Request, res: Response) => {
    if (state.initFailed) {
      return res.status(503).send("INIT FAILED");
    }
    res.status(200).send("OK");
  });

  app.get("/readyz", (_req: Request, res: Response) => {
    if (state.isReady) {
      res.status(200).json({ status: "ready" });
    } else if (state.initFailed) {
      res.status(503).json({ status: "failed" });
    } else {
      res.status(503).json({ status: "initializing" });
    }
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!state.initFailed) return next();
    if (req.path.startsWith("/api/voice")) {
      res.setHeader("Content-Type", "application/xml");
      return res.status(200).send(INIT_FAILED_TWIML);
    }
    res.status(503).json({ error: "Server initialization failed" });
  });
}
