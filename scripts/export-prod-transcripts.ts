import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

interface CallLog {
  id: string;
  callSid: string;
  direction: string;
  status: string;
  agentId: string;
  agentUsed: string;
  from: string;
  to: string;
  duration: number;
  createdAt: Date;
  endTime: Date;
  transcript: string;
  summary: string;
  ticketNumber: string;
  callDisposition: string;
  agentOutcome: string;
  transferredToHuman: boolean;
}

function loadEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  
  if (!fs.existsSync(envPath)) {
    console.error('ERROR: .env file not found. Copy .env.production.example to .env and fill in SUPABASE_URL');
    process.exit(1);
  }
  
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const envVars: Record<string, string> = {};
  
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    envVars[key] = value;
  }
  
  return envVars;
}

function redactPHI(text: string): string {
  if (!text) return '';
  
  let redacted = text;
  
  redacted = redacted.replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]');
  redacted = redacted.replace(/\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g, '[PHONE]');
  
  redacted = redacted.replace(/\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](\d{2}|\d{4})\b/g, '[DOB]');
  redacted = redacted.replace(/\b(\d{2}|\d{4})[\/\-](0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])\b/g, '[DOB]');
  
  redacted = redacted.replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}\b/gi, '[DOB]');
  redacted = redacted.replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december),?\s*\d{4}\b/gi, '[DOB]');
  
  redacted = redacted.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]');
  
  redacted = redacted.replace(/\b\d{5}(-\d{4})?\b/g, '[ZIP]');
  
  redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
  
  return redacted;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatTranscript(transcript: string): string {
  if (!transcript) return '(No transcript available)';
  
  const redacted = redactPHI(transcript);
  
  const lines = redacted.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    
    if (trimmed.startsWith('[') && trimmed.includes(']:')) {
      return `  ${trimmed}`;
    }
    return `  ${trimmed}`;
  }).filter(Boolean);
  
  return lines.join('\n');
}

async function main() {
  console.log('='.repeat(60));
  console.log('Production Transcript Export Tool');
  console.log('='.repeat(60));
  console.log('');
  
  const envVars = loadEnvFile();
  const supabaseUrl = envVars.SUPABASE_URL;
  
  if (!supabaseUrl) {
    console.error('ERROR: SUPABASE_URL not found in .env file');
    process.exit(1);
  }
  
  console.log('[INFO] Connecting to production database...');
  
  const pool = new Pool({ connectionString: supabaseUrl });
  
  try {
    const result = await pool.query<CallLog>(`
      SELECT 
        id,
        call_sid as "callSid",
        direction,
        status,
        agent_id as "agentId",
        agent_used as "agentUsed",
        "from",
        "to",
        duration,
        created_at as "createdAt",
        end_time as "endTime",
        transcript,
        summary,
        ticket_number as "ticketNumber",
        call_disposition as "callDisposition",
        agent_outcome as "agentOutcome",
        transferred_to_human as "transferredToHuman"
      FROM call_logs
      WHERE transcript IS NOT NULL 
        AND transcript != ''
        AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 50
    `);
    
    console.log(`[INFO] Found ${result.rows.length} calls with transcripts`);
    console.log('[INFO] Applying PHI redaction...');
    console.log('');
    
    const output: string[] = [];
    output.push('='.repeat(80));
    output.push('PRODUCTION CALL TRANSCRIPT ANALYSIS');
    output.push(`Exported: ${new Date().toISOString()}`);
    output.push(`Total Calls: ${result.rows.length}`);
    output.push('NOTE: All PHI has been redacted (phone numbers, DOB, email, SSN, ZIP)');
    output.push('='.repeat(80));
    output.push('');
    
    for (let i = 0; i < result.rows.length; i++) {
      const call = result.rows[i];
      const callNum = i + 1;
      
      output.push('-'.repeat(80));
      output.push(`CALL #${callNum}`);
      output.push('-'.repeat(80));
      output.push(`ID: ${call.id}`);
      output.push(`Agent: ${call.agentUsed || call.agentId || 'Unknown'}`);
      output.push(`Direction: ${call.direction}`);
      output.push(`Duration: ${formatDuration(call.duration || 0)}`);
      output.push(`Date: ${new Date(call.createdAt).toLocaleString()}`);
      output.push(`Status: ${call.status}`);
      output.push(`Disposition: ${call.callDisposition || 'N/A'}`);
      output.push(`Agent Outcome: ${call.agentOutcome || 'N/A'}`);
      output.push(`Transferred: ${call.transferredToHuman ? 'YES' : 'No'}`);
      output.push(`Ticket: ${call.ticketNumber || 'None'}`);
      output.push('');
      
      if (call.summary) {
        output.push('SUMMARY:');
        output.push(redactPHI(call.summary));
        output.push('');
      }
      
      output.push('TRANSCRIPT:');
      output.push(formatTranscript(call.transcript));
      output.push('');
      output.push('');
    }
    
    const outputPath = path.join(process.cwd(), 'transcript-analysis.txt');
    fs.writeFileSync(outputPath, output.join('\n'));
    
    console.log(`[SUCCESS] Exported ${result.rows.length} transcripts to: ${outputPath}`);
    console.log('');
    
    console.log('QUICK STATS:');
    console.log('-'.repeat(40));
    
    const agentCounts: Record<string, number> = {};
    const outcomeCounts: Record<string, number> = {};
    const dispositionCounts: Record<string, number> = {};
    let transferCount = 0;
    let totalDuration = 0;
    
    for (const call of result.rows) {
      const agent = call.agentUsed || call.agentId || 'unknown';
      agentCounts[agent] = (agentCounts[agent] || 0) + 1;
      
      const outcome = call.agentOutcome || 'unclassified';
      outcomeCounts[outcome] = (outcomeCounts[outcome] || 0) + 1;
      
      const disposition = call.callDisposition || 'unclassified';
      dispositionCounts[disposition] = (dispositionCounts[disposition] || 0) + 1;
      
      if (call.transferredToHuman) transferCount++;
      totalDuration += call.duration || 0;
    }
    
    console.log('By Agent:');
    for (const [agent, count] of Object.entries(agentCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${agent}: ${count} calls`);
    }
    
    console.log('');
    console.log('By Agent Outcome:');
    for (const [outcome, count] of Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${outcome}: ${count} calls`);
    }
    
    console.log('');
    console.log('By Disposition:');
    for (const [disposition, count] of Object.entries(dispositionCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${disposition}: ${count} calls`);
    }
    
    console.log('');
    console.log(`Transferred to Human: ${transferCount} (${((transferCount / result.rows.length) * 100).toFixed(1)}%)`);
    console.log(`Avg Duration: ${formatDuration(Math.round(totalDuration / result.rows.length))}`);
    
  } catch (error) {
    console.error('Database error:', error);
  } finally {
    await pool.end();
  }
}

main();
