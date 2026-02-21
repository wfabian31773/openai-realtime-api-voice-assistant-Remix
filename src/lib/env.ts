// Shared environment configuration for all servers
// Centralizes env validation to reduce drift

export interface EnvConfig {
  // Database
  DATABASE_URL: string;
  
  // OpenAI
  OPENAI_API_KEY: string;
  OPENAI_PROJECT_ID: string;
  OPENAI_WEBHOOK_SECRET: string;
  
  // Twilio
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  HUMAN_AGENT_NUMBER: string;
  
  // Server
  DOMAIN: string;
  PORT?: number;
  API_PORT?: number;
  
  // Auth
  REPL_ID?: string;
  ISSUER_URL?: string;
  SESSION_SECRET?: string;
}

export function validateEnv(requiredKeys: (keyof EnvConfig)[]): void {
  const missing: string[] = [];
  
  for (const key of requiredKeys) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// Voice agent required env vars
export const VOICE_AGENT_REQUIRED: (keyof EnvConfig)[] = [
  'DOMAIN',
  'OPENAI_API_KEY',
  'OPENAI_PROJECT_ID',
  'OPENAI_WEBHOOK_SECRET',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'HUMAN_AGENT_NUMBER',
];

// API server required env vars
export const API_SERVER_REQUIRED: (keyof EnvConfig)[] = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'REPL_ID',
];

// Shared required env vars
export const SHARED_REQUIRED: (keyof EnvConfig)[] = [
  'DATABASE_URL',
  'OPENAI_API_KEY',
];
