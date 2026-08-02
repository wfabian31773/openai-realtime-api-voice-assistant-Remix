/**
 * Simulated n8n-decision layer + optional session-bundle sender (CP 5, 11, 15–17).
 *
 * The simulator DESCRIBES the n8n involvement a turn would have had, replaying
 * copied production gateway results. The only network capability in this file
 * is the OPTIONAL session-bundle send to a SHADOW-ONLY webhook, which is
 * blocked by the budget enforcer's production-host blocklist and disabled by
 * default. Production gateway URLs are unreachable by construction.
 */
import { getShadowConfig } from './config';
import {
  digest,
  shadowSessionBundleSchema,
  type ShadowConversationState,
  type ShadowSessionBundle,
  type SimulatedN8nRecord,
} from './contracts';
import { N8nBudgetEnforcer } from './n8nBudget';

/** Verified production gateway map (doc 13). Used only to LABEL simulations. */
export const PRODUCTION_GATEWAYS: Record<string, { workflowId: string; mutating: boolean }> = {
  '/api/voice-agent/submit-ticket': { workflowId: 'yS1ZZG4Dt5uGwuPo', mutating: true },
  '/api/voice-agent/create-ticket': { workflowId: 'O3Irc3cL1YKy9HdD', mutating: true },
  '/api/voice-agent/update-call-data': { workflowId: 'uH8lfIWE9YulioCU', mutating: true },
  '/api/voice-agent/lookup': { workflowId: 'CJMYSoccfuMu3vDN', mutating: false },
  '/api/voice-agent/callback-campaign': { workflowId: '6I9WyiYsmiVzHi7f', mutating: true },
  '/api/health': { workflowId: 'MG7P0ntvguggvXe3', mutating: false },
};

/** Would this tool call have required an n8n execution, and can we replay it? */
export function simulateN8nDecision(
  state: ShadowConversationState,
  tool: string,
  payload: Record<string, unknown>,
): SimulatedN8nRecord | null {
  const endpoint =
    tool === 'create_ticket' || tool === 'create_after_hours_ticket'
      ? '/api/voice-agent/submit-ticket'
      : null;
  if (!endpoint) return null;
  const gw = PRODUCTION_GATEWAYS[endpoint];
  const replay = state.productionN8nHistory.some((r) => r.endpoint.includes(endpoint));
  return {
    workflow: gw.workflowId,
    payloadDigest: digest(payload),
    readOnly: !gw.mutating,
    mutationBlocked: true,
    executionMode: 'simulation-only',
    replayAvailable: replay,
    // Replaying a copied production result costs zero executions. The only
    // possible budget impact is the optional session bundle, accounted there.
    budgetImpact: 0,
    atTurn: state.turnCount,
  };
}

export interface BundleTransport {
  (url: string, body: ShadowSessionBundle, token: string): Promise<{ ok: boolean; status: number }>;
}

interface QueuedBundle {
  bundle: ShadowSessionBundle;
  attempts: number;
  nextAttemptAt: number;
}

/**
 * Session-bundle sender with batching, bounded retry, and budget gating.
 * Inert unless SHADOW_N8N_ENABLED and a non-production webhook is configured.
 */
export class ShadowBundleSender {
  private queue: QueuedBundle[] = [];
  private lastFlush = Date.now();
  readonly enforcer: N8nBudgetEnforcer;

  constructor(
    enforcer?: N8nBudgetEnforcer,
    private transport?: BundleTransport,
  ) {
    this.enforcer = enforcer ?? new N8nBudgetEnforcer(getShadowConfig().n8n);
  }

  enqueue(sessionId: string, agentId: string, bundleData: Record<string, unknown>): void {
    const cfg = getShadowConfig().n8n;
    if (!cfg.enabled) return; // default: nothing queued, nothing sent
    const bundle: ShadowSessionBundle = {
      shadowMode: true,
      executionMode: 'simulation-only',
      idempotencyKey: `shadow-${sessionId}`,
      sessionId,
      agentId,
      bundle: bundleData,
    };
    const parsed = shadowSessionBundleSchema.safeParse(bundle);
    if (!parsed.success) return;
    this.queue.push({ bundle: parsed.data, attempts: 0, nextAttemptAt: 0 });
  }

  /** Batch-aware flush; call opportunistically (never from the live call path). */
  async flush(now: Date = new Date()): Promise<{ sent: number; blocked: number }> {
    const cfg = getShadowConfig().n8n;
    let sent = 0;
    let blocked = 0;
    if (!cfg.enabled || this.queue.length === 0) return { sent, blocked };

    const waitedMin = (now.getTime() - this.lastFlush) / 60000;
    const due =
      !cfg.batchingEnabled ||
      this.queue.length >= cfg.batchSize ||
      waitedMin >= cfg.batchMaxWaitMin;
    if (!due) return { sent, blocked };
    this.lastFlush = now.getTime();

    const ready = this.queue.filter((q) => q.nextAttemptAt <= now.getTime());
    for (const item of ready) {
      const { bundle } = item;
      const decision = this.enforcer.decide(bundle.sessionId, bundle.idempotencyKey, {
        isRetry: item.attempts > 0,
        now,
      });
      if (!decision.allowed) {
        blocked++;
        // fail closed: drop from queue on hard blocks; keep for retry only on
        // transient transport errors (handled below), never on budget blocks.
        this.queue = this.queue.filter((q) => q !== item);
        continue;
      }
      this.enforcer.record(bundle.sessionId, bundle.idempotencyKey, {
        isRetry: item.attempts > 0,
        now,
      });
      try {
        if (!this.transport) throw new Error('no transport configured');
        const res = await this.transport(cfg.webhookUrl, bundle, process.env.SHADOW_N8N_TOKEN ?? '');
        if (res.ok) {
          sent++;
          this.queue = this.queue.filter((q) => q !== item);
        } else {
          throw new Error(`status ${res.status}`);
        }
      } catch {
        item.attempts++;
        if (item.attempts > cfg.retryMax) {
          this.queue = this.queue.filter((q) => q !== item); // spool keeps the session replayable
        } else {
          item.nextAttemptAt = now.getTime() + Math.pow(2, item.attempts) * 1000; // backoff outside n8n
        }
      }
    }
    return { sent, blocked };
  }

  get pending(): number {
    return this.queue.length;
  }
}
