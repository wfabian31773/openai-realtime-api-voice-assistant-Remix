import { RealtimeAgent } from '@openai/agents/realtime';
import { createAfterHoursAgent } from '../agents/afterHoursAgent';
import { createDRSSchedulerAgent } from '../agents/drsSchedulerAgent';
import { createAppointmentConfirmationAgent } from '../agents/appointmentConfirmationAgent';
import { createAnsweringServiceAgent, answeringServiceAgentConfig } from '../agents/answeringServiceAgent';
import { createFantasyFootballAgent } from '../agents/fantasyFootballAgent';
import { createNoIvrAgent, noIvrAgentConfig, type NoIvrAgentMetadata } from '../agents/noIvrAgent';
import { createNoIvrAgentV2, noIvrAgentV2Config } from '../agents/noIvrAgentV2';
import { createAzulSchedulingAgent, azulSchedulingAgentConfig } from '../agents/azulSchedulingAgent';
import { createPcpAgent, pcpAgentConfig } from '../agents/pcpAgent';
import { createOpticalAgent, opticalAgentConfig } from '../agents/opticalAgent';
import { createSurgeryAgent, surgeryAgentConfig } from '../agents/surgeryAgent';
import { createTechAgent, techAgentConfig } from '../agents/techAgent';

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
      version: noIvrAgentConfig.version, // v1.13.0: after-hours routing mandate — Request Type pinning, transcript at filing, urgent-transfer record ticket
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

    // Optical queue. Its own number, so the call is optical because of the line
    // it rang rather than because a model decided — which is what keeps its
    // prompt and its tool set small. NO handoff: operator ruling 2026-08-12,
    // only PCP and Scheduling transfer; everything else takes a callback.
    // twilioNumbers stays empty until the number is bought and the answering
    // service forwards optical overflow to it.
    this.register({
      id: opticalAgentConfig.slug,
      factory: createOpticalAgent as AgentFactory,
      enabled: true,
      description: opticalAgentConfig.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: opticalAgentConfig.version,
      voice: opticalAgentConfig.voice,
      language: opticalAgentConfig.language,
      greeting: opticalAgentConfig.greeting,
    });

    // Surgery Coordination queue. Same shape as Optical, same reasoning. NO
    // handoff: operator ruling 2026-08-12. twilioNumbers stays empty until the
    // number is bought and pointed at /api/voice/surgery.
    this.register({
      id: surgeryAgentConfig.slug,
      factory: createSurgeryAgent as AgentFactory,
      enabled: true,
      description: surgeryAgentConfig.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: surgeryAgentConfig.version,
      voice: surgeryAgentConfig.voice,
      language: surgeryAgentConfig.language,
      greeting: surgeryAgentConfig.greeting,
    });

    // Clinical Tech Support — the practice's largest queue, 103 tickets a day.
    // Same shape as Optical and Surgery. NO handoff: operator ruling
    // 2026-08-12. twilioNumbers stays empty until the number is pointed at
    // /api/voice/tech.
    this.register({
      id: techAgentConfig.slug,
      factory: createTechAgent as AgentFactory,
      enabled: true,
      description: techAgentConfig.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: techAgentConfig.version,
      voice: techAgentConfig.voice,
      language: techAgentConfig.language,
      greeting: techAgentConfig.greeting,
    });

    // Azul Vision NextGen scheduling line (San Diego pilot).
    // All scheduling decisions run through the Eye Care service's rules
    // engine (sage_* tools) — the master switch + per-location approvals
    // live in the Patient Console, not in this repo. Assign the pilot
    // Twilio number here (or via Phone Endpoints) when it's purchased.
    this.register({
      id: azulSchedulingAgentConfig.slug,
      factory: createAzulSchedulingAgent as AgentFactory,
      enabled: true,
      description: azulSchedulingAgentConfig.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: azulSchedulingAgentConfig.version,
      voice: azulSchedulingAgentConfig.voice,
      language: azulSchedulingAgentConfig.language,
      greeting: azulSchedulingAgentConfig.greeting,
    });

    this.register({
      id: pcpAgentConfig.slug,
      factory: createPcpAgent as AgentFactory,
      enabled: true,
      description: pcpAgentConfig.description,
      twilioNumbers: [],
      agentType: 'inbound',
      version: pcpAgentConfig.version,
      voice: pcpAgentConfig.voice,
      language: pcpAgentConfig.language,
      greeting: pcpAgentConfig.greeting,
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
