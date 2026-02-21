#!/usr/bin/env npx tsx
/**
 * Backfill Twilio Insights for all calls missing carrier/whoHungUp data
 * 
 * Usage:
 *   Production: npx tsx scripts/backfill-twilio-insights.ts
 *   Development: npx tsx scripts/backfill-twilio-insights.ts --dev
 * 
 * Required environment variables:
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - DATABASE_URL (Replit) or SUPABASE_URL (production .env file)
 */
import { config } from 'dotenv';

// Check if --dev flag is passed to use Replit's DATABASE_URL
const isDev = process.argv.includes('--dev');

// Save Replit DATABASE_URL before dotenv potentially overwrites it
const replitDbUrl = process.env.DATABASE_URL;

// Load .env file (for production secrets)
config({ path: '.env' });

// In dev mode, restore Replit's DATABASE_URL
if (isDev && replitDbUrl) {
  process.env.DATABASE_URL = replitDbUrl;
}

import Twilio from 'twilio';
import pg from 'pg';
const { Pool } = pg;

const BATCH_SIZE = 10;
const DELAY_BETWEEN_CALLS_MS = 200;

interface CallRow {
  id: string;
  call_sid: string;
}

interface InsightsData {
  fromConnectionType?: string;
  fromCountry?: string;
  fromCarrier?: string;
  toConnectionType?: string;
  toCountry?: string;
  toCarrier?: string;
  whoHungUp?: string;
  postDialDelayMs?: number;
  lastSipResponse?: string;
  callState?: string;
  edgeLocation?: string;
  duration?: number;
  twilioCostCents?: number;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchInsightsForCall(client: Twilio.Twilio, callSid: string): Promise<InsightsData | null> {
  try {
    const insights: InsightsData = {};
    
    const call = await client.calls(callSid).fetch();
    insights.duration = call.duration ? parseInt(call.duration) : undefined;
    
    if (call.price) {
      const priceValue = parseFloat(call.price);
      insights.twilioCostCents = Math.round(Math.abs(priceValue) * 100);
    }

    try {
      const summary = await client.insights.v1.calls(callSid).summary().fetch();
      
      if (summary.from) {
        const from = summary.from as any;
        insights.fromConnectionType = from.connection;
        insights.fromCountry = from.country_code;
        insights.fromCarrier = from.carrier;
      }
      
      if (summary.to) {
        const to = summary.to as any;
        insights.toConnectionType = to.connection;
        insights.toCountry = to.country_code;
        insights.toCarrier = to.carrier;
      }

      if (summary.callState) {
        insights.callState = summary.callState;
      }

      const properties = (summary as any).properties || {};
      if (properties.disconnected_by) {
        insights.whoHungUp = properties.disconnected_by;
      }
      if (properties.last_sip_response_num) {
        insights.lastSipResponse = `${properties.last_sip_response_num}`;
      }
      if (properties.pdd_ms !== undefined) {
        insights.postDialDelayMs = properties.pdd_ms;
      }
      if (properties.edge) {
        insights.edgeLocation = properties.edge;
      }

    } catch (summaryError: any) {
      if (summaryError.status === 404) {
        console.log(`  [SKIP] No insights available for ${callSid}`);
        return null;
      }
      throw summaryError;
    }

    return insights;
  } catch (error: any) {
    console.error(`  [ERROR] Failed to fetch insights for ${callSid}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Twilio Insights Backfill Script');
  console.log('='.repeat(60));

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  // Use Replit's DATABASE_URL in dev mode, otherwise use SUPABASE_URL from .env
  let databaseUrl: string;
  if (isDev && replitDbUrl) {
    databaseUrl = replitDbUrl;
    console.log('Mode: DEVELOPMENT (using Replit database)');
  } else {
    databaseUrl = process.env.SUPABASE_URL || process.env.DATABASE_URL || '';
    console.log('Mode: PRODUCTION (using Supabase database)');
  }

  if (!accountSid || !authToken) {
    console.error('ERROR: Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
    process.exit(1);
  }

  if (!databaseUrl) {
    console.error('ERROR: Missing database URL');
    console.error('  For production: Set SUPABASE_URL in .env');
    console.error('  For development: Run with --dev flag');
    process.exit(1);
  }

  // Mask credentials in log output
  const maskedUrl = databaseUrl.replace(/:[^:@]+@/, ':***@');
  console.log(`Database: ${maskedUrl.substring(0, 60)}...`);
  console.log(`Twilio Account: ${accountSid}`);
  console.log('');

  const pool = new Pool({ 
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('supabase') ? { rejectUnauthorized: false } : undefined
  });
  const twilioClient = Twilio(accountSid, authToken);

  try {
    const countResult = await pool.query(`
      SELECT COUNT(*) as total 
      FROM call_logs 
      WHERE call_sid IS NOT NULL 
        AND call_sid != ''
        AND (who_hung_up IS NULL OR from_carrier IS NULL)
    `);
    const totalCalls = parseInt(countResult.rows[0].total);
    
    console.log(`Found ${totalCalls} calls missing insights data`);
    
    if (totalCalls === 0) {
      console.log('Nothing to backfill!');
      await pool.end();
      return;
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    while (processed < totalCalls) {
      const batchResult = await pool.query<CallRow>(`
        SELECT id, call_sid 
        FROM call_logs 
        WHERE call_sid IS NOT NULL 
          AND call_sid != ''
          AND (who_hung_up IS NULL OR from_carrier IS NULL)
        ORDER BY created_at DESC
        LIMIT $1
      `, [BATCH_SIZE]);

      if (batchResult.rows.length === 0) break;

      for (const row of batchResult.rows) {
        processed++;
        console.log(`[${processed}/${totalCalls}] Processing ${row.call_sid}...`);

        const insights = await fetchInsightsForCall(twilioClient, row.call_sid);
        
        if (!insights) {
          skipped++;
          continue;
        }

        try {
          const updateFields: string[] = [];
          const values: any[] = [];
          let paramCount = 1;

          if (insights.fromCarrier) {
            updateFields.push(`from_carrier = $${paramCount++}`);
            values.push(insights.fromCarrier);
          }
          if (insights.toCarrier) {
            updateFields.push(`to_carrier = $${paramCount++}`);
            values.push(insights.toCarrier);
          }
          if (insights.fromConnectionType) {
            updateFields.push(`from_connection_type = $${paramCount++}`);
            values.push(insights.fromConnectionType);
          }
          if (insights.toConnectionType) {
            updateFields.push(`to_connection_type = $${paramCount++}`);
            values.push(insights.toConnectionType);
          }
          if (insights.fromCountry) {
            updateFields.push(`from_country = $${paramCount++}`);
            values.push(insights.fromCountry);
          }
          if (insights.toCountry) {
            updateFields.push(`to_country = $${paramCount++}`);
            values.push(insights.toCountry);
          }
          if (insights.whoHungUp) {
            updateFields.push(`who_hung_up = $${paramCount++}`);
            values.push(insights.whoHungUp);
          }
          if (insights.postDialDelayMs !== undefined) {
            updateFields.push(`post_dial_delay_ms = $${paramCount++}`);
            values.push(insights.postDialDelayMs);
          }
          if (insights.lastSipResponse) {
            updateFields.push(`last_sip_response = $${paramCount++}`);
            values.push(insights.lastSipResponse);
          }
          if (insights.callState) {
            updateFields.push(`call_state = $${paramCount++}`);
            values.push(insights.callState);
          }
          if (insights.edgeLocation) {
            updateFields.push(`edge_location = $${paramCount++}`);
            values.push(insights.edgeLocation);
          }
          if (insights.duration !== undefined) {
            updateFields.push(`duration = $${paramCount++}`);
            values.push(insights.duration);
          }
          if (insights.twilioCostCents !== undefined) {
            updateFields.push(`twilio_cost_cents = $${paramCount++}`);
            values.push(insights.twilioCostCents);
          }
          
          updateFields.push(`twilio_insights_fetched_at = $${paramCount++}`);
          values.push(new Date());

          if (updateFields.length > 1) {
            values.push(row.id);
            await pool.query(`
              UPDATE call_logs 
              SET ${updateFields.join(', ')}
              WHERE id = $${paramCount}
            `, values);
            
            // Show the external party's carrier (not Twilio)
            const externalCarrier = insights.fromCarrier === 'Twilio' ? insights.toCarrier : insights.fromCarrier;
            console.log(`  ✓ Updated: carrier=${externalCarrier || 'unknown'}, whoHungUp=${insights.whoHungUp}`);
            updated++;
          } else {
            skipped++;
          }
        } catch (dbError: any) {
          console.error(`  [DB ERROR] ${dbError.message}`);
          errors++;
        }

        await sleep(DELAY_BETWEEN_CALLS_MS);
      }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('Backfill Complete');
    console.log('='.repeat(60));
    console.log(`Total processed: ${processed}`);
    console.log(`Updated: ${updated}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Errors: ${errors}`);

  } catch (error: any) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
