import { z } from 'zod';

export type Environment = 'development' | 'production';

const sharedEnvSchema = z.object({
  APP_ENV: z.enum(['development', 'production']).default('development'),
  SESSION_SECRET: z.string().optional(),
  TICKETING_API_KEY: z.string().optional(),
  TICKETING_SYSTEM_URL: z.string().optional(),
  // Optional direct-to-app base URL for post-call enrichment (update-call-data).
  // When set, enrichment bypasses the n8n gateway to conserve n8n execution quota.
  // Falls back to TICKETING_SYSTEM_URL when unset, so behavior is unchanged by default.
  TICKETING_ENRICHMENT_URL: z.string().optional(),
  HUMAN_AGENT_NUMBER: z.string().optional(),
  NO_IVR_HUMAN_AGENT_NUMBER: z.string().optional(),
  PCP_HUMAN_AGENT_NUMBER: z.string().optional(),
  PCP_AGENT_DIDS: z.string().optional(),
  PCP_ROUTING_MODE: z.enum(['queue', 'sequential']).default('queue'),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  URGENT_NOTIFICATION_NUMBER: z.string().optional(),
  VOICE_AGENT_WEBHOOK_SECRET: z.string().optional(),
  DISABLE_PHI_LOGGING: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_REST_URL: z.string().optional(),
  // Optional Supabase transaction pooler URL (port 6543).
  // When set, production uses this instead of DATABASE_URL for better connection scaling.
  // Get it from: Supabase Dashboard → Project Settings → Database → Connection pooling → URI
  SUPABASE_POOLER_URL: z.string().optional(),
});

const devEnvSchema = sharedEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  DOMAIN: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_PROJECT_ID: z.string().optional(),
  OPENAI_WEBHOOK_SECRET: z.string().optional(),
  OPENAI_WEBHOOK_SECRET_DEV: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
});

const prodEnvSchema = sharedEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  DOMAIN: z.string().min(1),
  SUPABASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_PROJECT_ID: z.string().min(1),
  OPENAI_WEBHOOK_SECRET: z.string().min(1),
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
});

export interface EnvironmentConfig {
  env: Environment;
  isDevelopment: boolean;
  isProduction: boolean;
  domain: string;
  webhookBaseUrl: string;
  database: {
    url: string;
    isSupabase: boolean;
  };
  openai: {
    apiKey: string;
    projectId: string;
    webhookSecret: string;
    realtimeWebhookUrl: string;
  };
  twilio: {
    accountSid: string;
    authToken: string;
    phoneNumber: string | undefined;
    humanAgentNumber: string | undefined;
    noIvrHumanAgentNumber: string | undefined;
    pcpHumanAgentNumber: string | undefined;
    pcpAgentDids: string[];
    pcpRoutingMode: 'queue' | 'sequential';
    urgentNotificationNumber: string | undefined;
  };
  ticketing: {
    apiKey: string | undefined;
    systemUrl: string | undefined;
    enrichmentUrl: string | undefined;
    webhookSecret: string | undefined;
    enabled: boolean;
  };
  session: {
    secret: string | undefined;
  };
  supabase: {
    serviceKey: string | undefined;
    restUrl: string | undefined;
  };
  features: {
    disablePhiLogging: boolean;
  };
}

let cachedConfig: EnvironmentConfig | null = null;

/**
 * Which host this service tells Twilio and OpenAI to call back on.
 *
 * This is not cosmetic: `webhookBaseUrl` derived from it becomes the OpenAI realtime
 * webhook, the warm-transfer accept/status/AMD callbacks, and the office-leg bridge
 * URL. It is recomputed on every boot, so a wrong value re-applies itself on every
 * publish — which is exactly how a production deployment ends up pointing at an old
 * development workspace.
 *
 * The previous resolution was `DOMAIN || REPLIT_DEV_DOMAIN || localhost`. Replit still
 * exports REPLIT_DEV_DOMAIN inside a published deployment, so a missing DOMAIN secret
 * silently sent live call control to the dev host with nothing in the logs to say so.
 *
 * Production therefore NEVER falls back to a dev domain: it prefers the published
 * `.replit.app` host from REPLIT_DOMAINS, and if it cannot find one it reports the
 * misconfiguration loudly instead of quietly using the dev workspace.
 */
