/**
 * v230: the NPX outreach agent speaks only to the person, and a recording
 * gets the campaign's approved voicemail line and nothing else.
 *
 * The corpus, every connected npx-outreach call to 2026-11-14 (343), read by
 * call SID. Transcripts stay in call_logs; what is here is the SHAPE of each,
 * with a synthetic patient ("Testa").
 *
 *   A RECORDING REACHED THE AGENT (answering-machine detection said human)
 *   on 9 calls. The approved line was left on none of them:
 *     CA6af793b887b8ff452e00228bc6d7e81b  "record your message after the tone" -> wrong_person
 *     CA43c47b3c7777c7eb8151d24b03f80010  the same greeting                    -> wrong_person
 *     CA899dafb133bb6eac16cc6aa6a66803dc  the same greeting                    -> wrong_person
 *     CAa110a6a2c3ad8c45aa3f4d909cc615bd  "at the tone, please record"         -> wrong_person
 *     CA14427c528891598d37bdc713996516c7  "we didn't get your message"         -> call_back_later
 *     CA395b23e0be66c8c957e1b408ee018f81  a screening assistant, then a tone   -> call_back_later
 *     CA8065df916df7f42e6cc43ef364f277b7  a screener's "stay on the line", read the
 *                                         appointment to it, then a tone        -> call_back_later
 *     CA19a4ae410cea254343a577a62128b03e  "we didn't get your message": left its OWN
 *                                         message naming the patient and "your upcoming
 *                                         eye appointment", then "The call has already
 *                                         ended." and "Silence."               -> call_back_later
 *     CAc12d74ed0d7734172964de3a9e2605af  a phone menu ("press 6")             -> max_attempts
 *   wrong_person settles wrong_number, so those four patients are never called
 *   again for a number that was theirs.
 *
 *   STAGE DIRECTIONS AND NARRATION, spoken aloud: "Checking her schedule now."
 *   and "End call." (CA39a3327c7527b15183905230261514dd), "Checking his
 *   schedule now." (CA70f7aaced27e6c1fbb5868059662baec), "Checking that visit
 *   now." (CAd3a50bc71ffd318ab6be29cb9a3aa546), "The call has already ended."
 *   after a goodbye the caller spoke over (CA6a7ffd6bf215505f505c66289c5ddc71);
 *   28 such lines on 19 calls in all.
 *
 *   ANSWERED AS THE PATIENT: the line said the patient's name back as a
 *   question and the agent said "That's me." (CA506ab94be10d346734ccad45415905ff).
 *
 * Code fixes what code can: a `voicemail` outcome that hands the agent the
 * approved line and settles the row as the answer webhook would, and an
 * end_call result that no longer says the call ended. The rest is the prompt,
 * measured offline against the real voice model on the real bound prompt (the
 * PR carries the numbers); the prompt tests here pin that the cases exist and
 * that no stage line is quoted in the prompt for the model to say (the v97
 * lesson).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgres://stub:stub@ci-stub.invalid:5432/stub';
});

import { resolveLane, type LaneConfig } from '../runtime/laneRegistry';
import type { OutboundContact } from '../runtime/outbound/campaign';
import { FakeOutboundStore } from '../runtime/outbound/store.testkit';
import { declaresNothingToSay, guardsAllowedTermination } from '../runtime/mediaStreamBridge';
import {
  END_CALL_RESULT,
  END_CALL_TOOL_NAME,
  OPT_OUT_TOOL_NAME,
  RECORD_OUTCOME_TOOL_NAME,
  setOutboundToolStoreForTests,
  voicemailOutcome,
} from '../tools/outboundTools';
import { getTool } from '../tools/registry';
import { resetOutreachSessionsForTests, setNpxOutreachDepsForTests } from '../tools/npxOutreachTools';
import { NPX_OUTREACH_VOICEMAIL, npxOutreachPolicy } from './npxOutreachAgent';

const SID = 'CA00000000000000000000000000000230';

/** The nine calls a recording reached, and what the build before v230 recorded. */
const RECORDINGS: ReadonlyArray<[sid: string, shape: string, before: string]> = [
  ['CA6af793b887b8ff452e00228bc6d7e81b', 'record your message after the tone', 'wrong_number'],
  ['CA43c47b3c7777c7eb8151d24b03f80010', 'record your message after the tone', 'wrong_number'],
  ['CA899dafb133bb6eac16cc6aa6a66803dc', 'record your message after the tone', 'wrong_number'],
  ['CAa110a6a2c3ad8c45aa3f4d909cc615bd', 'at the tone, please record', 'wrong_number'],
  ['CA14427c528891598d37bdc713996516c7', "we didn't get your message", 'callback_scheduled'],
  ['CA395b23e0be66c8c957e1b408ee018f81', 'a screening assistant, then a tone', 'callback_scheduled'],
  ['CA8065df916df7f42e6cc43ef364f277b7', "a screener's stay on the line, then a tone", 'callback_scheduled'],
  ['CA19a4ae410cea254343a577a62128b03e', "we didn't get your message", 'callback_scheduled'],
  ['CAc12d74ed0d7734172964de3a9e2605af', 'a phone menu', 'max_attempts'],
];

