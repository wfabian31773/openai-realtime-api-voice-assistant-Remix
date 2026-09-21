/**
 * WHY NO DIAL WENT OUT, ON THE TICKET — the Remix half of task #149.
 *
 * The ticketing app refuses a `CREATE_TASK` on a purpose whose default is
 * `HAND_OFF` unless the payload explains itself, and until ticketing-app #291
 * that refusal was a bare HTTP 500 the model read as retryable. Measured in
 * `voice_agent_api_logs` on 2026-09-19: 7 calls, 41 refused POSTs, worst storm
 * 8 on one call, 2026-09-15..18 — and 4 of the 7 never attempted a handoff at
 * all, which is the shape neither of the app's first two enum values named.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAILURE MODE 10 IS THE HAZARD HERE AND IT IS ADDRESSED EXPLICITLY.
 *
 * A suite that only drives `handoffNotAttemptedReason` proves the function and
 * not that anything calls it, and v20 is the worked example: both ENDS of the
 * blind-transfer method flag had tests, the two links BETWEEN them had none,
 * and the live behaviour could revert with every test green. Four links:
 *
 *   1. `handoffNotAttemptedReason` maps the facts onto a reason.
 *   2. `buildPayload` CALLS it, from the policy table and the director.
 *   3. `handoff_to_pcp`'s ineligible branch LATCHES `not_eligible`.
 *   4. `handoff_to_pcp`'s decline branch LATCHES `caller_declined_queue`.
 *
 * Links 2, 3 and 4 are pinned by reading the source — the device
 * `ticketRequirements.test.ts` and `queueDialReachesTheTicket.test.ts` already
 * use, because `buildPayload` is module-private and the two latch sites sit
 * inside a live dial path no unit test reaches without standing up Twilio.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PCP_HANDOFF_NOT_ATTEMPTED_REASONS,
  defaultDispositionFor,
  handoffNotAttemptedReason,
} from './handoffNotAttempted';
import { PCP_CALL_PURPOSES, PCP_CALL_PURPOSE_SLUGS } from './policy';
import { PcpTicketPayloadSchema } from './pcpTicketing';
import { pcpDirector } from './director';

const HANDOFF_PURPOSE = 'peer_to_peer';
const TASK_PURPOSE = 'notify_referral_approval';

function facts(over: Partial<Parameters<typeof handoffNotAttemptedReason>[0]> = {}) {
  return {
    purposeDefaultDisposition: 'HAND_OFF' as const,
    disposition: 'CREATE_TASK' as const,
    ...over,
  };
}

describe('the reason a handoff was not attempted', () => {
  it('is absent on a purpose that never defaults to a handoff', () => {
    // A purpose that already defaults to CREATE_TASK has no dial to explain,
    // so a reason on it would answer a question nobody asked.
    expect(handoffNotAttemptedReason(facts({ purposeDefaultDisposition: 'CREATE_TASK' })))
      .toBeUndefined();
    expect(handoffNotAttemptedReason(facts({ purposeDefaultDisposition: 'AUTOMATE' })))
      .toBeUndefined();
  });

  it('is absent when the ticket IS a handoff', () => {
    // A ticket filed as HAND_OFF is a dial, not the absence of one.
    expect(handoffNotAttemptedReason(facts({ disposition: 'HAND_OFF' }))).toBeUndefined();
  });

  it('names the caller declining the queue, which outranks everything else', () => {
    // They were warned, offered the queue and said no. That is the most
    // authoritative fact available and it holds even where the agent had
    // ALSO been refused as ineligible earlier in the call.
    expect(handoffNotAttemptedReason(facts({ callerDeclinedTheQueue: true })))
      .toBe('caller_declined_queue');
    expect(handoffNotAttemptedReason(facts({
      callerDeclinedTheQueue: true,
      handoffRefusedAsIneligible: true,
      callerRequestedHuman: true,
    }))).toBe('caller_declined_queue');
  });

  it('names an ineligible handoff the agent actually asked for', () => {
    expect(handoffNotAttemptedReason(facts({ handoffRefusedAsIneligible: true })))
      .toBe('not_eligible');
    // Still not_eligible when the caller DID ask — the ask is why the agent
    // tried, and the refusal is why nothing was dialled.
    expect(handoffNotAttemptedReason(facts({
      handoffRefusedAsIneligible: true,
      callerRequestedHuman: true,
    }))).toBe('not_eligible');
  });

  it('names the common case: nobody asked for a person', () => {
    // 4 of the 7 refused calls. The operator's own default rule, 2026-09-04:
    // never auto-transfer; transfer only when the caller ASKS and is an entity.
    expect(handoffNotAttemptedReason(facts())).toBe('not_requested');
  });

  /**
   * `undefined` IS AN ANSWER, NOT A GAP. A caller who asked for a person, was
   * never refused and never declined, whose request is filed as a task, IS a
   * lost transfer. Nothing is sent, the app refuses, and after ticketing-app
   * #291 that refusal is a 422 with the server's own words and
   * `retryable: false` rather than a storm. `sweepPcpUnfiledCall` admits a
   * caller whose explicit ask went unhonoured (v19), so the request survives.
   */
  it('sends NOTHING when the caller asked and nothing stopped the dial', () => {
    expect(handoffNotAttemptedReason(facts({ callerRequestedHuman: true }))).toBeUndefined();
  });
});