export function resolveAppDomain(params: {
  domain?: string;
  replitDomains?: string;
  replitDevDomain?: string;
  isProduction: boolean;
}): { domain: string; source: string; warning?: string } {
  const explicit = params.domain?.trim();
  if (explicit) return { domain: explicit, source: 'DOMAIN' };

  const hosts = (params.replitDomains || '').split(',').map((h) => h.trim()).filter(Boolean);
  const published = hosts.find((h) => h.endsWith('.replit.app'));
  const dev = params.replitDevDomain?.trim();

  if (params.isProduction) {
    if (published) return { domain: published, source: 'REPLIT_DOMAINS' };
    // A non-dev host is still better than the dev workspace.
    const other = hosts.find((h) => !h.endsWith('.replit.dev'));
    if (other) return { domain: other, source: 'REPLIT_DOMAINS' };
    return {
      domain: dev || 'localhost:8000',
      source: dev ? 'REPLIT_DEV_DOMAIN' : 'fallback',
      warning: 'DOMAIN is not set in this PRODUCTION deployment and no .replit.app host was found.',
    };
  }

  if (dev) return { domain: dev, source: 'REPLIT_DEV_DOMAIN' };
  if (published) return { domain: published, source: 'REPLIT_DOMAINS' };
  return { domain: 'localhost:8000', source: 'fallback' };
}

/** Would writing this callback URL point production traffic at a development host? */
export function isDevCallbackUrl(url: string): boolean {
  const host = url.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  return host.endsWith('.replit.dev') || host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

export function getEnvironmentConfig(): EnvironmentConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const isReplitDeployment = process.env.REPLIT_DEPLOYMENT === '1';
  const replitDomains = process.env.REPLIT_DOMAINS || '';
  const isProductionDomain = isReplitDeployment || (replitDomains.includes('.replit.app') && !replitDomains.includes('.replit.dev'));

  let appEnv: Environment;

  if (isProductionDomain) {
    appEnv = 'production';
    const reason = isReplitDeployment ? 'REPLIT_DEPLOYMENT=1' : '.replit.app domain';
    console.info(`[ENV] Production detected (${reason}) - using production mode`);
  } else {
    appEnv = 'development';
    console.info('[ENV] Dev domain detected (.replit.dev) - using development mode');
  }

  const isProduction = appEnv === 'production';
  const isDevelopment = !isProduction;

  const envSource: Record<string, string | undefined> = process.env as Record<string, string | undefined>;
  console.info(`[ENV] Loading secrets from Replit Secrets (process.env)`);

  const schema = isProduction ? prodEnvSchema : devEnvSchema;
  const parsed = schema.safeParse(envSource);

  if (!parsed.success) {
    const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    console.error(`[ENV] ${appEnv} configuration validation failed:`);
    errors.forEach(err => console.error(`  - ${err}`));
    console.error('[ENV] Check that all required secrets are set in Replit Secrets');
    throw new Error(`Environment configuration invalid: ${errors.join(', ')}`);
  }

  const env = parsed.data;

  const resolvedDomain = resolveAppDomain({
    domain: env.DOMAIN,
    replitDomains: process.env.REPLIT_DOMAINS,
    replitDevDomain: process.env.REPLIT_DEV_DOMAIN,
    isProduction,
  });
  const domain = resolvedDomain.domain;

  if (resolvedDomain.warning) {
    console.error('═══════════════════════════════════════════════════════════════');
    console.error(`[FATAL] ${resolvedDomain.warning}`);
    console.error('[FATAL] Every callback this service hands to Twilio and OpenAI is built');
    console.error(`[FATAL] from this domain (currently: ${domain}). Set the DOMAIN secret to`);
    console.error('[FATAL] the published host so calls come back to THIS deployment.');
    console.error('═══════════════════════════════════════════════════════════════');
  } else {
    console.info(`[ENV] Callback domain: ${domain} (source: ${resolvedDomain.source})`);
  }

  const productionDbUrl = process.env.PRODUCTION_DATABASE_URL;
  const databaseUrl = (isProduction && productionDbUrl) ? productionDbUrl : env.DATABASE_URL;

  if (isProduction && productionDbUrl) {
    console.info(`[ENV] Production: Using PRODUCTION_DATABASE_URL for database connection`);
  } else if (isProduction) {
    console.warn(`[ENV] ⚠ PRODUCTION_DATABASE_URL not set, falling back to DATABASE_URL`);
  }

  const isSupabase = databaseUrl.includes('supabase') ||
                     databaseUrl.includes('pooler.supabase') ||
                     isProduction;

  const webhookBaseUrl = `https://${domain}`;

  const webhookSecret = isDevelopment
    ? ((env as any).OPENAI_WEBHOOK_SECRET_DEV || env.OPENAI_WEBHOOK_SECRET || '')
    : (env.OPENAI_WEBHOOK_SECRET || '');

  cachedConfig = {
    env: appEnv,
    isDevelopment,
    isProduction,
    domain,
    webhookBaseUrl,
    database: {
      url: databaseUrl,
      isSupabase,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      projectId: env.OPENAI_PROJECT_ID || '',
      webhookSecret,
      realtimeWebhookUrl: `${webhookBaseUrl}/api/voice/realtime`,
    },
    twilio: {
      accountSid: (env as any).TWILIO_ACCOUNT_SID || '',
      authToken: (env as any).TWILIO_AUTH_TOKEN || '',
      phoneNumber: env.TWILIO_PHONE_NUMBER,
      humanAgentNumber: env.HUMAN_AGENT_NUMBER,
      noIvrHumanAgentNumber: env.NO_IVR_HUMAN_AGENT_NUMBER,
      pcpHumanAgentNumber: env.PCP_HUMAN_AGENT_NUMBER,
      pcpAgentDids: (env.PCP_AGENT_DIDS || '').split(',').map((number) => number.trim()).filter(Boolean),
      pcpRoutingMode: env.PCP_ROUTING_MODE,
      urgentNotificationNumber: env.URGENT_NOTIFICATION_NUMBER,
    },
    ticketing: {
      apiKey: env.TICKETING_API_KEY,
      systemUrl: env.TICKETING_SYSTEM_URL,
      enrichmentUrl: env.TICKETING_ENRICHMENT_URL,
      webhookSecret: env.VOICE_AGENT_WEBHOOK_SECRET,
      enabled: !!(env.TICKETING_API_KEY && env.TICKETING_SYSTEM_URL),
    },
    session: {
      secret: env.SESSION_SECRET,
    },
    supabase: {
      serviceKey: env.SUPABASE_SERVICE_KEY,
      restUrl: env.SUPABASE_REST_URL,
    },
    features: {
      disablePhiLogging: env.DISABLE_PHI_LOGGING === 'true',
    },
  };

  console.info(`[ENV] ✓ Loaded ${appEnv} environment configuration`);
  console.info(`[ENV]   Source: Replit Secrets`);
  console.info(`[ENV]   Domain: ${domain}`);
  console.info(`[ENV]   Database: ${isSupabase ? 'Supabase (production)' : 'Replit PostgreSQL (development)'}`);
  console.info(`[ENV]   OpenAI Webhook URL: ${cachedConfig.openai.realtimeWebhookUrl}`);

  if (!cachedConfig.openai.apiKey) {
    console.warn('[ENV] ⚠ OPENAI_API_KEY not set - voice agent calls will fail');
  }
  if (!cachedConfig.openai.webhookSecret) {
    console.warn('[ENV] ⚠ OPENAI_WEBHOOK_SECRET not set - webhook verification disabled');
  }
  if (!cachedConfig.openai.projectId) {
    console.warn('[ENV] ⚠ OPENAI_PROJECT_ID not set - SIP connections will fail');
  }

  return cachedConfig;
}

