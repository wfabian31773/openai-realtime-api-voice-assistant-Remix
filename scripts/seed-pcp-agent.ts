import { eq } from 'drizzle-orm';
import { db, dbReady, pool } from '../server/db';
import { agents } from '../shared/schema';
import { pcpAgentConfig } from '../src/agents/pcpAgent';

function requiredE164(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error(`${name} must be configured as an E.164 phone number`);
  }
  return value;
}

async function seed(): Promise<void> {
  const twilioPhoneNumber = requiredE164('PCP_TWILIO_PHONE_NUMBER');
  requiredE164('PCP_HUMAN_AGENT_NUMBER');
  await dbReady;

  const values = {
    name: pcpAgentConfig.name,
    slug: pcpAgentConfig.slug,
    description: pcpAgentConfig.description,
    agentType: 'inbound',
    status: 'active' as const,
    voice: pcpAgentConfig.voice,
    model: 'gpt-realtime',
    temperature: 70,
    systemPrompt: 'Runtime policy is versioned in src/agents/pcpAgent.ts; this row supplies routing and attribution.',
    welcomeGreeting: pcpAgentConfig.greeting,
    twilioPhoneNumber,
    updatedAt: new Date(),
  };

  const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.slug, 'pcp')).limit(1);
  if (existing) {
    await db.update(agents).set(values).where(eq(agents.id, existing.id));
    console.info('[PCP SEED] Updated existing pcp agent row');
  } else {
    await db.insert(agents).values(values);
    console.info('[PCP SEED] Created pcp agent row');
  }
}

seed()
  .catch((error) => {
    console.error('[PCP SEED] Failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await (pool as { end?: () => Promise<void> }).end?.();
  });
