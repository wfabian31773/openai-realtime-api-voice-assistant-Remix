import { z } from 'zod';

export type Environment = 'development' | 'production';

const sharedEnvSchema = z.object({
  APP_ENV: z.enum(['development', 'production']).default('development'),
  SESSION_SECRET: z.string().optional(),
  TICKETING_API_KEY: z.string().optional(),
  TICKETING_SYSTEM_URL: z.string().optional(),
  HUMAN_AGENT_NUMBER: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  URGENT_NOTIFICATION_NUMBER: z.string().optional(),
  VOICE_AGENT_WEBHOOK_SECRET: z.string().optional(),
  DISABLE_PHI_LOGGING: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_REST_URL: z.string().optional(),
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
    urgentNotificationNumber: string | undefined;
  };
  ticketing: {
    apiKey: string | undefined;
    systemUrl: string | undefined;
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

  const domain = env.DOMAIN || process.env.REPLIT_DEV_DOMAIN || 'localhost:8000';

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
      urgentNotificationNumber: env.URGENT_NOTIFICATION_NUMBER,
    },
    ticketing: {
      apiKey: env.TICKETING_API_KEY,
      systemUrl: env.TICKETING_SYSTEM_URL,
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
