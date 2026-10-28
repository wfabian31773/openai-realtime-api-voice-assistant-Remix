/**
 * Production wiring for /api/plugin/v1. Imported only from server/routes.ts.
 * Tests never import this file — they call mountPluginApi with a MemoryPluginStore.
 */

import { defaultDialerLock } from "../runtime/outbound/defaultLock";
import type { Express } from "express";
import { pool } from "../../server/db";
import { agentRegistry } from "../config/agents";
import { createDbOutboundStore } from "../runtime/outbound/store";
import { bindOutboundStore, bindPluginStore } from "./bindings";
import { createSqlFleetReader } from "./fleetReader";
import { flushDueOutbox } from "./messageOutbox";
import { reapStaleSending } from "./approvals";
import { mountPluginApi } from "./routes";
import { createSqlPluginStore, type SqlExec } from "./sqlStore";
import type { PluginStore } from "./store";

const OUTBOX_SWEEP_MS = 30_000;
const SENDING_SWEEP_MS = 60_000;

function sqlExecFromPool(): SqlExec {
  return async (text, params) => {
    const result = await pool.query(text, params as never);
    return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  };
}

export function startPluginSweeps(store: PluginStore): { stop: () => void } {
  const outbox = setInterval(() => {
    void flushDueOutbox(store).catch(() => {
      console.error("[plugin] outbox sweep failed");
    });
  }, OUTBOX_SWEEP_MS);
  const sending = setInterval(() => {
    void reapStaleSending(store).catch(() => {
      console.error("[plugin] stale-send sweep failed");
    });
  }, SENDING_SWEEP_MS);
  outbox.unref?.();
  sending.unref?.();
  return {
    stop() {
      clearInterval(outbox);
      clearInterval(sending);
    },
  };
}

export async function mountProductionPluginApi(app: Express): Promise<void> {
  const exec = sqlExecFromPool();
  const store = createSqlPluginStore(exec);
  bindPluginStore(store);

  let outboundStore: Awaited<ReturnType<typeof createDbOutboundStore>> | undefined;
  try {
    outboundStore = await createDbOutboundStore();
    bindOutboundStore(outboundStore);
  } catch (error) {
    console.error(
      "[plugin] outbound store unavailable; call commits will fail closed:",
      error instanceof Error ? error.message : error,
    );
  }

  startPluginSweeps(store);

  mountPluginApi(app, {
    store,
    agents: agentRegistry,
    fleet: createSqlFleetReader(exec),
    outboundStore,
    liveCallLock: defaultDialerLock,
  });
}
