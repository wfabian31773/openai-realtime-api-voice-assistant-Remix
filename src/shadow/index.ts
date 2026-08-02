/**
 * Shadow system wiring. initShadow() is called once from src/server.ts boot,
 * wrapped there in try/catch; with SHADOW_MODE_ENABLED unset it does nothing
 * but read config and return. No timer, no subscription, no allocation beyond
 * the singleton tap that production taps already reference.
 */
import { getShadowConfig } from './config';
import { shadowTap } from './tap';
import { ShadowPipeline } from './pipeline';
import { buildOperationalReport, metrics, shadowLog } from './observability';
import { SpoolWriter } from './spool';
import { createLlmRefine } from './llmAdapter';
import { ModelBudget } from './modelRouter';

export { shadowTap } from './tap';

let pipeline: ShadowPipeline | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

export function initShadow(): { enabled: boolean } {
  const cfg = getShadowConfig();
  if (!cfg.enabled) {
    return { enabled: false };
  }
  if (pipeline) return { enabled: true };

  // With model routing enabled, elevated-signal turns are refined by the
  // configured GPT-5.6 tier models (budget-gated); otherwise deterministic only.
  pipeline = cfg.modelRoutingEnabled
    ? new ShadowPipeline({ llmRefine: createLlmRefine(new ModelBudget(cfg)) })
    : new ShadowPipeline();
  shadowTap.subscribe((events) => pipeline!.ingest(events));

  // Session-completion source that needs no production edit: the lifecycle
  // coordinator's existing 'call-ended' event. Dynamic import so a broken
  // production module graph can never be worsened by shadow, and vice versa.
  import('../services/callLifecycleCoordinator')
    .then((mod) => {
      const coordinator = (mod as Record<string, unknown>).callLifecycleCoordinator as
        | { on?: (ev: string, fn: (p: Record<string, unknown>) => void) => void }
        | undefined;
      coordinator?.on?.('call-ended', (payload) => {
        try {
          const sessionId = String(payload.callLogId ?? payload.twilioCallSid ?? '');
          if (!sessionId) return;
          // agentId unknown at this layer; the pipeline resolves the session by
          // any known alias and ignores unknown sessions.
          for (const [sid, s] of pipeline!.sessions) {
            const corr = (s.state.metadata.correlation ?? {}) as Record<string, unknown>;
            if (sid === sessionId || corr.twilioCallSid === payload.twilioCallSid || corr.callLogId === payload.callLogId) {
              shadowTap.emit('session_completed', sid, s.state.agentId, {
                status: String(payload.status ?? 'completed'),
                duration: payload.duration,
                transferredToHuman: payload.transferredToHuman,
              }, { component: 'lifecycle' });
              break;
            }
          }
        } catch {
          metrics.inc('lifecycle_bridge_errors');
        }
      });
    })
    .catch(() => {
      // Coordinator unavailable (e.g. replay context) — session timeouts cover completion.
      metrics.inc('lifecycle_bridge_unavailable');
    });

  sweepTimer = setInterval(() => {
    pipeline?.sweepStaleSessions().catch(() => metrics.inc('sweep_errors'));
    new SpoolWriter().purgeOldFiles().catch(() => metrics.inc('retention_errors'));
  }, 60_000);
  sweepTimer.unref(); // never keep the process alive for shadow's sake

  shadowLog('info', 'shadow_initialized', {
    agentAllowlist: cfg.agentAllowlist,
    capturePct: cfg.capturePct,
    modelRouting: cfg.modelRoutingEnabled,
    n8nEnabled: cfg.n8n.enabled,
  });
  return { enabled: true };
}

export function shadowHealth(): Record<string, unknown> {
  if (!pipeline) return { enabled: false };
  return buildOperationalReport({
    tapCounters: shadowTap.counters,
    activeSessions: pipeline.sessions.size,
    reviewQueueDepth: pipeline.reviewQueue.list().length,
    budgetSnapshot: pipeline.bundleSender.enforcer.snapshot() as unknown as Record<string, unknown>,
    verdictCounts: Object.fromEntries(metrics.labeled.get('session_verdict') ?? []),
  });
}

/** Test hook. */
export function _resetShadowForTests(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  pipeline = null;
  shadowTap.reset();
}
