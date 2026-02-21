import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const DEV_DATABASE_URL = process.env.DATABASE_URL;

if (!DEV_DATABASE_URL) {
  console.error('❌ DATABASE_URL (dev) not found');
  process.exit(1);
}

function escapeValue(value: any): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function generateInsertFromRow(tableName: string, row: Record<string, any>, onConflict?: string): string {
  const columns = Object.keys(row).map(k => `"${k}"`);
  const values = Object.values(row).map(v => escapeValue(v));
  
  let sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')})`;
  
  if (onConflict) {
    sql += ` ON CONFLICT ${onConflict}`;
  }
  
  return sql + ';';
}

async function exportData() {
  console.log('📊 Exporting data from development database...\n');
  
  const pool = new Pool({ connectionString: DEV_DATABASE_URL });
  const outputLines: string[] = [];
  
  outputLines.push('-- =====================================================');
  outputLines.push('-- Azul Vision Production Data Migration');
  outputLines.push(`-- Generated: ${new Date().toISOString()}`);
  outputLines.push('-- =====================================================');
  outputLines.push('-- INSTRUCTIONS:');
  outputLines.push('-- 1. Review this file for any data you do NOT want migrated');
  outputLines.push('-- 2. Connect to your production Supabase database');
  outputLines.push('-- 3. Run this SQL file against production');
  outputLines.push('-- =====================================================');
  outputLines.push('');
  outputLines.push('BEGIN;');
  outputLines.push('');
  
  try {
    const agentsResult = await pool.query('SELECT * FROM agents ORDER BY created_at');
    const callLogsResult = await pool.query('SELECT * FROM call_logs ORDER BY start_time');
    const campaignsResult = await pool.query('SELECT * FROM campaigns ORDER BY created_at');
    const contactsResult = await pool.query('SELECT * FROM campaign_contacts ORDER BY created_at');
    
    console.log(`   Agents: ${agentsResult.rows.length}`);
    console.log(`   Call Logs: ${callLogsResult.rows.length}`);
    console.log(`   Campaigns: ${campaignsResult.rows.length}`);
    console.log(`   Campaign Contacts: ${contactsResult.rows.length}`);
    
    outputLines.push('-- =====================================================');
    outputLines.push(`-- AGENTS (${agentsResult.rows.length} records)`);
    outputLines.push('-- Uses ON CONFLICT to skip existing agents by slug');
    outputLines.push('-- =====================================================');
    outputLines.push('');
    
    for (const row of agentsResult.rows) {
      row.created_by = null;
      outputLines.push(generateInsertFromRow('agents', row, '(slug) DO NOTHING'));
    }
    
    outputLines.push('');
    outputLines.push('-- =====================================================');
    outputLines.push(`-- CALL LOGS (${callLogsResult.rows.length} records)`);
    outputLines.push('-- Uses ON CONFLICT to skip existing calls by call_sid');
    outputLines.push('-- =====================================================');
    outputLines.push('');
    
    for (const row of callLogsResult.rows) {
      row.user_id = null;
      outputLines.push(generateInsertFromRow('call_logs', row, '(call_sid) DO NOTHING'));
    }
    
    outputLines.push('');
    outputLines.push('-- =====================================================');
    outputLines.push(`-- CAMPAIGNS (${campaignsResult.rows.length} records)`);
    outputLines.push('-- Uses ON CONFLICT to skip existing campaigns by id');
    outputLines.push('-- =====================================================');
    outputLines.push('');
    
    for (const row of campaignsResult.rows) {
      row.created_by = null;
      outputLines.push(generateInsertFromRow('campaigns', row, '(id) DO NOTHING'));
    }
    
    outputLines.push('');
    outputLines.push('-- =====================================================');
    outputLines.push(`-- CAMPAIGN CONTACTS (${contactsResult.rows.length} records)`);
    outputLines.push('-- Uses ON CONFLICT to skip existing contacts by id');
    outputLines.push('-- =====================================================');
    outputLines.push('');
    
    for (const row of contactsResult.rows) {
      outputLines.push(generateInsertFromRow('campaign_contacts', row, '(id) DO NOTHING'));
    }
    
    outputLines.push('');
    outputLines.push('COMMIT;');
    outputLines.push('');
    outputLines.push('-- Migration complete!');
    
    const outputPath = path.join(process.cwd(), 'scripts', 'production-migration.sql');
    fs.writeFileSync(outputPath, outputLines.join('\n'), 'utf8');
    
    console.log(`\n✅ Export complete!`);
    console.log(`   Output file: ${outputPath}`);
    console.log(`\n📋 Next steps:`);
    console.log(`   1. Review the SQL file for accuracy`);
    console.log(`   2. Connect to your Supabase production database`);
    console.log(`   3. Run the SQL file against production`);
    console.log(`\n   Example using psql:`);
    console.log(`   psql "YOUR_SUPABASE_CONNECTION_STRING" -f scripts/production-migration.sql`);
    
  } catch (error) {
    console.error('❌ Export failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

exportData().catch(console.error);
