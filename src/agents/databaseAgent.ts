import { RealtimeAgent } from '@openai/agents/realtime';
import { tool } from '@openai/agents';
import { z } from 'zod';
import type { Agent } from '../../shared/schema';

export function createDatabaseAgent(
  agentConfig: Agent,
  handoffCallback?: () => Promise<void>,
  metadata?: { callerPhone?: string; callSid?: string; dialedNumber?: string }
): RealtimeAgent {
  console.log('[Database Agent] Creating agent from database config:', {
    slug: agentConfig.slug,
    name: agentConfig.name,
    hasSystemPrompt: !!agentConfig.systemPrompt,
    voice: agentConfig.voice,
  });

  const tools: any[] = [];

  if (handoffCallback) {
    const transferToHuman = tool({
      name: 'transfer_to_human',
      description: 'Transfer the caller to a human agent when they request to speak with a person or when the situation requires human intervention.',
      parameters: z.object({
        reason: z.string().describe('Reason for transferring to human'),
      }),
      execute: async (params) => {
        console.log('[Database Agent] Transferring to human:', params.reason);
        await handoffCallback();
        return {
          action: 'transfer_initiated',
          message: 'Transferring you to a team member now. Please hold.',
        };
      },
    });
    tools.push(transferToHuman);
  }

  const endCall = tool({
    name: 'end_call',
    description: 'End the call when the conversation is complete and the caller has no further questions.',
    parameters: z.object({
      summary: z.string().describe('Brief summary of what was discussed'),
    }),
    execute: async (params) => {
      console.log('[Database Agent] Ending call:', params.summary);
      return {
        action: 'end_call',
        message: 'Thank you for calling. Have a great day.',
      };
    },
  });
  tools.push(endCall);

  const voice = (agentConfig.voice as 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse') || 'sage';

  let systemPrompt = agentConfig.systemPrompt;
  
  if (metadata?.callerPhone) {
    systemPrompt += `\n\nCALLER CONTEXT:\n- Caller's phone number: ${metadata.callerPhone}`;
  }

  console.log('[Database Agent] Configuration applied:', {
    name: agentConfig.name,
    voice,
    promptLength: systemPrompt.length,
    toolCount: tools.length,
  });

  const agent = new RealtimeAgent({
    name: agentConfig.name,
    instructions: systemPrompt,
    tools,
    voice,
  });

  return agent;
}
