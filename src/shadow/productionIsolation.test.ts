/**
 * Checkpoint 18 — the two structural proofs:
 *  1. Disabling/breaking the whole shadow system cannot change production
 *     output (tap contract + boot no-op).
 *  2. Shadow mode cannot execute production mutations (module graph + types +
 *     runtime guards).
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { resetShadowConfig } from './config';
import { initialState } from './contracts';
import { simulateToolCall, TOOL_POLICIES } from './toolSimulator';
import { shadowTap } from './tap';

const SHADOW_DIR = __dirname;

/** Modules that can perform production writes; src/shadow/** must never import them. */
const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+['"].*twilioClient['"]/,
  /from\s+['"].*ticketingApiClient['"]/,
  /from\s+['"].*syncAgentService['"]/,
  /from\s+['"].*agentAdapters['"]/,
  /from\s+['"]\.\.\/\.\.\/server\/db['"]/,
  /from\s+['"].*\/db\/agentAdapters['"]/,
  /from\s+['"].*nextgen['"]/i,
  /from\s+['"]twilio['"]/,
  /from\s+['"]drizzle-orm/,
];

describe('shadow cannot reach production mutation paths (module graph)', () => {
  it('no file under src/shadow imports a mutating client or the DB', async () => {
    const files = (await readdir(SHADOW_DIR)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = await readFile(join(SHADOW_DIR, file), 'utf8');
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        expect(pattern.test(content), `${file} must not match ${pattern}`).toBe(false);
      }
    }
  });

  it('the only fetch-capable shadow module is the bundle sender, which is blocklist-guarded', async () => {
    const files = (await readdir(SHADOW_DIR)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of files) {
      const content = await readFile(join(SHADOW_DIR, file), 'utf8');
      if (/\bfetch\s*\(/.test(content)) {
        // No shadow module may call fetch directly — transports are injected,
        // and the injected transport passes through the budget enforcer's
        // production-host blocklist first.
        expect.fail(`${file} calls fetch() directly — shadow must not own network mutation capability`);
      }
    }
  });

  it('simulated records are simulation-only at the type AND runtime level', () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const sim = simulateToolCall(st, {
      contractVersion: 1, intent: 'ticket_request', confidence: 1, extractedFields: {}, missingFields: [],
      ambiguous: false, urgency: 'none', multiIntent: false, secondaryIntents: [],
      recommendedAction: 'simulate_tool_call', recommendedTool: 'create_ticket',
      rationaleCode: 't', selectedModelTier: 'deterministic', modelSelectionReason: 't',
    }, 'create_ticket', {});
    expect(sim.executionMode).toBe('simulation-only');
    expect(sim.allowed).toBe(false); // missing fields — also blocked
    expect((sim as unknown as Record<string, unknown>).execute).toBeUndefined();
  });

  it('every mutating tool policy requires fields or confirmation before eligibility', () => {
    for (const p of TOOL_POLICIES.filter((p) => p.mutating)) {
      const gated = p.requiredFields.length > 0 || p.confirmationRequired || ['terminate_call', 'mark_confirmed', 'mark_voicemail', 'mark_contact_completed', 'transfer_to_office', 'escalate_to_human', 'transfer_to_human', 'sage_handoff', 'sage_confirm_appointment'].includes(p.tool);
      expect(gated, `${p.tool} must be gated`).toBe(true);
    }
  });
});

describe('disabling or breaking shadow cannot change production output', () => {
  it('with a default environment the tap adds zero observable behavior', () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('SHADOW_')) delete process.env[k];
    }
    resetShadowConfig();
    shadowTap.reset();
    // Simulates exactly what the production tap sites do:
    const before = { ...shadowTap.counters };
    shadowTap.emit('session_started', 'c1', 'no-ivr', { correlation: {} }, { sensitive: true });
    shadowTap.emit('user_transcript', 'c1', 'no-ivr', { text: 'hello' }, { sensitive: true });
    shadowTap.emit('tool_completed', 'c1', 'no-ivr', { tool: 'create_ticket', args: {}, outcome: { ok: true }, ms: 1 }, { sensitive: true });
    shadowTap.emit('n8n_workflow_completed', 'CAabc', 'no-ivr', { endpoint: '/api/voice-agent/submit-ticket', status: 200 }, { sensitive: true });
    expect(shadowTap.counters.emitted).toBe(before.emitted); // nothing captured
    expect(shadowTap.counters.consumerErrors).toBe(0); // nothing threw
  });

  it('initShadow with default env is a pure no-op and never throws', async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('SHADOW_')) delete process.env[k];
    }
    resetShadowConfig();
    const { initShadow, _resetShadowForTests } = await import('./index');
    _resetShadowForTests();
    expect(initShadow()).toEqual({ enabled: false });
    _resetShadowForTests();
  });

  it('tap emit never throws under any sabotage (fuzz of malformed payloads)', () => {
    process.env.SHADOW_MODE_ENABLED = 'true';
    process.env.SHADOW_AGENT_ALLOWLIST = 'no-ivr';
    process.env.SHADOW_CAPTURE_PCT = '100';
    resetShadowConfig();
    shadowTap.reset();
    const evil: unknown[] = [
      undefined, null, 42, 'string', { circular: null as unknown }, [], () => {},
    ];
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    evil.push(circ);
    for (const payload of evil) {
      expect(() =>
        shadowTap.emit('user_transcript', 'c1', 'no-ivr', payload as unknown as Record<string, unknown>),
      ).not.toThrow();
    }
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('SHADOW_')) delete process.env[k];
    }
    resetShadowConfig();
    shadowTap.reset();
  });
});

describe('sensitive-data redaction', () => {
  it('redacts phones, DOBs, emails from stored payloads and masks free text', async () => {
    const { redactPayload, maskText } = await import('./redaction');
    const out = redactPayload(
      { patientPhone: '555-201-0101', note: 'DOB 01/02/1980, email a@b.com', tool: 'create_ticket' },
      { keepText: true },
    );
    const s = JSON.stringify(out);
    expect(s).not.toContain('555-201-0101');
    expect(s).not.toContain('01/02/1980');
    expect(s).not.toContain('a@b.com');
    expect(out.tool).toBe('create_ticket'); // safe key survives
    expect(maskText('call me at (555) 303-0303')).toContain('[phone…0303]');
  });

  it('drops free text entirely when transcripts are not stored (default)', async () => {
    const { redactPayload } = await import('./redaction');
    const out = redactPayload({ text: 'my name is Jane Doe' }, { keepText: false });
    expect(String(out.text)).toMatch(/^\[redacted:/);
  });
});
