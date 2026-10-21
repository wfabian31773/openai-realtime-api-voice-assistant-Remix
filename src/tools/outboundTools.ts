/**
 * Tools every OUTBOUND lane carries, bound by the runtime rather than listed
 * by the lane (src/runtime/laneRegistry.ts, RUNTIME_OUTBOUND_TOOLS) — the
 * 2026-09-15 rule: what applies to every conversation of a kind belongs to
 * the runtime, what applies to one agent belongs to its prompt.
 *
 *   opt_out_of_calls     the person asked not to be called. Phone-wide and
 *                        campaign-wide: the number goes on do_not_contact,
 *                        which every outbound dial checks first.
 *   record_call_outcome  how the call ended, for the campaign's queue: a
 *                        wrong number, call back later, not interested, done.
 *   identify_callback_caller  on a call the person made TO this line (a
 *                        returned call, src/runtime/outbound/callback.ts):
 *                        who they are on the campaign's list. Nothing about
 *                        why we called is said until it answers identified.
 *
 * WHO THE CALL IS ABOUT IS INJECTED, NEVER ASKED. The contact id and the
 * number dialled arrive as context the adapter merges UNDER the model's
 * arguments (the `lane` shape on lookup_patient): not schema fields, so the
 * model can neither set them nor be asked for them. A call with no injected
 * contact is refused, so these tools do nothing on a lane that was not dialled.
 *
 * A RETURNED CALL CARRIES NO CONTACT AT ALL: the runtime injects the call's
 * own CallSid, and the contact is whoever `identify_callback_caller` settles
 * on, held in a per-call session (openCallbackSession). Until then an outcome
 * cannot be recorded, because nobody on the call is known to be anybody.
 */
import { registerTool, type ToolFailure, type ToolResult } from './registry';
import { readDobQuietly } from './dobParts';
import { nameKey } from './verifiedIdentity';
import { DIALABLE_STATUSES, type ContactStatus, type OutboundStore } from '../runtime/outbound/store';
import { IDENTIFY_TOOL, dobOnFile, personKey, type CallbackCandidate } from '../runtime/outbound/callback';

let storeOverride: OutboundStore | null = null;
let storePromise: Promise<OutboundStore> | null = null;

/** Tests only: answer from an in-memory store instead of the Hub. */
export function setOutboundToolStoreForTests(store: OutboundStore | null): void {
  storeOverride = store;
}

async function outboundStore(): Promise<OutboundStore> {
  if (storeOverride) return storeOverride;
  storePromise ??= import('../runtime/outbound/store').then((m) => m.createDbOutboundStore());
  return storePromise;
}

export const OPT_OUT_TOOL_NAME = 'opt_out_of_calls';
export const RECORD_OUTCOME_TOOL_NAME = 'record_call_outcome';

interface Injected {
  contactId: string;
  phone: string;
  campaignKey: string;
}

function injected(input: Record<string, unknown>): Injected | null {
  const contactId = typeof input.outbound_contact_id === 'string' ? input.outbound_contact_id : '';
  const phone = typeof input.outbound_phone === 'string' ? input.outbound_phone : '';
  const campaignKey = typeof input.outbound_campaign === 'string' ? input.outbound_campaign : '';
  return contactId && phone && campaignKey ? { contactId, phone, campaignKey } : null;
}

/** A refusal that tells the model what to do next; `fix` is the model's
 * channel, never spoken (v43). */
interface OutboundRefusal extends ToolFailure {
  fix: string;
}

const NOT_AN_OUTBOUND_CALL: OutboundRefusal = {
  success: false,
  error: 'not_an_outbound_call',
  fix: 'This tool only works on a call this line placed. Do not call it again.',
};

// ── Returned calls ──────────────────────────────────────────────────────────