async function registry() {
  const { agentRegistry } = await import('../config/agents');
  return agentRegistry as unknown as { getAgentConfig(id: string): LaneConfig | undefined };
}

type Dispatching = { dispatch(name: string, args: object): Promise<{ output: string }> };

async function dialledLane(store: FakeOutboundStore, attemptId: string) {
  const outbound: OutboundContact & { campaignKey: string } = {
    contactId: 'c1',
    campaignId: store.campaignId,
    attemptId,
    phone: '+15555550111',
    firstName: 'Testa',
    lastName: 'Synthetic',
    data: { appointment_date: '2041-03-20', event_name: 'Dilated Eye Exam' },
    campaignKey: 'npx-outreach',
  };
  const lane = await resolveLane(
    'npx-outreach',
    { callSid: SID, callId: SID, callerPhone: '+15555550111', dialedNumber: '+15555550100', outbound },
    { source: await registry(), env: {} },
  );
  return lane!;
}

function freshStore(): { store: FakeOutboundStore; attemptId: Promise<string> } {
  const store = new FakeOutboundStore();
  store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling' });
  setOutboundToolStoreForTests(store);
  return { store, attemptId: store.startAttempt('c1', store.campaignId, 1) };
}

afterEach(() => {
  setOutboundToolStoreForTests(null);
  setNpxOutreachDepsForTests(null);
  resetOutreachSessionsForTests();
});

describe('a recording the agent reached gets the approved line, through the real lane', () => {
  it.each(RECORDINGS.filter(([, , before]) => before !== 'max_attempts'))(
    '%s (%s): voicemail, not %s, and the approved line to say',
    async () => {
      const { store, attemptId } = freshStore();
      const id = await attemptId;
      const lane = await dialledLane(store, id);
      const started = Date.now();
      const out = JSON.parse(
        (await (lane.agent as unknown as Dispatching).dispatch(RECORD_OUTCOME_TOOL_NAME, { outcome: 'voicemail' })).output,
      );
      expect(out).toMatchObject({ success: true, recorded: 'voicemail', message: NPX_OUTREACH_VOICEMAIL });
      // The line must be said before the hangup, so v56 holds end_call for it.
      expect(declaresNothingToSay(out)).toBe(false);
      const row = store.contacts.get('c1')!;
      expect(row.status).toBe('voicemail');
      // The policy's gap, as the answer webhook would set it, never tomorrow's guess.
      const gapMs = npxOutreachPolicy.caps.minHoursBetween * 60 * 60 * 1000;
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(started + gapMs - 1000);
      expect(row.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + gapMs + 1000);
      // The attempt reads voicemail and is still on the line.
      const attempt = store.attempts.find((a) => a.id === id)!;
      expect(attempt.finish?.status).toBe('voicemail');
      expect(attempt.endedAt).toBeFalsy();
    },
  );

  it.each(RECORDINGS.filter(([, , before]) => before === 'max_attempts'))(
    '%s (%s): a recording on the last attempt settles max_attempts',
    async () => {
      const store = new FakeOutboundStore();
      store.addContact({ id: 'c1', phone: '+15555550111', status: 'calling' });
      setOutboundToolStoreForTests(store);
      // Every earlier attempt the caps allow was spent on this phone; this
      // call is the last one.
      for (let n = 1; n < npxOutreachPolicy.caps.total; n++) await store.startAttempt('c1', store.campaignId, n);
      const lane = await dialledLane(store, await store.startAttempt('c1', store.campaignId, npxOutreachPolicy.caps.total));
      const out = JSON.parse(
        (await (lane.agent as unknown as Dispatching).dispatch(RECORD_OUTCOME_TOOL_NAME, { outcome: 'voicemail' })).output,
      );
      expect(out).toMatchObject({ recorded: 'voicemail', message: NPX_OUTREACH_VOICEMAIL });
      expect(store.contacts.get('c1')!.status).toBe('max_attempts');
    },
  );

  it('the approved line names nobody and says nothing about why we called', () => {
    expect(NPX_OUTREACH_VOICEMAIL).not.toMatch(/Testa|appointment|exam|sooner|partner/i);
  });

  it('an opt-out earlier on the call stands, and nothing more is said', async () => {
    const { store, attemptId } = freshStore();
    const lane = await dialledLane(store, await attemptId);
    const agent = lane.agent as unknown as Dispatching;
    await agent.dispatch(OPT_OUT_TOOL_NAME, {});
    const out = JSON.parse((await agent.dispatch(RECORD_OUTCOME_TOOL_NAME, { outcome: 'voicemail' })).output);
    expect(out).toMatchObject({ success: true, recorded: 'already_settled', nothing_to_say: true });
    expect(out.message).toBeUndefined();
    expect(store.contacts.get('c1')!.status).toBe('do_not_call');
  });

  it('a call with no line to leave leaves none', () => {
    const out = voicemailOutcome(null) as Record<string, unknown>;
    expect(out.message).toBeUndefined();
    expect(declaresNothingToSay(out)).toBe(true);
  });

  it('a call with no gap or cap injected (an operator call) is not scheduled again', async () => {
    const { store, attemptId } = freshStore();
    await attemptId;
    const out = await getTool(RECORD_OUTCOME_TOOL_NAME)!.handler({
      outbound_contact_id: 'c1',
      outbound_phone: '+15555550111',
      outbound_campaign: 'operator',
      outbound_voicemail_line: 'A test line.',
      outcome: 'voicemail',
    });
    expect(out).toMatchObject({ recorded: 'voicemail', message: 'A test line.' });
    expect(store.contacts.get('c1')!.nextAttemptAt).toBeNull();
  });
});