describe('reading the purpose default without throwing', () => {
  /**
   * THIS IS LOAD-BEARING RATHER THAN TIDINESS. `getPcpCallPurpose` THROWS on an
   * unknown slug, and `buildPayload` — which this feeds — is called from eight
   * places including the teardown sweep at `pcpAgent.ts:2931`, the
   * lost-request floor itself. A throw there would lose exactly the request
   * the floor exists to save: the v18 shape arriving through a change written
   * to stop it.
   */
  it('answers undefined for an absent or unknown slug instead of throwing', () => {
    expect(() => defaultDispositionFor(undefined)).not.toThrow();
    expect(defaultDispositionFor(undefined)).toBeUndefined();
    expect(defaultDispositionFor('')).toBeUndefined();
    expect(defaultDispositionFor('a_slug_the_table_has_never_heard_of')).toBeUndefined();
  });

  it('answers the real default for every slug the table declares', () => {
    for (const slug of PCP_CALL_PURPOSE_SLUGS) {
      const declared = PCP_CALL_PURPOSES.find((p) => p.slug === slug)!;
      expect(defaultDispositionFor(slug), slug).toBe(declared.defaultDisposition);
    }
  });

  it('still finds the two purposes this whole change is about', () => {
    // If either of these stops defaulting to HAND_OFF the app's guard no longer
    // fires on it, and this change becomes inert rather than wrong — which is
    // worth a red test either way, because the PR's own numbers name them.
    expect(defaultDispositionFor('peer_to_peer')).toBe('HAND_OFF');
    expect(defaultDispositionFor('health_plan_visit_inquiry')).toBe('HAND_OFF');
  });
});

describe('the payload carries it', () => {
  const base = {
    callSid: 'CA00000000000000000000000000000149',
    agentSlug: 'pcp' as const,
    agentVersion: 'test',
    callerName: 'A Caller',
    callPurpose: HANDOFF_PURPOSE,
    narrative: 'A request.',
  };

  it('accepts every reason the app declares', () => {
    for (const reason of PCP_HANDOFF_NOT_ATTEMPTED_REASONS) {
      const parsed = PcpTicketPayloadSchema.safeParse({
        ...base, disposition: 'CREATE_TASK', handoffNotAttemptedReason: reason,
      });
      expect(parsed.success, reason).toBe(true);
    }
  });

  it('refuses a reason the app would not recognise', () => {
    // The app's schema is `.strict()` with its own enum. A value this side
    // invents is an HTTP 400 there, which is how 17 requests became nothing on
    // 2026-09-14 — so it must fail HERE, before the wire.
    expect(PcpTicketPayloadSchema.safeParse({
      ...base, disposition: 'CREATE_TASK', handoffNotAttemptedReason: 'because_i_said_so',
    }).success).toBe(false);
  });

  it('is optional, so every payload that filed before still files', () => {
    expect(PcpTicketPayloadSchema.safeParse({
      ...base, callPurpose: TASK_PURPOSE, disposition: 'CREATE_TASK',
    }).success).toBe(true);
  });
});