/** Who a returned call is with, for as long as the call lasts. */
export interface CallbackSession {
  callSid: string;
  campaignKey: string;
  /** Null when the campaign has never run: nobody can be on its list. */
  campaignId: string | null;
  /** The number the caller rang from. */
  callerPhone: string;
  /** Contacts on this campaign's list with the caller's number. */
  candidates: CallbackCandidate[];
  /** False when the runtime could not read the list in time: the first
   * identify_callback_caller reads it again rather than calling the caller
   * a stranger. */
  candidatesLoaded: boolean;
  /** Why we called, said only once they are identified. */
  purpose: string;
  /** The store the runtime used to find them, so a test's fake is honoured. */
  store: OutboundStore;
  /** Whoever identify_callback_caller settled on. */
  chosen: { contactId: string; phone: string; firstName: string | null } | null;
  /** The inbound attempt row written when they were identified. */
  attemptId: string | null;
  outcomeRecorded: boolean;
  identifyTries: number;
  openedAtMs: number;
}

const callbackSessions = new Map<string, CallbackSession>();
/** Bounded, so a call whose teardown never ran cannot grow the map. */
const MAX_CALLBACK_SESSIONS = 500;
const CALLBACK_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** How many times the agent may try to identify the caller on one call. */
export const MAX_IDENTIFY_TRIES = 4;

export function openCallbackSession(
  init: Omit<CallbackSession, 'chosen' | 'attemptId' | 'outcomeRecorded' | 'identifyTries' | 'openedAtMs'>,
  now: number = Date.now(),
): void {
  for (const [sid, s] of callbackSessions) {
    if (now - s.openedAtMs > CALLBACK_SESSION_TTL_MS) callbackSessions.delete(sid);
  }
  while (callbackSessions.size >= MAX_CALLBACK_SESSIONS) {
    const oldest = callbackSessions.keys().next().value;
    if (oldest === undefined) break;
    callbackSessions.delete(oldest);
  }
  callbackSessions.set(init.callSid, {
    ...init,
    chosen: null,
    attemptId: null,
    outcomeRecorded: false,
    identifyTries: 0,
    openedAtMs: now,
  });
}

/** Tests and the runtime's teardown only. */
export function callbackSessionFor(callSid: string): CallbackSession | undefined {
  return callbackSessions.get(callSid);
}

/**
 * The returned call is over. Ends its inbound attempt, and — when the caller
 * was identified and no outcome was recorded — marks them answered so the
 * dialler does not ring a person who has just spoken with us, on a guess
 * (the status webhook's rule for a dialled call, outboundWebhook.ts). Never
 * throws: teardown must not fail on telemetry.
 */
export async function closeCallbackSession(
  callSid: string,
  opts: { durationSeconds?: number } = {},
): Promise<void> {
  const session = callbackSessions.get(callSid);
  if (!session) return;
  callbackSessions.delete(callSid);
  try {
    if (session.attemptId) {
      await session.store.finishAttempt(session.attemptId, {
        status: 'completed',
        answeredBy: 'human',
        durationSeconds: opts.durationSeconds ?? null,
        ended: true,
      });
    }
    if (session.chosen && !session.outcomeRecorded) {
      await session.store.settleContact(session.chosen.contactId, 'answered', {
        onlyIfStatusIn: [...DIALABLE_STATUSES, 'calling'],
      });
    }
  } catch (error) {
    console.warn(
      `[outbound] returned call ${callSid}: could not close its record —`,
      error instanceof Error ? error.message : error,
    );
  }
}

function sessionFor(input: Record<string, unknown>): CallbackSession | null {
  const sid = typeof input.outbound_callback_sid === 'string' ? input.outbound_callback_sid : '';
  return sid ? (callbackSessions.get(sid) ?? null) : null;
}

const NOT_A_RETURNED_CALL: OutboundRefusal = {
  success: false,
  error: 'not_a_returned_call',
  fix: 'This tool only works on a call somebody made to this line. Do not call it again.',
};

function sameDob(
  a: { month: string; day: string; year: string } | null,
  b: { month: string; day: string; year: string } | null,
): boolean {
  return Boolean(a && b && a.year === b.year && a.month === b.month && a.day === b.day);
}

