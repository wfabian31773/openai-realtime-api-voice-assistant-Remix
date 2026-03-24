import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import { agentRegistry } from './config/agents';
import { medicalSafetyGuardrails } from './agents/afterHoursAgent';
import { validateEnv, VOICE_AGENT_REQUIRED } from './lib/env';
import { setupVoiceAgentRoutes } from './voiceAgentRoutes';
import { ticketingSyncService } from '../server/services/ticketingSyncService';
import { dailyOpenaiReconciliation } from './services/dailyOpenaiReconciliation';
import './services/qvoEmitterService'; // eager load so config check prints at startup
import { startKeepAlive, stopKeepAlive, warmupDatabase } from '../server/services/databaseKeepAlive';
import { initializeCallSessionService } from './services/callSessionService';
import { getEnvironmentConfig, validateProductionConfig } from './config/environment';

// CRITICAL: Global error handlers to prevent server crashes
// These catch unhandled errors that would otherwise kill the Node process
process.on('uncaughtException', (error: Error) => {
  console.error('[CRITICAL] Uncaught Exception - server staying alive:', error);
  // Log but don't exit - keep the server running
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('[CRITICAL] Unhandled Promise Rejection - server staying alive:', reason);
  // Log but don't exit - keep the server running
});

validateEnv(VOICE_AGENT_REQUIRED);

// Load and validate environment configuration
const envConfig = getEnvironmentConfig();
validateProductionConfig();

// Environment variables (from centralized config)
const PORT = Number(process.env.VOICE_AGENT_PORT ?? 8000);

// Initialize Express
const app = express();
app.use(bodyParser.raw({ type: "*/*" }));

// Setup voice agent routes (Twilio webhooks, OpenAI webhooks, etc.)
setupVoiceAgentRoutes(app);

// Tracking active calls for graceful shutdown
const activeCallTasks = new Map<string, Promise<void>>();

// NOTE: All call handling is in voiceAgentRoutes.ts at /api/voice/* routes.
// OpenAI webhook handling is in voiceAgentRoutes.ts at /api/voice/realtime.

// Health check endpoints
app.get("/health", async (req: Request, res: Response) => {
  return res.status(200).send({ status: 'ok', agents: agentRegistry.getAllAgents().length });
});

