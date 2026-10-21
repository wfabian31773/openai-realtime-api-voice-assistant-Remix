/**
 * The NPX outreach lane (v109) as the runtime resolves it, through the REAL
 * lane and agent registries (failure mode 10), plus its pilot levers.
 * Synthetic patient and ids only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgres://stub:stub@ci-stub.invalid:5432/stub';
});

import { resolveLane, RUNTIME_CALLBACK_TOOLS, RUNTIME_OUTBOUND_TOOLS, type LaneConfig } from '../runtime/laneRegistry';
import type { ContactSource, OutboundContact, SourceContact } from '../runtime/outbound/campaign';
import type { CallbackContext } from '../runtime/outbound/callback';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import { NPX_OUTREACH_TOOLS, CONFIRM_DOB_TOOL_NAME, setNpxOutreachDepsForTests, resetOutreachSessionsForTests } from '../tools/npxOutreachTools';
import { npxOutreachPolicy, pilotSource } from './npxOutreachAgent';
import { outboundProofPolicy } from './outboundProofAgent';

const DATA = {
  appointment_id: 'appt-0001',
  person_id: 'person-0001',
  date_of_birth: '1950-01-02',
  appointment_date: '2041-03-20',
  begin_time: '0900',
  office: 'Test Office',
  medical_group: 'Test Group CAP',
  partners: ['Partner One Optometry'],
};
const CONTACT: OutboundContact = {
  contactId: 'c1',
  campaignId: 'campaign-1',
  attemptId: 'a1',
  phone: '+15555550111',
  firstName: 'Testa',
  lastName: 'Synthetic',
  data: DATA,
};
const META = {
  callSid: 'CA00000000000000000000000000000209',
  callId: 'CA00000000000000000000000000000209',
  callerPhone: '+15555550111',
  dialedNumber: '+15555550100',
};

async function registry() {
  const { agentRegistry } = await import('../config/agents');
  return agentRegistry as unknown as { getAgentConfig(id: string): LaneConfig | undefined };
}
type BoundTool = { name?: string };
const names = (tools: unknown) => (tools as BoundTool[]).map((t) => t.name);

afterEach(() => {
  setNpxOutreachDepsForTests(null);
  resetOutreachSessionsForTests();
});

describe('the lane as the runtime resolves it', () => {
  it('binds the outreach tools beside opt-out, outcome and hangup on a dialled call', async () => {
    const lane = await resolveLane('npx-outreach', { ...META, outbound: { ...CONTACT, campaignKey: 'npx-outreach' } }, { source: await registry(), env: {} });
    const bound = names(lane!.agent.tools);
    for (const t of [...RUNTIME_OUTBOUND_TOOLS, ...NPX_OUTREACH_TOOLS]) expect(bound).toContain(t);
  });

  it('binds them on a returned call too, beside identify_callback_caller', async () => {
    const callback: CallbackContext = {
      campaignKey: 'npx-outreach',
      campaignId: 'campaign-1',
      callerPhone: '+15555550111',
      match: { kind: 'none' },
      purpose: npxOutreachPolicy.callbackPurpose!,
    };
    const lane = await resolveLane('npx-outreach', { ...META, callback }, { source: await registry(), env: {} });
    const bound = names(lane!.agent.tools);
    for (const t of [...RUNTIME_CALLBACK_TOOLS, ...NPX_OUTREACH_TOOLS]) expect(bound).toContain(t);
  });

  it('never on the proving lane, nor on an inbound lane', async () => {
    const proof = await resolveLane('outbound-proof', { ...META, outbound: { ...CONTACT, campaignKey: 'outbound-proof' } }, { source: await registry(), env: {} });
    const optical = await resolveLane('optical', META, { source: await registry(), env: {} });
    for (const t of NPX_OUTREACH_TOOLS) {
      expect(names(proof!.agent.tools)).not.toContain(t);
      expect(names(optical!.agent.tools)).not.toContain(t);
    }
  });

  it('injects the contact, attempt and CallSid, so a bound tool finds the record without asking for it', async () => {
    const store = new FakeOutboundStore();
    store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling', firstName: 'Testa', lastName: 'Synthetic', customData: { ...DATA } });
    const attemptId = await store.startAttempt('c1', store.campaignId, 1);
    setNpxOutreachDepsForTests({ store: async () => store });
    const lane = await resolveLane('npx-outreach', { ...META, outbound: { ...CONTACT, attemptId, campaignKey: 'npx-outreach' } }, { source: await registry(), env: {} });
    // The runtime's own dispatch path: the model sends only the date it heard.
    const out = await (lane!.agent as unknown as { dispatch(n: string, a: object): Promise<{ output: string }> }).dispatch(
      CONFIRM_DOB_TOOL_NAME,
      { date_of_birth: '01/02/1950' },
    );
    expect(JSON.parse(out.output)).toMatchObject({ success: true, verified: true });
  });

  it('the prompt carries nothing from the record: no appointment, no office, no date of birth', async () => {
    const lane = await resolveLane('npx-outreach', { ...META, outbound: { ...CONTACT, campaignKey: 'npx-outreach' } }, { source: await registry(), env: {} });
    const prompt = String(lane!.agent.instructions);
    for (const leak of ['2041', 'March', 'Test Office', '1950', 'Test Group', 'Partner One']) expect(prompt).not.toContain(leak);
    expect(prompt).toMatch(/Until it answers verified you know nothing about their appointments/);
  });
});

describe('the policy', () => {
  it('dials only behind its own switch and its own caller ID, never the proving lane\'s', () => {
    expect(npxOutreachPolicy.enableEnv).toBe('OUTBOUND_CAMPAIGN_NPX_OUTREACH');
    expect(npxOutreachPolicy.callerIdEnv).not.toBe(outboundProofPolicy.callerIdEnv);
    expect(npxOutreachPolicy.tools).toEqual(NPX_OUTREACH_TOOLS);
    expect(npxOutreachPolicy.caps).toMatchObject({ perDay: 1, perWeek: 3, total: 3 });
  });

  it('its voicemail and its returned-call line say nothing about an appointment', () => {
    expect(npxOutreachPolicy.voicemail()).not.toMatch(/appointment|exam|eye|sooner|partner/i);
    expect(npxOutreachPolicy.callbackPurpose).not.toMatch(/appointment|exam|eye|sooner|partner/i);
  });
});

describe('the pilot levers', () => {
  const row = (ref: string, group: string): SourceContact => ({ externalRef: ref, phone: '+15555550111', firstName: 'T', lastName: 'S', data: { medical_group: group } });
  const base: ContactSource = {
    name: 'test',
    refreshEveryMs: 1,
    parkMs: 1,
    list: async () => [row('a', 'Regal CAP'), row('b', 'Lakeside CAP'), row('c', 'regal cap'), row('d', 'Regal CAP')],
    recheck: async () => ({ state: 'off_list' }),
  };
  const refs = async (env: Record<string, string>) => (await pilotSource(base, env).list(new Date())).map((c) => c.externalRef);

  it('passes everything through when unset', async () => {
    expect(await refs({})).toEqual(['a', 'b', 'c', 'd']);
  });
  it('keeps only the named medical groups, ignoring case', async () => {
    expect(await refs({ NPX_OUTREACH_GROUPS: 'Regal CAP' })).toEqual(['a', 'c', 'd']);
    expect(await refs({ NPX_OUTREACH_GROUPS: ' lakeside cap , regal cap ' })).toEqual(['a', 'b', 'c', 'd']);
  });
  it('caps how many are queued, earliest first, and ignores a limit that is not a positive whole number', async () => {
    expect(await refs({ NPX_OUTREACH_GROUPS: 'Regal CAP', NPX_OUTREACH_LIMIT: '2' })).toEqual(['a', 'c']);
    expect(await refs({ NPX_OUTREACH_LIMIT: '0' })).toEqual(['a', 'b', 'c', 'd']);
    expect(await refs({ NPX_OUTREACH_LIMIT: 'ten' })).toEqual(['a', 'b', 'c', 'd']);
  });
  it('leaves the dial-time re-check alone', () => {
    expect(pilotSource(base, { NPX_OUTREACH_LIMIT: '1' }).recheck).toBe(base.recheck);
  });
});