/** The candidates grouped into people; each person's rows, newest rung first. */
function people(rows: readonly CallbackCandidate[]): CallbackCandidate[][] {
  const byPerson = new Map<string, CallbackCandidate[]>();
  for (const r of rows) {
    const k = personKey(r);
    byPerson.set(k, [...(byPerson.get(k) ?? []), r]);
  }
  return [...byPerson.values()].map((rs) =>
    [...rs].sort((a, b) => (b.lastAttemptAt?.getTime() ?? -Infinity) - (a.lastAttemptAt?.getTime() ?? -Infinity)),
  );
}

type IdentifyResult = ToolResult;

function notYet(fix: string, needs?: string): IdentifyResult {
  return { success: true, identified: false, ...(needs ? { needs } : {}), fix };
}

registerTool({
  name: OPT_OUT_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 5000,
  description:
    'The person asked not to be called again, to be taken off the list, or to stop these calls — ' +
    'in any words, in any language. Call this AT ONCE, whatever else is happening on the call. ' +
    'Then say only what the result tells you to say and end the call politely. Never argue, ' +
    'never make the offer again after they have asked.',
  input_schema: { type: 'object', properties: {} },
  handler: async (input): Promise<ToolResult> => {
    const session = sessionFor(input);
    if (session) {
      // A returned call: the number they rang from, and — once identified —
      // the number we have on file for them, which may be another phone.
      const source = `voice:${session.campaignKey}`;
      await session.store.stampDoNotContact(session.callerPhone, source);
      if (session.chosen) {
        if (session.chosen.phone !== session.callerPhone) {
          await session.store.stampDoNotContact(session.chosen.phone, source);
        }
        await session.store.settleContact(session.chosen.contactId, 'do_not_call');
        session.outcomeRecorded = true;
      }
      return {
        success: true,
        message: "Understood. You won't receive these calls from us again. Thank you, goodbye.",
        fix: 'Say the message, then end the call. Do not make any offer again.',
      };
    }
    const who = injected(input);
    if (!who) return NOT_AN_OUTBOUND_CALL;
    const store = await outboundStore();
    // The do-not-contact row FIRST: it is the one every future dial reads,
    // so it must land even if settling this campaign's row then fails.
    await store.stampDoNotContact(who.phone, `voice:${who.campaignKey}`);
    await store.settleContact(who.contactId, 'do_not_call');
    return {
      success: true,
      message: "Understood. You won't receive these calls from us again. Thank you, goodbye.",
      fix: 'Say the message, then end the call. Do not make any offer again.',
    };
  },
});

/** What the model may report, and what the campaign queue records for it. */
export const CALL_OUTCOMES: Record<string, ContactStatus> = {
  wrong_person: 'wrong_number',
  call_back_later: 'callback_scheduled',
  not_interested: 'declined',
  done: 'completed',
};

