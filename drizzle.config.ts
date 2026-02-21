import { defineConfig } from 'drizzle-kit';

function getDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  
  console.log('[Drizzle] Using DATABASE_URL for schema sync');
  return process.env.DATABASE_URL;
}

export default defineConfig({
  schema: './shared/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: getDatabaseUrl(),
  },
});