describe('end_call no longer says the call ended', () => {
  it('answers that the line will close, not that it has, and still lets the bridge hang up', async () => {
    const { store, attemptId } = freshStore();
    const lane = await dialledLane(store, await attemptId);
    const out = JSON.parse((await (lane.agent as unknown as Dispatching).dispatch(END_CALL_TOOL_NAME, {})).output);
    expect(out).toEqual(END_CALL_RESULT);
    expect(out.ended).toBeUndefined();
    expect(guardsAllowedTermination(out)).toBe(true);
    expect(out.fix).toMatch(/still on/);
    expect(out.fix).toMatch(/Never say that the call has ended/);
  });
});

describe('the prompt: the cases exist, and no stage line is quoted in it', () => {
  async function dialledPrompt(): Promise<string> {
    const { store, attemptId } = freshStore();
    const lane = await dialledLane(store, await attemptId);
    return String((lane.agent as unknown as { instructions: unknown }).instructions);
  }

  it('a recording, a tone or a menu is no person: record voicemail and say only its message', async () => {
    const p = await dialledPrompt();
    expect(p).toMatch(/No person answered: a recorded greeting, a request to leave a message after the tone, or a menu of keys to press/);
    expect(p).toMatch(/record_call_outcome with voicemail, say the message it gives you word for word, and call end_call/);
    expect(p).toMatch(/Say nothing about Testa or why we called\. Call record_call_outcome with voicemail/);
  });

  it('a screening assistant is not the patient and not a yes (CA8065df91, CA395b23e0)', async () => {
    const p = await dialledPrompt();
    expect(p).toMatch(/An assistant answers for them[^\n]*It is not Testa, and it is not a yes/);
    expect(p).toMatch(/If it then asks you to leave a message, no person answered/);
  });

  it('the name said back as a question is not a yes, and the agent is never the patient (CA506ab94b)', async () => {
    const p = await dialledPrompt();
    expect(p).toMatch(/They say the name back as a question, or ask who is calling: that is not a yes/);
    expect(p).toMatch(/You are never Testa\./);
  });

  it('every word is for the person: no announcing tools, no narrating, no describing the call', async () => {
    const p = await dialledPrompt();
    expect(p).toMatch(/Every word you say is heard by the person on the line, so speak only to them/);
    expect(p).toMatch(/Call tools without announcing them\. Never describe what you are doing, never say a tool's name, and never describe the call itself\./);
  });

  it('quotes none of the lines it forbids, so there is nothing to read aloud (v97)', async () => {
    const p = await dialledPrompt();
    for (const line of [/Checking/i, /\bSilence\b/i, /End call\./, /call has (already )?ended/i, /call is over/i, /That's me/i, /quietly/i]) {
      expect(p).not.toMatch(line);
    }
  });
});