describe('the director owns the two latches, not the model', () => {
  it('latches the decline, and it does not un-latch', () => {
    const callId = 'latch-decline-149';
    pcpDirector.clear(callId);
    expect(pcpDirector.get(callId).callerDeclinedTheQueue).toBeFalsy();
    pcpDirector.markCallerDeclinedTheQueue(callId);
    expect(pcpDirector.get(callId).callerDeclinedTheQueue).toBe(true);
    // A reversible setter for a DIFFERENT fact must not clear this one: that is
    // the distinction between "the caller said no" and "the dial failed".
    pcpDirector.setCallerChoseTheQueue(callId, true);
    expect(pcpDirector.get(callId).callerDeclinedTheQueue).toBe(true);
    pcpDirector.clear(callId);
  });

  it('latches an ineligible handoff', () => {
    const callId = 'latch-ineligible-149';
    pcpDirector.clear(callId);
    expect(pcpDirector.get(callId).handoffRefusedAsIneligible).toBeFalsy();
    pcpDirector.markHandoffRefusedAsIneligible(callId);
    expect(pcpDirector.get(callId).handoffRefusedAsIneligible).toBe(true);
    pcpDirector.clear(callId);
  });

  it('exposes neither as a tool argument anywhere', () => {
    // The v17 P1: a guard that read `create_pcp_task`'s `disposition` was
    // reading a MODEL argument with `.default('CREATE_TASK')` behind it, so the
    // model could satisfy it by accident. Neither of these may become one.
    const agent = readFileSync(join(process.cwd(), 'src/agents/pcpAgent.ts'), 'utf8');
    const schemas = agent.match(/parameters:\s*z\.object\(\{[\s\S]*?\n {4}\}\)/g) ?? [];
    expect(schemas.length).toBeGreaterThan(3);
    for (const schema of schemas) {
      expect(schema).not.toMatch(/handoffNotAttemptedReason/);
      expect(schema).not.toMatch(/callerDeclinedTheQueue/);
      expect(schema).not.toMatch(/handoffRefusedAsIneligible/);
    }
  });
});

describe('the agent is wired to all of it', () => {
  const agent = readFileSync(join(process.cwd(), 'src/agents/pcpAgent.ts'), 'utf8');

  it('builds the reason inside buildPayload, from the table and the director', () => {
    const body = agent.slice(agent.indexOf('function buildPayload('));
    const payload = body.slice(0, body.indexOf('\n}\n'));
    expect(payload).toMatch(/handoffNotAttemptedReason:\s*handoffNotAttemptedReason\(\{/);
    // From the policy table, NEVER from a model argument.
    expect(payload).toMatch(/purposeDefaultDisposition:\s*defaultDispositionFor\(state\.callPurpose\)/);
    expect(payload).toMatch(/callerDeclinedTheQueue:\s*state\.callerDeclinedTheQueue/);
    expect(payload).toMatch(/handoffRefusedAsIneligible:\s*state\.handoffRefusedAsIneligible/);
    expect(payload).toMatch(/callerRequestedHuman:\s*state\.callerRequestedHuman/);
  });

  it('latches not_eligible BEFORE the fallback payload is built', () => {
    // Ordering is the property: `buildPayload` reads the latch, so a mark
    // placed after the submit would file the very ticket it was meant to
    // explain without the explanation.
    const branch = agent.slice(agent.indexOf('if (!pcpDirector.next(callId).handoffEligible) {'));
    const upToSubmit = branch.slice(0, branch.indexOf('submitPcpTicket('));
    expect(upToSubmit).toMatch(/pcpDirector\.markHandoffRefusedAsIneligible\(callId\)/);
  });

  it('latches the decline on the declined branch', () => {
    const branch = agent.slice(agent.indexOf("if (choice === 'declined') {"));
    const untilReturn = branch.slice(0, branch.indexOf("return refusePcp('queue_choice_declined')"));
    expect(untilReturn).toMatch(/pcpDirector\.markCallerDeclinedTheQueue\(callId\)/);
  });
});
