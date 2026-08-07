import { describe, it, expect, beforeAll } from 'vitest';

// callGradingService's import chain reaches environment validation — feed it
// harmless values BEFORE the dynamic import so the suite runs anywhere.
let svc: { runDeterministicGraders: (i: unknown) => Array<{ grader: string; pass: boolean; score: number; reason: string; severity?: string }> };

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
  process.env.OPENAI_API_KEY ||= 'test-key';
  const mod = await import('./callGradingService');
  svc = Object.create(mod.CallGradingService.prototype);
});

const base = {
  callLogId: 'test',
  transferredToHuman: false,
  ticketNumber: null as string | null,
  totalTurns: 6,
  interruptionCount: 0,
  truncationCount: 0,
  toolCallCount: 0,
  durationSeconds: 120,
};

function grade(transcript: string, agentSlug: string, extra: Record<string, unknown> = {}) {
  const results = svc.runDeterministicGraders({ ...base, ...extra, transcript, agentSlug });
  return results.find((r) => r.grader === 'human_request_deflection')!;
}

const askTwice = (agentLine: string) =>
  `AGENT: Thank you for calling Azul Vision.\nCALLER: I want to speak to a person\nAGENT: ${agentLine}\nCALLER: give me a human please\nAGENT: ${agentLine}`;

describe('human_request_deflection — capability matrix (ticket-only lines)', () => {
  it('passes the answering service when it offers the busy-team message script', () => {
    const r = grade(
      askTwice('All of our agents are currently busy at the moment — I can take a message and have the team contact you as soon as they become available.'),
      'answering-service',
    );
    expect(r.pass).toBe(true);
  });

  it('passes with full score when a ticket was actually filed', () => {
    const r = grade(askTwice('I can take a message for the team.'), 'answering-service', { ticketNumber: 'T-123' });
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1.0);
  });

  it('fails critically when the ticket-only line promises a transfer', () => {
    const r = grade(askTwice('Of course, one moment while I connect you to our team.'), 'answering-service');
    expect(r.pass).toBe(false);
    expect(r.severity).toBe('critical');
    expect(r.reason).toContain('PROMISED A TRANSFER');
  });

  it('fails critically when it neither offers a message nor files a ticket', () => {
    const r = grade(askTwice('I understand your frustration, is there anything else?'), 'answering-service');
    expect(r.pass).toBe(false);
    expect(r.severity).toBe('critical');
  });

  it('still requires transfer-or-ticket on transfer-capable lines', () => {
    const r = grade(askTwice('I can usually help faster — may I ask what it is regarding?'), 'azul-scheduling');
    expect(r.pass).toBe(false);
  });
});

describe('language_config_fault — CP-8', () => {
  const langGrade = (transcript: string) =>
    svc.runDeterministicGraders({ ...base, transcript, agentSlug: 'answering-service' }).find((r) => r.grader === 'language_config_fault')!;

  it('flags a language refusal as a critical config fault', () => {
    const r = langGrade('CALLER: en español por favor\nAGENT: I can only speak English on this line.');
    expect(r.pass).toBe(false);
    expect(r.severity).toBe('critical');
  });

  it('passes normal bilingual handling', () => {
    const r = langGrade('CALLER: en español por favor\nAGENT: Claro que sí, con gusto le ayudo en español.');
    expect(r.pass).toBe(true);
  });
});