// Standard health check for production monitoring
app.get("/healthz", async (req: Request, res: Response) => {
  try {
    // Import health metrics service (safe path from src -> server)
    const { getSystemHealthMetrics, checkDatabaseConnectivity } = await import('../server/services/healthMetrics');
    const { systemAlertService } = await import('../server/services/systemAlertService');
    
    // Check database connectivity
    const dbConnected = await checkDatabaseConnectivity();
    if (!dbConnected) {
      return res.status(503).json({
        status: 'unhealthy',
        server: 'voice-agent',
        error: 'database connection failed',
        timestamp: new Date().toISOString()
      });
    }
    
    // Get full system health metrics
    const health = getSystemHealthMetrics();
    const alertStatus = systemAlertService.getHealthStatus();
    
    return res.status(health.status === 'unhealthy' ? 503 : 200).json({ 
      ...health,
      server: 'voice-agent',
      port: PORT,
      agents: agentRegistry.getAllAgents().length,
      alerts: {
        systemHealthy: alertStatus.healthy,
        consecutiveFailures: alertStatus.consecutiveFailures,
        recentAlertCount: alertStatus.recentAlerts.length,
      },
    });
  } catch (error) {
    console.error('[HEALTHZ] Health check failed:', error);
    return res.status(503).json({ 
      status: 'unhealthy', 
      server: 'voice-agent',
      error: 'health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Shutdown handler
const shutdown = async () => {
  try {
    console.log('\n[SERVER] Shutting down gracefully...');
    // Stop background services
    ticketingSyncService.stop();
    stopKeepAlive();
    // Wait for active calls to complete (with timeout)
    await Promise.race([
      Promise.all(Array.from(activeCallTasks.values())),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  } catch (error) {
    console.error('[SERVER] Error during shutdown:', error);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server with database warmup
async function startVoiceServer() {
  // Warm up database connection before starting server
  console.log("[STARTUP] Warming up database connection...");
  await warmupDatabase();
  
  // Start database keep-alive service
  startKeepAlive();
  
  // Initialize system alert service for downtime notifications
  const { systemAlertService } = await import('../server/services/systemAlertService');
  await systemAlertService.initialize();
  
  // Initialize call session service (load active sessions from DB)
  await initializeCallSessionService();
  
  // Build version for tracking deployments - update when making system changes
  const BUILD_VERSION = '2026.02.16a'; // Format: YYYY.MM.DDx where x is revision letter - GO-LIVE CHECKLIST: burn-rate, RBAC, secret validation, traffic ramp
  
  // ========== Startup Secret Validation ==========
  const secretChecks = [
    { name: 'TWILIO_ACCOUNT_SID', present: !!process.env.TWILIO_ACCOUNT_SID },
    { name: 'TWILIO_AUTH_TOKEN', present: !!process.env.TWILIO_AUTH_TOKEN },
    { name: 'TWILIO_PHONE_NUMBER', present: !!process.env.TWILIO_PHONE_NUMBER },
    { name: 'OPENAI_API_KEY', present: !!process.env.OPENAI_API_KEY },
    { name: 'DATABASE_URL', present: !!process.env.DATABASE_URL },
  ];
  const missingSecrets = secretChecks.filter(s => !s.present);
  const isProd = process.env.APP_ENV === 'production';
  
  console.log('\n[SECRET VALIDATION]');
  secretChecks.forEach(s => {
    console.log(`  ${s.present ? 'PASS' : 'FAIL'}: ${s.name} ${s.present ? 'loaded' : 'MISSING'}`);
  });
  
  if (missingSecrets.length > 0 && isProd) {
    console.error(`[SECRET VALIDATION] CRITICAL: ${missingSecrets.length} required secret(s) missing in production: ${missingSecrets.map(s => s.name).join(', ')}`);
  } else if (missingSecrets.length > 0) {
    console.warn(`[SECRET VALIDATION] WARNING: ${missingSecrets.length} secret(s) missing in development (expected for some): ${missingSecrets.map(s => s.name).join(', ')}`);
  } else {
    console.log('[SECRET VALIDATION] All required secrets loaded successfully');
  }
  
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n========================================`);
    console.log(`🚀 Azul Vision AI Operations Hub`);
    console.log(`   Build: ${BUILD_VERSION}`);
    console.log(`========================================`);
    console.log(`Server listening on port ${PORT}`);
    console.log(`Agents registered: ${agentRegistry.getAllAgents().length}`);
    
    // Log all agent versions for tracking which versions are active
    console.log(`\n[AGENT VERSIONS]`);
    agentRegistry.getAllAgents().forEach(agent => {
      const version = agent.version || 'unversioned';
      console.log(`  - ${agent.id}: ${version}`);
    });
    
    console.log(`\nMedical guardrails active: ${medicalSafetyGuardrails.length}`);
    console.log(`Database keep-alive: Active (4 min interval)`);
    console.log(`Ticketing sync: Background service enabled (5 min interval)`);
    console.log(`OpenAI cost reconciliation: Daily at 6:00 AM`);
    console.log(`System alerts: SMS notifications enabled`);
    console.log(`Secret validation: ${missingSecrets.length === 0 ? 'ALL PASS' : `${missingSecrets.length} MISSING`}`);
    console.log(`========================================\n`);
    
    // Start background ticketing sync service
    ticketingSyncService.start();
    
    // Start ticket outbox retry worker (ensures no ticket data is ever lost)
    import('./services/ticketOutboxService').then(({ TicketOutboxService }) => {
      TicketOutboxService.startWorker();
    }).catch(err => console.error('[STARTUP] Failed to start ticket outbox worker:', err));
    
    // Start daily OpenAI cost reconciliation scheduler
    dailyOpenaiReconciliation.startDailySchedule();
    
    // Start grader-based push alerting (checks every 15 min)
    systemAlertService.startGraderAlertSchedule();
    
    // Start data retention policy scheduler (purges expired data daily)
    import('./services/retentionPolicyService').then(({ retentionPolicyService }) => {
      retentionPolicyService.startSchedule();
    }).catch(err => console.error('[STARTUP] Failed to start retention scheduler:', err));
    
    // Start webhook retry worker (retries failed webhook events every 60s)
    import('./services/webhookRetryWorker').then(({ webhookRetryWorker }) => {
      webhookRetryWorker.start();
    }).catch(err => console.error('[STARTUP] Failed to start webhook retry worker:', err));
    
    // Start data quality SLO monitoring (checks every 60 min)
    import('./services/dataQualitySloService').then(({ dataQualitySloService }) => {
      dataQualitySloService.startMonitoring(60);
    }).catch(err => console.error('[STARTUP] Failed to start SLO monitoring:', err));

    // Start SIP call health monitor (checks every 15 min)
    import('./services/sipHealthMonitor').then(({ start }) => {
      start();
    }).catch(err => console.error('[STARTUP] Failed to start SIP health monitor:', err));
  });
}

startVoiceServer().catch((error) => {
  console.error("Failed to start voice server:", error);
  process.exit(1);
});
