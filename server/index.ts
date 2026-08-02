// Operations Hub API Server
// Serves REST API, authentication, and dashboard frontend
// Runs on port 5000 (production runs both this and voice agent)

import express from "express";
import cors from "cors";
import http from "http";
// NOTE: heavy modules (routes, storage, DB, keep-alive) are dynamically imported
// inside startServer() AFTER the HTTP server is listening — importing them at the
// top level delayed port binding by ~20s under tsx, causing deployment
// healthcheck failures at startup.
import { validateEnv, API_SERVER_REQUIRED } from "../src/lib/env";
import { getEnvironmentConfig } from "../src/config/environment";

const envConfig = getEnvironmentConfig();

// CRITICAL: Global error handlers to prevent server crashes
// These catch unhandled errors that would otherwise kill the Node process
process.on('uncaughtException', (error: Error) => {
  console.error('[CRITICAL] API Server - Uncaught Exception (staying alive):', error);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('[CRITICAL] API Server - Unhandled Promise Rejection (staying alive):', reason);
});

validateEnv(API_SERVER_REQUIRED);

const app = express();
const PORT = Number(process.env.API_PORT) || 5000;

// CRITICAL: Voice proxy MUST come before body parsers to preserve raw bodies for OpenAI/Twilio signature verification
// Production streaming proxy that forwards ALL headers and streams request/response bodies
// Hop-by-hop headers that should NOT be forwarded (per HTTP spec)
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

app.use('/api/voice', (req, res) => {
  const startTime = Date.now();
  
  // Forward ALL headers except hop-by-hop ones to preserve signature verification metadata
  // IMPORTANT: Don't forward 'host' header - let http.request() set it based on target URL
  const headersToForward: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && lowerKey !== 'host') {
      headersToForward[key] = value;
    }
  }
  
  // CRITICAL: Ensure X-Forwarded headers are set for Twilio signature validation
  // These tell the voice server what the original public URL was
  const originalHost = req.headers['x-forwarded-host'] || req.headers.host;
  const originalProto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  headersToForward['x-forwarded-host'] = originalHost;
  headersToForward['x-forwarded-proto'] = originalProto;
  
  // Proxy request to voice server using native HTTP (streaming, no buffering)
  const proxyReq = http.request({
    hostname: 'localhost',
    port: 8000,
    path: req.originalUrl,
    method: req.method,
    headers: headersToForward,
    timeout: 30000, // 30s timeout
  }, (proxyRes) => {
    const duration = Date.now() - startTime;
    console.log(`[PROXY] ${req.method} ${req.originalUrl} → ${proxyRes.statusCode} (${duration}ms)`);
    
    // Forward response status and headers
    res.statusCode = proxyRes.statusCode || 200;
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value as string | string[]);
      }
    }
    
    // Stream response body back to client
    proxyRes.pipe(res);
  });
  
  // CRITICAL: Return valid TwiML with HTTP 200 on errors
  // Twilio treats ANY 5xx as failure regardless of content - must be 200 with valid TwiML
  const twimlFallback = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We're sorry, our system is temporarily unavailable. Please try your call again in a few moments.</Say>
  <Hangup/>
