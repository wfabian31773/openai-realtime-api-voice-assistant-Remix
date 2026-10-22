/**
 * Read tools. No phone numbers, bodies or transcripts leave these handlers.
 */

import { campaignEnabled, outboundDialingEnabled } from "../runtime/outbound/campaign";
import { pluginWritesEnabled } from "./writesEnabled";
import {
  SI_ASSISTANT_CALLER_ID_ENV,
  SI_ASSISTANT_ENABLE_ENV,
  SI_ASSISTANT_SLUG,
  graphMailConfigured,
} from "./siAssistantConstants";

export interface AgentSummary {
  id: string;
  description: string;
  agentType: string;
  enabled: boolean;
  version?: string;
}

export interface AgentSource {
  getAllAgents(): Array<{
    id: string;
    description: string;
    agentType: string;
    enabled: boolean;
    version?: string;
    outbound?: { campaignKey: string; enableEnv: string; callerIdEnv: string };
  }>;
}

export function listAgents(source: AgentSource): AgentSummary[] {
  return source.getAllAgents().map((a) => ({
    id: a.id,
    description: a.description,
    agentType: a.agentType,
    enabled: a.enabled,
    version: a.version,
  }));
}

export interface HealthSnapshot {
  writesEnabled: boolean;
  outboundDialing: boolean;
  siAssistantCampaignEnabled: boolean;
  siAssistantNumberConfigured: boolean;
  graphConfigured: boolean;
  callbackWebhookConfigured: boolean;
}

export function agentHealth(env: Record<string, string | undefined> = process.env): HealthSnapshot {
  return {
    writesEnabled: pluginWritesEnabled(env),
    outboundDialing: outboundDialingEnabled(env),
    siAssistantCampaignEnabled: env[SI_ASSISTANT_ENABLE_ENV] === "1",
    siAssistantNumberConfigured: Boolean((env[SI_ASSISTANT_CALLER_ID_ENV] ?? "").trim()),
    graphConfigured: graphMailConfigured(env),
    callbackWebhookConfigured: Boolean(
      (env.SI_ASSISTANT_CALLBACK_WEBHOOK_URL ?? "").trim() &&
        (env.SI_ASSISTANT_CALLBACK_WEBHOOK_SECRET ?? "").trim(),
    ),
  };
}

export interface FleetDayRow {
  slug: string;
  calls: number;
  filed: number;
  outcomes: Record<string, number>;
}

export interface RecentOutcome {
  slug: string;
  outcome: string | null;
  durationSeconds: number | null;
  filed: boolean;
  startedAt: string | null;
}

export interface FleetReader {
  fleetToday(day: string): Promise<FleetDayRow[]>;
  recentOutcomes(limit: number): Promise<RecentOutcome[]>;
  outboundQueued(campaignKey: string): Promise<number>;
}

export function emptyFleetReader(): FleetReader {
  return {
    async fleetToday() {
      return [];
    },
    async recentOutcomes() {
      return [];
    },
    async outboundQueued() {
      return 0;
    },
  };
}

export function outboundStatus(
  env: Record<string, string | undefined>,
  queued: number,
): Record<string, unknown> {
  return {
    slug: SI_ASSISTANT_SLUG,
    fleetDialing: outboundDialingEnabled(env),
    campaignEnabled: campaignEnabled(
      {
        campaignKey: SI_ASSISTANT_SLUG,
        enableEnv: SI_ASSISTANT_ENABLE_ENV,
        callerIdEnv: SI_ASSISTANT_CALLER_ID_ENV,
        window: { startHour: 9, endHour: 20, days: [0, 1, 2, 3, 4, 5, 6], skipHolidays: true },
        caps: { perDay: 1, perWeek: 3, total: 3, minHoursBetween: 20 },
        concurrency: 1,
        greeting: () => "",
        voicemail: () => "",
      },
      env,
    ),
    callerIdConfigured: Boolean((env[SI_ASSISTANT_CALLER_ID_ENV] ?? "").trim()),
    queued,
  };
}