registerTool({
  name: RECORD_OUTCOME_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 5000,
  description:
    "Record how this call ended, once, before you say goodbye. wrong_person: the person you are " +
    "calling for is not at this number. call_back_later: they asked to be called another time. " +
    'not_interested: they said no to what you offered. done: what this call was for is finished. ' +
    'If they asked not to be called at all, use opt_out_of_calls instead.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: Object.keys(CALL_OUTCOMES),
        description: 'How the call ended.',
        askAs: 'How did the call end?',
      },
    },
    required: ['outcome'],
  },
  handler: async (input): Promise<ToolResult> => {
    const session = sessionFor(input);
    const who = session ? null : injected(input);
    if (!session && !who) return NOT_AN_OUTBOUND_CALL;
    const outcome = String(input.outcome ?? '');
    const status = CALL_OUTCOMES[outcome];
    if (!status) {
      const refusal: OutboundRefusal = {
        success: false,
        error: 'unknown_outcome',
        fix: `outcome must be one of ${Object.keys(CALL_OUTCOMES).join(', ')}.`,
      };
      return refusal;
    }
    // "Call back later" is the one outcome the queue tries again — tomorrow,
    // inside the window, through the same caps as every other attempt.
    const nextAttemptAt =
      status === 'callback_scheduled' ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
    if (session) {
      // A RETURNED CALL. Nothing is recorded against anybody until the caller
      // is identified: a household member ringing back is not the patient.
      if (!session.chosen) {
        const refusal: OutboundRefusal = {
          success: false,
          error: 'caller_not_identified',
          fix: 'Nobody on this call has been identified, so there is no outcome to record. Do not call it again.',
        };
        return refusal;
      }
      if (status === 'wrong_number') {
        const refusal: OutboundRefusal = {
          success: false,
          error: 'not_on_a_returned_call',
          fix: 'They rang us and they are identified, so wrong_person does not apply. Record another outcome, or none.',
        };
        return refusal;
      }
      if (session.outcomeRecorded) {
        return {
          success: true,
          recorded: 'already_settled',
          fix: "This call's outcome is already on record. Do not record it again; say goodbye.",
        };
      }
      // The person themselves, telling us where things stand now: it
      // supersedes any earlier outcome but an opt-out, which a phone call
      // never lifts.
      await session.store.settleContact(session.chosen.contactId, status, {
        nextAttemptAt,
        exceptStatus: ['do_not_call'],
      });
      session.outcomeRecorded = true;
      return { success: true, recorded: outcome };
    }
    if (!who) return NOT_AN_OUTBOUND_CALL;
    const store = await outboundStore();
    // Only while the call still holds the row: an opt-out recorded earlier on
    // this call settled it as do_not_call, and nothing the model says after
    // that may turn it back into something the queue would ring again.
    const settled = await store.settleContact(who.contactId, status, {
      nextAttemptAt,
      onlyIfCalling: true,
    });
    if (!settled) {
      return {
        success: true,
        recorded: 'already_settled',
        fix: "This call's outcome is already on record. Do not record it again; say goodbye.",
      };
    }
    return { success: true, recorded: outcome };
  },
});

export const END_CALL_TOOL_NAME = 'end_call';

/**
 * Hang up. The voice runtime intercepts this NAME (mediaStreamBridge.ts,
 * DEFAULT_END_CALL_TOOL_NAMES): the tool runs, and a success lets the bridge
 * end the call — but never while the model is still holding a tool answer it
 * has not put into words (v56), so a goodbye is always heard first.
 *
 * Inbound lanes end calls through their own tools and guards (PCP's
 * terminate_call waits for a durable disposition). A dialled call has no
 * caller who will hang up when they are done, so every outbound lane gets
 * this one.
 */
registerTool({
  name: END_CALL_TOOL_NAME,
  layer: 'agent',
  timeoutMs: 2000,
  description:
    'End this call. Only after you have said goodbye and the person has had the chance to say ' +
    'anything else. Never in the middle of a sentence, never instead of answering them.',
  input_schema: { type: 'object', properties: {} },
  handler: async (input): Promise<ToolResult> => {
    if (!injected(input) && !sessionFor(input)) return NOT_AN_OUTBOUND_CALL;
    return { success: true, ended: true };
  },
});

export const IDENTIFY_CALLBACK_TOOL_NAME = IDENTIFY_TOOL;

/**
 * WHO RANG US BACK. RULE ZERO, step 2, in code: the calling number makes the
 * people on it CANDIDATES; a first name they give picks one only when exactly
 * one person on that number carries it (v54's affirmed-name rule). A caller
 * ringing from a number we never called is found by last name AND date of
 * birth, against a date the campaign holds — never by name alone, which would
 * hand a stranger somebody else's call. Several people who still fit are never
 * picked between.
 */