</Response>`;
  
  // Error handling - return HTTP 200 with TwiML fallback (NOT 503/504)
  proxyReq.on('error', (error: any) => {
    const duration = Date.now() - startTime;
    console.error(`[PROXY] Error after ${duration}ms:`, error.message);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(twimlFallback);
    }
  });
  
  proxyReq.on('timeout', () => {
    const duration = Date.now() - startTime;
    console.error(`[PROXY] Timeout after ${duration}ms`);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(twimlFallback);
    }
  });
  
  // Read and forward request body
  // Note: Express wraps the request stream in a way that makes piping unreliable
  // So we manually collect chunks and write them to the proxy request
  const bodyChunks: Buffer[] = [];
  
  req.on('data', (chunk) => {
    bodyChunks.push(chunk);
  });
  
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks);
    
    // Log call details for voice endpoints
    if (body.length > 0) {
      try {
        const bodyStr = body.toString('utf8');
        const path = req.originalUrl;
        
        // Parse Twilio webhook bodies (URL-encoded)
        if (path.includes('/incoming-call') || path.includes('/ivr-selection') || path.includes('/no-ivr')) {
          const params = new URLSearchParams(bodyStr);
          const callSid = params.get('CallSid');
          const from = params.get('From');
          const to = params.get('To');
          const digits = params.get('Digits');
          
          if (callSid) {
            console.log(`\n[CALL] ═══════════════════════════════════════════════════`);
            console.log(`[CALL] Incoming: ${callSid?.slice(-8)}`);
            console.log(`[CALL] From: ${from} → To: ${to}`);
            if (digits) console.log(`[CALL] IVR Selection: ${digits}`);
            console.log(`[CALL] Endpoint: ${path}`);
            console.log(`[CALL] ═══════════════════════════════════════════════════\n`);
          }
        }
        
        // Log conference events
        if (path.includes('/conference-events')) {
          const params = new URLSearchParams(bodyStr);
          const event = params.get('StatusCallbackEvent');
          const confName = params.get('FriendlyName');
          const label = params.get('ParticipantLabel');
          
          if (event && confName) {
            const callId = confName?.replace('conf_', '').slice(-8);
            console.log(`[CONF] ${event}: ${label || 'unknown'} (call: ${callId})`);
          }
        }
        
        // Log realtime webhook (OpenAI)
        if (path.includes('/realtime')) {
          try {
            const json = JSON.parse(bodyStr);
            const type = json.type;
            const callId = json.data?.call_id?.slice(-8);
            
            if (type === 'realtime.call.connected') {
              console.log(`[CALL] ✓ OpenAI connected (call: ${callId})`);
            } else if (type === 'realtime.call.disconnected') {
              console.log(`[CALL] ✗ OpenAI disconnected (call: ${callId})`);
            }
          } catch {}
        }
      } catch (parseError) {
        // Ignore parse errors - just forward the request
      }
      
      proxyReq.write(body);
    }
    proxyReq.end();
  });
  
  req.on('error', (err) => {
    console.error(`[PROXY] Request stream error:`, err);
    proxyReq.destroy();
  });
});

// Middleware (AFTER proxy to avoid consuming raw bodies)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static("client/dist"));

async function cleanupStaleCallsOnStartup() {
  try {
    const { storage } = await import('./storage');
    const { getTwilioClient } = await import('../src/lib/twilioClient');
    
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const staleCalls = await storage.getCallLogs({
      status: 'in_progress,ringing,initiated',
      endDate: fiveMinutesAgo,
      limit: 100,
    });
    
    if (staleCalls.data.length === 0) {
      console.log("[STARTUP] No stale calls to cleanup");
      return;
    }
    
    console.log(`[STARTUP] Found ${staleCalls.data.length} stale calls, cleaning up...`);
    
    let cleanedCount = 0;
    const twilioClient = await getTwilioClient();
    
    for (const call of staleCalls.data) {
      const callTime = call.startTime || call.createdAt;
      if (callTime && new Date(callTime) < fiveMinutesAgo) {
        let finalStatus: 'completed' | 'busy' | 'no_answer' | 'failed' = 'completed';
        let actualDuration: number | null = null;
        
        if (call.callSid) {
          try {
            const twilioCall = await twilioClient.calls(call.callSid).fetch();
            const twilioStatus = twilioCall.status;
            actualDuration = twilioCall.duration ? parseInt(twilioCall.duration) : null;
            
            if (twilioStatus === 'in-progress' || twilioStatus === 'ringing' || twilioStatus === 'queued') {
              continue;
            } else if (twilioStatus === 'busy') {
              finalStatus = 'busy';
            } else if (twilioStatus === 'no-answer') {
              finalStatus = 'no_answer';
            } else if (twilioStatus === 'failed' || twilioStatus === 'canceled') {
              finalStatus = 'failed';
            }
          } catch (e) {
            // Call not found in Twilio
          }
        }
        
        const duration = actualDuration ?? Math.max(0, Math.floor((fiveMinutesAgo.getTime() - new Date(callTime).getTime()) / 1000));
        
        await storage.updateCallLog(call.id, {
          status: finalStatus,
          endTime: call.endTime || fiveMinutesAgo,
          duration: duration,
        });
        cleanedCount++;
      }
    }
    
    console.log(`[STARTUP] Cleaned up ${cleanedCount} stale calls`);
  } catch (error) {
    console.error("[STARTUP] Error cleaning up stale calls:", error);
  }
}

async function backfillMissingReconciliations(): Promise<void> {
  const { backfillMissingReconciliations: doBackfill } = await import('../src/services/reconciliationBackfill');
  return doBackfill();
}

function parseNightlyHour(raw: string | undefined): number {
  const DEFAULT_HOUR = 6;
  if (raw === undefined || raw === '') return DEFAULT_HOUR;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0 || parsed > 23) {
    console.warn(`[NIGHTLY] Invalid NIGHTLY_RECONCILE_HOUR_UTC value "${raw}" — falling back to ${DEFAULT_HOUR}:00 UTC`);
    return DEFAULT_HOUR;
  }
  return parsed;
}

const NIGHTLY_RECONCILE_HOUR_UTC_DEFAULT = parseNightlyHour(process.env.NIGHTLY_RECONCILE_HOUR_UTC);

async function getNightlyHourUtc(): Promise<number> {
  try {
    const { db } = await import('./db');
    const { appSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'nightly_reconcile_hour_utc'));
    if (rows.length > 0) {
      const parsed = parseInt(rows[0].value, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) return parsed;
    }
  } catch {
    // fall through to default
  }
  return NIGHTLY_RECONCILE_HOUR_UTC_DEFAULT;
}

async function recordReconciliationRun(opts: {
  dateReconciled: string;
  triggeredBy: string;
  success: boolean;
  errorMessage?: string;
  durationMs: number;
}): Promise<void> {
  try {
    const { db } = await import('./db');
    const { reconciliationRuns } = await import('../shared/schema');
    await db.insert(reconciliationRuns).values({
      dateReconciled: opts.dateReconciled,
      triggeredBy: opts.triggeredBy,
      success: opts.success,
      errorMessage: opts.errorMessage ?? null,
      durationMs: opts.durationMs,
      runAt: new Date(),
    });
  } catch (err) {
    console.error('[NIGHTLY] Failed to record reconciliation run:', err);
  }
}

const RECONCILIATION_RUNS_RETENTION_DAYS_DEFAULT = 90;

function getReconciliationRunsRetentionDays(): number {
  const raw = process.env.RECONCILIATION_RUNS_RETENTION_DAYS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return RECONCILIATION_RUNS_RETENTION_DAYS_DEFAULT;
}

async function pruneOldReconciliationRuns(): Promise<void> {
  try {
    const retentionDays = getReconciliationRunsRetentionDays();
    const { db } = await import('./db');
    const { reconciliationRuns } = await import('../shared/schema');
    const { lt } = await import('drizzle-orm');
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    const result: any = await db
      .delete(reconciliationRuns)
      .where(lt(reconciliationRuns.runAt, cutoff));
    const deletedCount = result?.rowCount ?? 'unknown';
    console.log(`[NIGHTLY] Pruned ${deletedCount} reconciliation run record(s) older than ${retentionDays} days (cutoff: ${cutoff.toISOString()})`);
  } catch (err) {
    console.error('[NIGHTLY] Failed to prune old reconciliation run records:', err);
  }
}

async function runNightlyReconciliation(): Promise<void> {
  const startMs = Date.now();
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  try {
    const { orgBillingLedger } = await import('../src/services/orgBillingLedger');
    const { db } = await import('./db');
    const { dailyReconciliation } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    // Deduplication: skip if already reconciled today
    const existing = await db
      .select({ dateUtc: dailyReconciliation.dateUtc })
      .from(dailyReconciliation)
      .where(eq(dailyReconciliation.dateUtc, dateStr));

    if (existing.length > 0) {
      console.log(`[NIGHTLY] Reconciliation for ${dateStr} already exists — skipping`);
      await recordReconciliationRun({
        dateReconciled: dateStr,
        triggeredBy: 'auto',
        success: true,
        errorMessage: 'Skipped: already reconciled',
        durationMs: Date.now() - startMs,
      });
      await pruneOldReconciliationRuns();
      return;
    }

    console.log(`[NIGHTLY] Running reconciliation for ${dateStr}...`);
    const result = await orgBillingLedger.reconcileDay(dateStr);
    const durationMs = Date.now() - startMs;
    if (result.success) {
      console.log(`[NIGHTLY] Reconciliation complete for ${dateStr}: actual=$${result.actualUsd?.toFixed(2)}`);
      await recordReconciliationRun({ dateReconciled: dateStr, triggeredBy: 'auto', success: true, durationMs });
      await pruneOldReconciliationRuns();
    } else {
      console.warn(`[NIGHTLY] Reconciliation failed for ${dateStr}: ${result.error}`);
      await recordReconciliationRun({ dateReconciled: dateStr, triggeredBy: 'auto', success: false, errorMessage: result.error, durationMs });
    }
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[NIGHTLY] Error during nightly reconciliation:', error);
    await recordReconciliationRun({ dateReconciled: dateStr, triggeredBy: 'auto', success: false, errorMessage: errorMsg, durationMs });
  }
}

function scheduleNightlyReconciliation(): void {
  const scheduleNext = async () => {
    const hourUtc = await getNightlyHourUtc();
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ));
    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    const msUntilNext = next.getTime() - now.getTime();
    console.log(`[NIGHTLY] Reconciliation scheduled for ${next.toISOString()} — runs daily at ${String(hourUtc).padStart(2, '0')}:00 UTC (in ${Math.round(msUntilNext / 60000)} min)`);
    setTimeout(async () => {
      await runNightlyReconciliation();
      scheduleNext();
    }, msUntilNext);
  };
  scheduleNext();
}

// Healthcheck must respond immediately — registered before any async work
// so Replit's startup probe sees 200 while initialization is still in progress.
app.get('/healthz', (_req, res) => res.status(200).send('OK'));

let isReady = false;

async function startServer() {
  // Start listening immediately so Replit's healthcheck succeeds right away.
  // All async initialization (DB warmup, route registration) runs after the
  // server is already accepting connections.
  const earlyServer = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    earlyServer.listen(PORT, '0.0.0.0', () => resolve());
    earlyServer.once('error', reject);
  });
  console.log("========================================");
  console.log("🚀 Azul Vision Operations Hub - API Server");
  console.log("========================================");
  console.log(`Server listening on port ${PORT}`);
  console.log(`API: http://0.0.0.0:${PORT}/api`);
  console.log(`Dashboard: http://0.0.0.0:${PORT}`);
  console.log("========================================");
  console.log("Note: Voice agent runs separately on port 8000");
  console.log("========================================");

  try {
    // Load heavy modules only after the port is bound (see note at top of file)
    const [{ startKeepAlive, warmupDatabase }, { registerRoutes }, { dbReady }] = await Promise.all([
      import("./services/databaseKeepAlive"),
      import("./routes"),
      import("./db"),
    ]);

    // Wait for pooler validation/failover before any DB work so no query
    // ever runs against an invalid pooler pool
    await dbReady;

    // Warm up database connection
    console.log("[STARTUP] Warming up database connection...");
    await warmupDatabase();

    // Start database keep-alive service to prevent cold starts
    startKeepAlive();

    // Register API routes and auth (mutates `app` in-place; we ignore the
    // returned server since we're already listening on earlyServer)
    await registerRoutes(app);

    // Catch-all: serve index.html for client-side routing (must be after API routes)
    app.use((req, res) => {
      res.sendFile('index.html', { root: 'client/dist' });
    });

    isReady = true;
    console.log("[STARTUP] Server fully initialized");

    // Cleanup stale calls from previous sessions
    await cleanupStaleCallsOnStartup();

    // Backfill any missing reconciliation days (non-blocking)
    backfillMissingReconciliations().catch(err => {
      console.error('[STARTUP] Backfill reconciliation error:', err);
    });

    // Schedule nightly reconciliation at configured UTC hour
    scheduleNightlyReconciliation();
  } catch (error) {
    console.error("Failed to initialize API server:", error);
    // Keep the server alive (healthcheck still responds) even if init fails
    // so Replit doesn't keep restarting us in a crash loop.
  }
}

startServer();
