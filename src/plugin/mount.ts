/**
 * Production wiring for /api/plugin/v1. Imported only from server/routes.ts.
 * Tests never import this file — they call mountPluginApi with a MemoryPluginStore.
 */

import type { Express } from "express";
import { pool } from "../../server/db";
import { agentRegistry } from "../config/agents";
import { createDbOutboundStore } from "../runtime/outbound/store";
import { createSqlFleetReader } from "./fleetReader";
import { mountPluginApi } from "./routes";
import { createSqlPluginStore, type SqlExec } from "./sqlStore";

function sqlExecFromPool(): SqlExec {
  return async (text, params) => {
    const result = await pool.query(text, params as never);
    return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  };
}

export async function mountProductionPluginApi(app: Express): Promise<void> {
  const exec = sqlExecFromPool();
  let outboundStore: Awaited<ReturnType<typeof createDbOutboundStore>> | undefined;
  try {
    outboundStore = await createDbOutboundStore();
  } catch (error) {
    console.error(
      "[plugin] outbound store unavailable; call commits will fail closed:",
      error instanceof Error ? error.message : error,
    );
  }

  mountPluginApi(app, {
    store: createSqlPluginStore(exec),
    agents: agentRegistry,
    fleet: createSqlFleetReader(exec),
    outboundStore,
  });
}
