/**
 * ShadowTap — the ONLY surface production code touches (Checkpoint 4).
 *
 * Contract with the live call path:
 *  - emit() is synchronous, returns void, and NEVER throws (outer catch inside).
 *  - When the shadow system is disabled the fast path is one boolean check.
 *  - A full queue drops the oldest event and counts it; it never blocks.
 *  - Consumers drain asynchronously (setImmediate); a consumer error is caught,
 *    counted, and never propagates back toward the emitter.
 *
 * Pattern precedent: qvoEmitterService (fire-and-forget, no-op unless configured).
 */
import { getShadowConfig } from './config';
import { makeEventId, shadowEventSchema, type ShadowEvent, type ShadowEventType } from './contracts';

export interface TapCounters {
  emitted: number;
  sampledOut: number;
  dropped: number;
  consumerErrors: number;
  invalid: number;
}

type Consumer = (events: ShadowEvent[]) => void | Promise<void>;

/** FNV-1a — cheap, deterministic session-sticky sampling. */
export function sampleBucket(sessionId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h % 100;
}

export class ShadowTap {
  private queue: ShadowEvent[] = [];
  private seq = 0;
  private turnBySession = new Map<string, number>();
  private drainScheduled = false;
  private consumers: Consumer[] = [];
  readonly counters: TapCounters = { emitted: 0, sampledOut: 0, dropped: 0, consumerErrors: 0, invalid: 0 };

  subscribe(consumer: Consumer): void {
    this.consumers.push(consumer);
  }

  /** True when this session should be captured (enabled + allowlist + sample). */
  isCaptured(sessionId: string, agentId: string): boolean {
    try {
      const cfg = getShadowConfig();
      if (!cfg.enabled) return false;
      if (cfg.agentAllowlist.length === 0) return false;
      if (!cfg.agentAllowlist.includes(agentId)) return false;
      if (cfg.capturePct <= 0) return false;
      if (sampleBucket(sessionId) >= cfg.capturePct) return false;
      return true;
    } catch {
      return false; // config failure ⇒ shadow off, production unaffected
    }
  }

  emit(
    type: ShadowEventType,
    sessionId: string,
    agentId: string,
    payload: Record<string, unknown>,
    opts: { sensitive?: boolean; component?: ShadowEvent['source']['component'] } = {},
  ): void {
    try {
      if (!this.isCaptured(sessionId, agentId)) {
        this.counters.sampledOut++;
        return;
      }
      const seq = this.seq++;
      if (type === 'user_transcript') {
        this.turnBySession.set(sessionId, (this.turnBySession.get(sessionId) ?? 0) + 1);
      }
      const event: ShadowEvent = {
        contractVersion: 1,
        eventId: makeEventId(sessionId, type, seq, payload),
        sessionId,
        agentId,
        turnId: this.turnBySession.get(sessionId) ?? 0,
        seq,
        ts: new Date().toISOString(),
        type,
        payload: payload ?? {},
        source: { component: opts.component ?? 'other', pid: process.pid },
        sensitive: opts.sensitive ?? false,
      };
      const parsed = shadowEventSchema.safeParse(event);
      if (!parsed.success) {
        this.counters.invalid++;
        return;
      }
      const cfg = getShadowConfig();
      if (this.queue.length >= cfg.queueMax) {
        this.queue.shift();
        this.counters.dropped++;
      }
      this.queue.push(parsed.data);
      this.counters.emitted++;
      if (type === 'session_completed' || type === 'session_failed') {
        this.turnBySession.delete(sessionId);
      }
      this.scheduleDrain();
    } catch {
      // Absolute barrier: shadow failures must never reach production frames.
      this.counters.consumerErrors++;
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drainNow();
    });
  }

  /** Exposed for tests and replay; safe to call any time. */
  drainNow(): void {
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) return;
    for (const consumer of this.consumers) {
      try {
        const r = consumer(batch);
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch(() => {
            this.counters.consumerErrors++;
          });
        }
      } catch {
        this.counters.consumerErrors++;
      }
    }
  }

  /** Test hook. */
  reset(): void {
    this.queue = [];
    this.seq = 0;
    this.turnBySession.clear();
    this.consumers = [];
    this.counters.emitted = 0;
    this.counters.sampledOut = 0;
    this.counters.dropped = 0;
    this.counters.consumerErrors = 0;
    this.counters.invalid = 0;
  }
}

export const shadowTap = new ShadowTap();