export function validateProductionConfig(): void {
  const config = getEnvironmentConfig();

  if (!config.isProduction) {
    console.info('[ENV] Skipping production validation (development mode)');
    return;
  }

  const errors: string[] = [];

  if (!config.database.isSupabase) {
    errors.push('Production must use Supabase database (SUPABASE_URL not configured)');
  }

  if (!config.openai.apiKey) {
    errors.push('OPENAI_API_KEY is required for production');
  }

  if (!config.openai.webhookSecret) {
    errors.push('OPENAI_WEBHOOK_SECRET is required for production');
  }

  if (!config.ticketing.enabled) {
    console.warn('[ENV] ⚠ Ticketing system not configured - ticket creation will fail');
  }

  if (!config.twilio.humanAgentNumber) {
    console.warn('[ENV] ⚠ HUMAN_AGENT_NUMBER not configured - handoffs will fail');
  }

  if (!config.twilio.noIvrHumanAgentNumber) {
    errors.push('NO_IVR_HUMAN_AGENT_NUMBER is required for no-IVR handoffs');
  }

  if (errors.length > 0) {
    console.error('[ENV] Production configuration errors:');
    errors.forEach(err => console.error(`  - ${err}`));
    throw new Error(`Production configuration invalid: ${errors.join(', ')}`);
  }

  console.info('[ENV] ✓ Production configuration validated');
}

export function getDatabaseUrl(): string {
  return getEnvironmentConfig().database.url;
}

export function getDomain(): string {
  return getEnvironmentConfig().domain;
}

export function getWebhookBaseUrl(): string {
  return getEnvironmentConfig().webhookBaseUrl;
}

export function isProduction(): boolean {
  return getEnvironmentConfig().isProduction;
}

export function isDevelopment(): boolean {
  return getEnvironmentConfig().isDevelopment;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}
