/**
 * CA1de3229a AND CAbd89b226, DRIVEN THROUGH THE REAL AGENT.
 *
 * The two calls behind this change, replayed as tool sequences rather than as
 * unit assertions on the director — because both defects lived in the gap
 * BETWEEN the director and what the model was handed, and a director-level
 * test cannot see that gap.
 *
 *   1de3229a  a referring coordinator from Dr. Chen's office. 188 seconds, no
 *             transfer, and the agent said goodbye three times because
 *             terminate_call refused four times without ever saying why.
 *   bd89b226  the last call this line took: a patient asking about her serum
 *             drops, asked "What is your role at Optum Clinic?"
 *
 * Both start the same way — the agent reaches for a tool before the purpose is
 * recorded, because the purpose was the last thing the intake collected.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');

/** The SDK hands tools `(context, argsJson)` and may return an object or a
 *  JSON string depending on version — normalise both. */
async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshAgent() {
  const callId = `CAgate${++n}`;
  // Never connects — the handoff path under test is the one that never got
  // as far as dialling.
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }), { callId });
  return { agent, callId };
}

describe('a refused gate now tells the agent what to do', () => {
  it('terminate_call — the refusal that produced three goodbyes', () => {
    const { agent } = freshAgent();
    return call(agent, 'terminate_call', { reason: 'completed' }).then((r) => {
      expect(r.success).toBe(false);
      expect(r.error).toBe('durable_disposition_required');
      // The whole point: it no longer arrives bare.
      expect(r.guidance).toBeTruthy();
      expect(r.guidance).toMatch(/do NOT say goodbye again/);
      expect(r.guidance).toMatch(/create_pcp_task/);
      // Nothing for the caller — they should not learn this happened.
      expect(r.say).toBeUndefined();
    });
  });

  it('handoff_to_pcp — the 88% refusal', async () => {
    const { agent } = freshAgent();
    // A narrative that does NOT ask for a person, so the purpose gate is what
    // trips. This is the shape that failed 180 times on 2026-08-07.
    const r = await call(agent, 'handoff_to_pcp', {
      narrative: 'Referral coordinator calling about a mutual patient.',
      urgency: 'normal',
    });
    expect(r.error).toBe('call_purpose_required');
    expect(r.guidance).toMatch(/record_pcp_intake/);
    expect(r.guidance).toMatch(/callPurpose/);
    // And it must not send the agent back to a caller who already answered.
    expect(r.guidance).toMatch(/do NOT ask them again/);
  });

  it('create_pcp_task and lookup_patient_appointments refuse the same way', async () => {
    const { agent } = freshAgent();
    const task = await call(agent, 'create_pcp_task', { narrative: 'x', urgency: 'normal' });
    expect(task.error).toBe('call_purpose_required');
    expect(task.guidance).toBeTruthy();

    const lookup = await call(agent, 'lookup_patient_appointments', {
      patientFirstName: 'Wayne',
      patientLastName: 'Fabian',
      patientDob: '1973-03-17',
    });
    expect(lookup.error).toBe('call_purpose_required');
    expect(lookup.guidance).toBeTruthy();
  });

  it('every refusal any PCP tool can produce carries guidance', async () => {
    // The sweep: whatever each tool objects to on an empty call, it must not
    // object silently.
    const { agent } = freshAgent();
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['terminate_call', { reason: 'completed' }],
      ['handoff_to_pcp', { narrative: 'about a patient', urgency: 'normal' }],
      ['create_pcp_task', { narrative: 'x', urgency: 'normal' }],
      ['record_automated_resolution', { narrative: 'x' }],
      ['get_public_practice_information', { topic: 'location' }],
      ['lookup_patient_appointments', { patientFirstName: 'A', patientLastName: 'B', patientDob: '1990-01-01' }],
    ];
    for (const [name, args] of attempts) {
      const r = await call(agent, name, args);
      if (r?.success === false) {
        expect(r.guidance, `${name} refused with no guidance`).toBeTruthy();
      }
    }
  });
});

describe('the purpose is asked first, so the gates stop tripping', () => {
  it('an empty call is asked what it is about, not for a name', async () => {
    const { agent } = freshAgent();
    const r = await call(agent, 'record_pcp_intake', {});
    expect(r.nextQuestion?.field).toBe('callPurpose');
  });

  it('recording the purpose first unblocks the tools that were refusing', async () => {
    const { agent, callId } = freshAgent();
    await call(agent, 'record_pcp_intake', { callPurpose: 'peer_to_peer' });
    expect(pcpDirector.get(callId).callPurpose).toBe('peer_to_peer');

    // The same call that returned call_purpose_required above now gets past
    // that gate. It may still refuse for a DIFFERENT reason (nothing has been
    // filed yet), which is correct — it must simply not be this one.
    const r = await call(agent, 'create_pcp_task', { narrative: 'Peer to peer request', urgency: 'normal' });
    expect(r.error).not.toBe('call_purpose_required');
  });

  /**
   * bd89b226. She said "I'm a patient" and was asked for her role anyway,
   * because the director could not classify her until the purpose was in — and
   * the purpose was the last field it asked for.
   */
  it('a patient is never asked for a role, an organization or a facility type', async () => {
    const { agent } = freshAgent();
    let next = (await call(agent, 'record_pcp_intake', { callPurpose: 'patient_caller' })).nextQuestion?.field;
    const asked: string[] = [];
    const answer: Record<string, unknown> = {
      callerName: 'Bernice Capuano',
      callbackNumber: '+16265550857',
    };
    for (let i = 0; i < 8 && next; i++) {
      asked.push(next);
      const r = await call(agent, 'record_pcp_intake', { [next]: answer[next] ?? 'provided' });
      next = r.nextQuestion?.field;
    }
    for (const professionalOnly of ['callerRole', 'callerOrganization', 'callerFacilityType']) {
      expect(asked, `a patient was asked for ${professionalOnly}`).not.toContain(professionalOnly);
    }
    expect(asked).toContain('callerName');
  });
});
