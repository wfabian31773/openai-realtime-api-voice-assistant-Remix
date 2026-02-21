# Production Setup Guide

This document outlines how to set up and deploy the Azul Vision AI Operations Hub with properly separated development and production environments.

## Architecture Overview

### Environment Separation

| Component | Development | Production |
|-----------|-------------|------------|
| **Database** | Replit PostgreSQL | Supabase |
| **Server** | Replit Dev Environment | Replit Deployment (VM) |
| **Domain** | `*.replit.dev` | `*.replit.app` or custom domain |
| **OpenAI Webhook** | Dev webhook URL | Production webhook URL |
| **Twilio Numbers** | Test numbers | Production numbers |

### Server Architecture

The system runs two Express servers:
1. **API Server** (port 5000) - Dashboard, API endpoints, user management
2. **Voice Agent Server** (port 8000) - Twilio webhooks, OpenAI Realtime integration

## Step 1: Supabase Database Setup

### 1.1 Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your project reference ID and region
3. Go to **Settings → Database → Connection string**
4. Copy the **URI** connection string (pooler mode recommended for serverless)

### 1.2 Configure Production Database Secret

In your Replit project, add the Supabase connection string:

```
SUPABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

### 1.3 Run Database Migrations

Before deploying, run migrations against production:

```bash
# Set APP_ENV temporarily for migration
APP_ENV=production npm run db:push
```

## Step 2: OpenAI Realtime API Configuration

### 2.1 Create Separate OpenAI Projects (Recommended)

For clean separation, create two OpenAI projects:
- **Development Project** - For testing and development
- **Production Project** - For live production traffic

### 2.2 Configure Webhook URLs

**Development Project:**
```
Webhook URL: https://your-replit-dev-url.replit.dev/api/voice/realtime
```

**Production Project:**
```
Webhook URL: https://your-app-name.replit.app/api/voice/realtime
```

### 2.3 Update Secrets

For each environment, ensure the correct OpenAI secrets are set:
- `OPENAI_API_KEY` - Your OpenAI API key
- `OPENAI_PROJECT_ID` - The project ID for that environment
- `OPENAI_WEBHOOK_SECRET` - The webhook secret for that project

## Step 3: Twilio Configuration

### 3.1 Phone Number Configuration

Configure different Twilio numbers for each environment:

**Development Numbers:**
- Point Voice URL to: `https://your-replit-dev-url.replit.dev/api/voice/incoming-call`

**Production Numbers:**
- Point Voice URL to: `https://your-app-name.replit.app/api/voice/incoming-call`

### 3.2 Twilio Credentials

Both environments can share the same Twilio account, but ensure:
- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are configured
- `HUMAN_AGENT_NUMBER` is set for production handoffs

## Step 4: Environment Variables

### Development Environment (`APP_ENV=development`)

| Variable | Description |
|----------|-------------|
| `APP_ENV` | Set to `development` |
| `DOMAIN` | Your Replit dev domain |
| `DATABASE_URL` | Replit PostgreSQL (auto-configured) |
| `OPENAI_API_KEY` | Dev OpenAI key |
| `OPENAI_PROJECT_ID` | Dev project ID |
| `OPENAI_WEBHOOK_SECRET` | Dev webhook secret |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `SESSION_SECRET` | Session signing secret |

### Production Environment (`APP_ENV=production`)

| Variable | Description |
|----------|-------------|
| `APP_ENV` | Set to `production` |
| `DOMAIN` | Your production domain |
| `SUPABASE_URL` | Supabase connection string |
| `DATABASE_URL` | Can be same as SUPABASE_URL |
| `OPENAI_API_KEY` | Production OpenAI key |
| `OPENAI_PROJECT_ID` | Production project ID |
| `OPENAI_WEBHOOK_SECRET` | Production webhook secret |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TICKETING_API_KEY` | Production ticketing key |
| `TICKETING_SYSTEM_URL` | Production ticketing URL |
| `SESSION_SECRET` | Session signing secret |
| `HUMAN_AGENT_NUMBER` | Human agent handoff number |

## Step 5: Deployment

### 5.1 Verify Environment Configuration

Before deploying, verify your configuration:

1. Check that `APP_ENV=production` is set in production environment
2. Verify `SUPABASE_URL` is configured
3. Confirm OpenAI webhook URL matches your production domain
4. Confirm Twilio numbers point to production domain

### 5.2 Deploy via Replit

1. Click the **Deploy** button in Replit
2. Select **VM deployment** (for always-on servers with WebSocket support)
3. Confirm the deployment

### 5.3 Verify Deployment

After deployment:
1. Check logs show `[ENV] ✓ Loaded production environment configuration`
2. Verify `[ENV]   Database: Supabase (production)`
3. Make a test call to verify end-to-end functionality

## Troubleshooting

### OpenAI Webhook Not Arriving

1. Verify the webhook URL in OpenAI dashboard matches your production domain
2. Check that `OPENAI_WEBHOOK_SECRET` matches between OpenAI and your server
3. Look for logs: `[DEBUG] Webhook Base URL: https://...`

### Database Connection Issues

1. Verify `SUPABASE_URL` is correctly formatted
2. Check Supabase dashboard for connection limits
3. Ensure IP allowlist includes Replit's IPs (or is disabled)

### Twilio Calls Not Routing

1. Verify phone number webhook URLs point to correct domain
2. Check Twilio console for call logs and error messages
3. Ensure `/api/voice/incoming-call` endpoint is accessible

## Rollback Procedure

If production issues occur:
1. Use Replit's checkpoint system to rollback code
2. Database changes can be reverted via Supabase dashboard
3. Twilio numbers can be quickly re-pointed to a working deployment

## Monitoring

The system includes built-in health checks:
- `/healthz` - Basic server health
- Database keep-alive pings every 4 minutes
- Call session persistence in PostgreSQL

## Security Checklist

- [ ] `APP_ENV=production` is set
- [ ] All secrets are configured (not committed to git)
- [ ] `DISABLE_PHI_LOGGING=true` for HIPAA compliance
- [ ] OpenAI webhook secret is unique per environment
- [ ] Database uses SSL (Supabase enforces this)