registerTool({
  name: IDENTIFY_TOOL,
  layer: 'agent',
  timeoutMs: 5000,
  description:
    'Only on a call somebody made TO this line. Find out who the caller is on the list of people we ' +
    'called. Call it with the first name they give you; add their last name and date of birth when ' +
    'the result asks for them. Until it says identified, say nothing about why we called.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: {
        type: 'string',
        description: "The caller's first name, as they said it.",
        askAs: 'May I have your first name?',
      },
      last_name: {
        type: 'string',
        description: "The caller's last name, as they said it.",
        askAs: 'And your last name?',
      },
      date_of_birth: {
        type: 'string',
        description: "The caller's date of birth, as they said it. Only when the result asked for it.",
        askAs: 'And your date of birth, starting with the month, then the day, then the year?',
      },
    },
    required: ['first_name'],
  },
  handler: async (input): Promise<ToolResult> => {
    const session = sessionFor(input);
    if (!session) return NOT_A_RETURNED_CALL;
    if (session.chosen) {
      return {
        success: true,
        identified: true,
        first_name: session.chosen.firstName,
        fix: `They are already identified. If you have not yet, tell them why we called: ${session.purpose}`,
      };
    }
    if (!session.candidatesLoaded) {
      const again = await session.store.callbackCandidates(session.campaignKey, session.callerPhone);
      session.campaignId = again.campaignId;
      session.candidates = again.candidates;
      session.candidatesLoaded = true;
    }
    session.identifyTries += 1;
    if (session.identifyTries > MAX_IDENTIFY_TRIES) {
      return notYet(
        'Stop trying to identify them. Do not say why we called. Help with anything else this line can, ' +
          'then end the call politely without recording an outcome.',
      );
    }
    const first = nameKey(typeof input.first_name === 'string' ? input.first_name : undefined);
    const last = nameKey(typeof input.last_name === 'string' ? input.last_name : undefined);
    const spokenDob =
      typeof input.date_of_birth === 'string' && input.date_of_birth.trim()
        ? readDobQuietly(input.date_of_birth)
        : null;
    if (!first) return notYet('Ask for their first name, then call this again with it.', 'first_name');

    const choose = async (rows: CallbackCandidate[]): Promise<ToolResult> => {
      const c = rows[0];
      session.chosen = { contactId: c.contactId, phone: c.phone, firstName: c.firstName };
      try {
        session.attemptId = await session.store.openCallbackAttempt(c.contactId, c.campaignId, session.callSid);
      } catch (error) {
        // The record of the returned call is history, not identity: a failed
        // write must not un-identify somebody we have just confirmed.
        console.warn(
          `[outbound] returned call ${session.callSid}: identified, but the inbound attempt was not written —`,
          error instanceof Error ? error.message : error,
        );
      }
      return {
        success: true,
        identified: true,
        first_name: c.firstName,
        fix: `They are identified. Tell them why we called: ${session.purpose} Then carry on with your Objective.`,
      };
    };

    // 1. The people on the number they rang from.
    const onPhone = people(
      session.candidates.filter(
        (c) => nameKey(c.firstName ?? undefined) === first && (!last || nameKey(c.lastName ?? undefined) === last),
      ),
    );
    if (onPhone.length === 1) return choose(onPhone[0]);
    if (onPhone.length > 1) {
      if (!last) return notYet('More than one person on this number has that first name. Ask for their last name, then call this again with both.', 'last_name');
      const byDob = onPhone.filter((rows) => sameDob(dobOnFile(rows[0]), spokenDob));
      if (byDob.length === 1) return choose(byDob[0]);
      if (!spokenDob) {
        return notYet(
          'More than one person on this number has that name. Ask for their date of birth, starting with the month, ' +
            'then the day, then the year, then call this again with all three.',
          'date_of_birth',
        );
      }
      return notYet("We cannot tell which of the people on this number they are. Do not say why we called, and do not guess.");
    }

    // 2. Somebody calling from a number we never rang.
    if (!session.campaignId) {
      return notYet("They are not on this line's list. Do not say why we called. Help with anything else this line can.");
    }
    if (!last) return notYet('Ask for their last name, then call this again with their first and last name.', 'last_name');
    if (!spokenDob) {
      return notYet(
        'Ask for their date of birth, starting with the month, then the day, then the year, then call this again ' +
          'with their name and date of birth.',
        'date_of_birth',
      );
    }
    const elsewhere = people(
      (await session.store.contactsByName(session.campaignId, first, last)).filter((c) => sameDob(dobOnFile(c), spokenDob)),
    );
    if (elsewhere.length === 1) return choose(elsewhere[0]);
    return notYet(
      "We could not find them on this line's list. Do not say why we called. Help with anything else this line can, " +
        'then end the call politely without recording an outcome.',
    );
  },
});
