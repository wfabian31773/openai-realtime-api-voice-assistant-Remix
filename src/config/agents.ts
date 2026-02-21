import { RealtimeAgent } from '@openai/agents/realtime';
import { createAfterHoursAgent } from '../agents/afterHoursAgent';
import { createDRSSchedulerAgent } from '../agents/drsSchedulerAgent';
import { createAppointmentConfirmationAgent } from '../agents/appointmentConfirmationAgent';
import { createAnsweringServiceAgent, answeringServiceAgentConfig } from '../agents/answeringServiceAgent';
import { createFantasyFootballAgent } from '../agents/fantasyFootballAgent';
import { createNoIvrAgent, noIvrAgentConfig, type NoIvrAgentMetadata } from '../agents/noIvrAgent';
import { createNoIvrAgentV2, noIvrAgentV2Config } from '../agents/noIvrAgentV2';

export type AgentFactory = (...args: any[]) => RealtimeAgent | Promise<RealtimeAgent>;

export interface AgentConfig {
  id: string;
  factory: AgentFactory;
  enabled: boolean;
  description: string;
  twilioNumbers?: string[];
  agentType: 'inbound' | 'outbound';
  version?: string;
  voice?: string;      // Voice to use for this agent (e.g., 'sage', 'coral')
  language?: string;   // Language code for transcription (e.g., 'en', 'es')
  greeting?: string;   // Agent greeting message
}

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map();

  constructor() {
    // Primary inbound agent - handles all call types via tools (PRODUCTION)
    this.register({
      id: 'no-ivr',
      factory: createNoIvrAgent as AgentFactory,
      enabled: true,
      description: noIvrAgentConfig.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: '1.10.0', // v1.10.0: direct appointment answers, ghost call filtering, improved language detection, open ticket awareness, appointment confirmation handling
      voice: noIvrAgentConfig.voice,
      language: noIvrAgentConfig.language,
      greeting: noIvrAgentConfig.greeting,
    });

    // Development version - V2 Workflow-driven agent for testing
    this.register({
      id: 'dev-no-ivr',
      factory: createNoIvrAgentV2 as AgentFactory,
      enabled: true,
      description: 'DEV: ' + noIvrAgentV2Config.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: '2.0.0-workflow', // v2.0.0: Workflow engine with structured intent classification and guarded escalation
    });

    // V2 Workflow agent - separate endpoint for direct testing
    this.register({
      id: 'no-ivr-v2',
      factory: createNoIvrAgentV2 as AgentFactory,
      enabled: true,
      description: noIvrAgentV2Config.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: noIvrAgentV2Config.version,
    });

    // After-hours agent - also handles inbound calls
    this.register({
      id: 'after-hours',
      factory: createAfterHoursAgent,
      enabled: true,
      description: 'After-hours medical triage for Azul Vision',
      twilioNumbers: [],
      agentType: 'inbound',
    });

    // Answering service - daytime overflow calls
    this.register({
      id: 'answering-service',
      factory: createAnsweringServiceAgent as AgentFactory,
      enabled: true,
      description: answeringServiceAgentConfig.description,
      twilioNumbers: ['+19094135645'],
      agentType: 'inbound',
      version: answeringServiceAgentConfig.version,
      voice: answeringServiceAgentConfig.voice,
      language: answeringServiceAgentConfig.language,
      greeting: answeringServiceAgentConfig.greeting,
    });

    // Outbound agents
    this.register({
      id: 'drs-scheduler',
      factory: createDRSSchedulerAgent,
      enabled: true,
      description: 'Outbound diabetic retinopathy screening appointment scheduler',
      agentType: 'outbound',
    });

    this.register({
      id: 'appointment-confirmation',
      factory: createAppointmentConfirmationAgent,
      enabled: true,
      description: 'Outbound appointment confirmation calls',
      agentType: 'outbound',
    });

    this.register({
      id: 'fantasy-football',
      factory: createFantasyFootballAgent,
      enabled: true,
      description: 'Fantasy Football advisor with real-time NFL player stats via Sleeper API',
      agentType: 'outbound',
    });
  }

  register(config: AgentConfig): void {
    this.agents.set(config.id, config);
    console.log(`[AGENT REGISTRY] Registered agent factory: ${config.id} - ${config.description}`);
  }

  getAgentFactory(id: string): AgentFactory | undefined {
    const config = this.agents.get(id);
    return config?.enabled ? config.factory : undefined;
  }

  getAgentConfig(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getAgentFactoryByNumber(phoneNumber: string): AgentFactory | undefined {
    for (const [id, config] of this.agents.entries()) {
      if (config.enabled && config.twilioNumbers?.includes(phoneNumber)) {
        return config.factory;
      }
    }
    // Default to no-ivr agent if no specific number mapping
    return this.getAgentFactory('no-ivr');
  }

  getAgentByType(agentType: 'inbound' | 'outbound'): AgentConfig[] {
    return Array.from(this.agents.values()).filter(
      config => config.enabled && config.agentType === agentType
    );
  }

  getInboundAgents(): AgentConfig[] {
    return this.getAgentByType('inbound');
  }

  getOutboundAgents(): AgentConfig[] {
    return this.getAgentByType('outbound');
  }

  getAllAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  updateAgent(id: string, updates: Partial<AgentConfig>): boolean {
    const existing = this.agents.get(id);
    if (!existing) return false;

    this.agents.set(id, { ...existing, ...updates });
    console.log(`[AGENT REGISTRY] Updated agent: ${id}`);
    return true;
  }

  enableAgent(id: string): boolean {
    return this.updateAgent(id, { enabled: true });
  }

  disableAgent(id: string): boolean {
    return this.updateAgent(id, { enabled: false });
  }
}

// Singleton instance
export const agentRegistry = new AgentRegistry();
