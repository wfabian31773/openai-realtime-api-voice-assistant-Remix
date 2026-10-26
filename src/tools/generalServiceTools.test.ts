import { describe, it, expect, afterEach } from 'vitest';
import './generalServiceTools';
import './handoffBroker';
import {
  registerCallHandoff,
  registeredHandoffCount,
  releaseCallHandoff,
} from './handoffBroker';
import { runTool } from './registry';
import { escalationDetailsMap } from '../services/escalationStore';

afterEach(() => {
  escalationDetailsMap.clear();
});

describe('request_human_handoff', () => {
  it('refuses plainly when this call has no transfer, so the agent files a ticket instead', async () => {
    const out = await runTool('request_human_handoff', {
      call_sid: 'CA-none',
      reason: 'urgent symptom',
      caller_type: 'patient_urgent',
    });
    expect(out.success).toBe(false);
    expect(String((out as { error: string }).error)).toContain('transfer_unavailable');
    // The refusal tells the model what to DO, not just what failed.
    expect(String((out as { error: string }).error)).toContain('ticket');
  });

  it('writes the same escalation side channel the SIP escalate tools write, then transfers', async () => {
    let seenAtDialTime: unknown;
    registerCallHandoff('CA-x', async () => {
      // What the destination policy will read, captured at the moment the
      // transfer actually runs.
      seenAtDialTime = { ...escalationDetailsMap.get('CA-x') };
    });
    const out = await runTool('request_human_handoff', {
      call_sid: 'CA-x',
      reason: 'sudden vision loss',
      caller_type: 'patient_urgent_medical',
      caller_requested_human: 'true',
    });
    expect(out).toMatchObject({ success: true, transferred: true });
    expect(seenAtDialTime).toMatchObject({
      callerType: 'patient_urgent_medical',
      reason: 'sudden vision loss',
      callerRequestedHuman: true,
    });
    // Used once: the entry and the escalation are both gone.
    expect(registeredHandoffCount()).toBe(0);
    expect(escalationDetailsMap.has('CA-x')).toBe(false);
  });

  it('reports a failed transfer as NOT transferred, never as success', async () => {
    registerCallHandoff('CA-y', async () => {
      throw new Error('handoff_failed:NO_ANSWER');
    });
    const out = await runTool('request_human_handoff', {
      call_sid: 'CA-y',
      reason: 'urgent',
      caller_type: 'patient_urgent',
    });
    expect(out.success).toBe(false);
    const failure = out as { error: string; retryable?: boolean };
    // The 2026-08-04 failure shape: "transferring you now" with nobody
    // dialled. The error text forbids exactly that.
    expect(failure.error).toContain('NOT transferred');
    expect(failure.retryable).toBe(true);
    releaseCallHandoff('CA-y');
    escalationDetailsMap.delete('CA-y');
  });

  it('refuses without a reason or caller type — the office must hear why', async () => {
    const out = await runTool('request_human_handoff', { call_sid: 'CA-z' });
    expect(out.success).toBe(false);
  });

  it('caps the broker so an eviction-free path cannot grow it forever', () => {
    for (let i = 0; i < 250; i += 1) {
      registerCallHandoff(`CA-cap-${i}`, async () => undefined);
    }
    expect(registeredHandoffCount()).toBeLessThanOrEqual(200);
    for (let i = 0; i < 250; i += 1) releaseCallHandoff(`CA-cap-${i}`);
  });
});

describe('classify_request (registry edition)', () => {
  it('classifies a plain refill to Clinical Tech Support, the documented control case', async () => {
    // queue-agents.md: "a plain refill (expect dept 3 / reason 155 / high)".
    const out = await runTool('classify_request', {
      request_description: 'I need a refill of my glaucoma drops, I ran out yesterday',
    });
    expect(out).toMatchObject({ success: true, departmentId: 3 });
    const shaped = out as Record<string, unknown>;
    expect(typeof shaped.requestTypeId).toBe('number');
    expect(typeof shaped.requestReasonId).toBe('number');
  });

  it('refuses an empty description instead of classifying nothing', async () => {
    const out = await runTool('classify_request', { request_description: '  ' });
    expect(out.success).toBe(false);
  });
});

describe('lookup_schedule (registry edition)', () => {
  it('refuses without a phone or a full name and date of birth', async () => {
    const out = await runTool('lookup_schedule', { first_name: 'Wayne' });
    expect(out.success).toBe(false);
    const refusal = out as { missingFields?: string[]; message?: string };
    expect(refusal.missingFields).toContain('date_of_birth');
    // The sentence is for a caller's ears, not a field name recital.
    expect(refusal.message).toMatch(/phone number|date of birth/);
  });
});

describe('create_ticket (registry edition)', () => {
  it('refuses with the missing fields before touching the ticketing system', async () => {
    const out = await runTool('create_ticket', {
      departmentId: 3,
      requestTypeId: 10,
      requestReasonId: 155,
      description: 'refill',
    });
    expect(out.success).toBe(false);
    const refusal = out as { missingFields?: string[] };
    expect(refusal.missingFields).toEqual(
      expect.arrayContaining(['patientFirstName', 'patientLastName', 'patientPhone']),
    );
  });
});
