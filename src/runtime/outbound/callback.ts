/**
 * src/runtime/outbound/callback.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN THE PERSON WE CALLED CALLS US BACK.
 *
 * Operator, 2026-10-21: *"There is no redirect. If a patient calls back, like
 * we expect them to, the voice agent has to handle that call as well and know
 * exactly who is on the line and why they are calling."* That is how 5Star's
 * Sage works: one number dials out and takes the calls back, the inbound call
 * matches the caller's number against the outreach list, loads who they are
 * and why we were calling, confirms identity before saying anything private,
 * and finishes the job on that call.
 *
 * v105 refused an inbound call on an outbound lane outright, so a patient who
 * rang back the number on their caller ID heard "unavailable". This module is
 * the inbound half of an outbound lane:
 *
 *   matchCallback       who on this campaign's list the calling number belongs
 *                       to — ONE person, SEVERAL (never picked), or NONE
 *   callbackGreeting    the first words: a single match by first name,
 *                       anybody else asked who is calling
 *   callbackSteps       what the agent does next, inserted into the lane's
 *                       own Conversation Flow as `### Returned call`
 *
 * RULE ZERO, step 2: a phone number is a candidate to CONFIRM, never an
 * identity. A callback from a matched number is greeted by the person's first
 * name (operator, 2026-10-21), their reply is their answer — a caller who says
 * it is not them is asked who is calling — and nothing about why we called is
 * said until the caller is identified through `identify_callback_caller`
 * (src/tools/outboundTools.ts). A lane that discloses more than why it called
 * holds that behind its own check (the NPX outreach lane: a date of birth). Several people on one number are never picked between —
 * the agent asks who is calling. A number not on the list may be the person
 * calling from another phone, so the agent asks their name and, where the
 * campaign holds one, their date of birth.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { nameKey } from "../../tools/verifiedIdentity";
import { readDobQuietly } from "../../tools/dobParts";
import { OUTBOUND_RECORDING_CLAUSE, type OutboundLanePolicy } from "./campaign";
import type { ContactStatus } from "./store";

/** A contact on the campaign's list whose number the caller rang from. */
export interface CallbackCandidate {
  contactId: string;
  campaignId: string;
  /** The number on the contact row. */
  phone: string;
  firstName: string | null;
  lastName: string | null;
  status: ContactStatus;
  /** The campaign's own fields for this person (`custom_data`). */
  data: Record<string, unknown>;
  /** The newest dial that reached the network (a refused dial rang nobody). */
  lastAttemptAt: Date | null;
  /** That dial's status: voicemail, no_answer, completed, … */
  lastAttemptStatus: string | null;
}

export type CallbackMatch =
  /** One person on this number. `contact` is their most recently rung row. */
  | { kind: "one"; contact: CallbackCandidate }
  /** More than one person on this number. Never picked between. */
  | { kind: "several"; people: number }
  /** Nobody on this campaign's list has this number. */
  | { kind: "none" };

/** What the runtime hands the agent and the tools on a returned call. */
export interface CallbackContext {
  campaignKey: string;
  /** Null when the campaign has never run, so nobody can be on its list. */
  campaignId: string | null;
  /** The number the caller rang from, E.164 as Twilio sends it. */
  callerPhone: string;
  match: CallbackMatch;
  /** Why the campaign was calling, said only once the caller is identified. */
  purpose: string;
}

/** The date of birth a campaign row carries in its own fields, as Y-M-D,
 * or null. `date_of_birth` is the key a campaign import writes it under. */
export function dobOnFile(c: Pick<CallbackCandidate, "data">): { month: string; day: string; year: string } | null {
  const raw = c.data.date_of_birth ?? c.data.dateOfBirth;
  return typeof raw === "string" && raw.trim() ? readDobQuietly(raw) : null;
}

/** One person's key: the same first and last name, folded the way the
 * identity store folds them, so "José" and "Jose" are one person — and the
 * same date of birth where the campaign holds one, so a father and a son who
 * share a name are two. Rows with neither name are each their own person:
 * nothing says they are the same. */
export function personKey(c: Pick<CallbackCandidate, "firstName" | "lastName" | "contactId" | "data">): string {
  const first = nameKey(c.firstName ?? undefined);
  const last = nameKey(c.lastName ?? undefined);
  if (!first && !last) return `row:${c.contactId}`;
  const dob = dobOnFile(c);
  return `${first}|${last}|${dob ? `${dob.year}-${dob.month}-${dob.day}` : ""}`;
}

/** Newest rung first; a row never rung sorts last. */
function byLastAttempt(a: CallbackCandidate, b: CallbackCandidate): number {
  return (b.lastAttemptAt?.getTime() ?? -Infinity) - (a.lastAttemptAt?.getTime() ?? -Infinity);
}

/**
 * Who the calling number belongs to on this campaign's list. One person may
 * sit on several rows (two appointments); that is still one person, and the
 * row most recently rung is the one the call is about. Two different people
 * on one number — a household phone — are never chosen between here.
 */
export function matchCallback(candidates: readonly CallbackCandidate[]): CallbackMatch {
  if (candidates.length === 0) return { kind: "none" };
  const people = new Set(candidates.map(personKey));
  if (people.size > 1) return { kind: "several", people: people.size };
  return { kind: "one", contact: [...candidates].sort(byLastAttempt)[0] };
}

/** The first name to confirm, or null when the row has none to say. */
function firstNameOf(match: CallbackMatch): string | null {
  return match.kind === "one" ? match.contact.firstName?.trim() || null : null;
}

/**
 * The first words a caller hears. A single match is greeted by first name —
 * operator, 2026-10-21: "we are recognizing the phone number … and we are
 * greeting by name. Hello, Wayne. Thank you for calling." — and the caller's
 * reply is their answer: anything but "that's not me" carries on, the way a
 * yes to "May I speak with …?" does on a dialled call. Anything else asks who
 * is calling. Either way it says it is automated and recorded before anything
 * is asked (OUTBOUND_RECORDING_CLAUSE), never says the last name, and never
 * says why we called: that waits for identification.
 */
export function callbackGreeting(match: CallbackMatch, opts: { sayName?: boolean } = {}): string {
  const first = firstNameOf(match);
  // SI Assistant must not name the patient before they are verified (P2-A).
  if (first && opts.sayName !== false) {
    return `Hello, ${first}. Thank you for calling Azul Vision. This is an automated assistant. ${OUTBOUND_RECORDING_CLAUSE}.`;
  }
  return `Thank you for calling Azul Vision. This is an automated assistant. ${OUTBOUND_RECORDING_CLAUSE}. May I have your first and last name?`;
}

/** "Tuesday, October 20" in Pacific time — the practice's day, not the server's. */
function pacificDay(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

/** What the last dial did, as the agent may say it once they are identified. */
export function describeLastAttempt(c: CallbackCandidate): string {
  if (!c.lastAttemptAt) return "We have not reached them by phone yet.";
  const day = pacificDay(c.lastAttemptAt);
  switch (c.lastAttemptStatus) {
    case "voicemail":
      return `We called on ${day} and left a voicemail.`;
    case "no_answer":
    case "busy":
      return `We called on ${day} and nobody answered.`;
    case "completed":
    case "answered":
      return `We spoke with somebody at this number on ${day}.`;
    default:
      return `We last called on ${day}.`;
  }
}

export const IDENTIFY_TOOL = "identify_callback_caller";

/**
 * The agent's steps on a returned call. Inserted into the lane's own
 * Conversation Flow so the prompt keeps the docs' five sections (see
 * withCallbackSteps). The lane's prompt says what the campaign is FOR; this
 * says how to find out who is calling first, the same way on every campaign.
 */
export function callbackSteps(ctx: CallbackContext, opts: { nameBeforeVerify?: boolean } = {}): string {
  const lines: string[] = [
    "### Returned call",
    "This person rang the number this line calls from: they are calling us. Your opening has already been spoken. " +
      "Never tell them why we called, or anything about anyone, until they are identified.",
  ];
  const first = firstNameOf(ctx.match);
  if (opts.nameBeforeVerify === false) {
    lines.push(
      "Ask for their first and last name, then their date of birth starting with the month, then the day, then the year. " +
        `Call ${IDENTIFY_TOOL} with all three. Do not guess who they are from the number.`,
    );
  } else if (ctx.match.kind === "one" && first) {
    lines.push(
      `Their number matches someone we called: ${first}, and your opening greeted them by that name. ${describeLastAttempt(ctx.match.contact)}`,
      `Unless their reply says they are not ${first}, or that ${first} is not there, they are ${first}: call ${IDENTIFY_TOOL} with first_name "${first}" before you say anything else.`,
      `If they say they are not ${first}, or that ${first} is not there: do not say why we called. Ask for their first and last name and call ${IDENTIFY_TOOL} with what they say.`,
    );
  } else if (ctx.match.kind === "several") {
    lines.push(
      "This number belongs to more than one person we called. Ask for their first and last name, then call " +
        `${IDENTIFY_TOOL} with it. Never guess which of them it is.`,
    );
  } else {
    lines.push(
      "This number is not one we called. They may be calling back from another phone. Ask for their first and " +
        `last name, then call ${IDENTIFY_TOOL}. If it asks for their date of birth, ask for it starting with the ` +
        "month, then the day, then the year.",
    );
  }
  lines.push(
    `Do what ${IDENTIFY_TOOL} tells you. Once they are identified, tell them why we called: ${ctx.purpose} Then carry on with your Objective.`,
    `If they cannot be identified, do not say why we called. Help with anything else this line can, then end the call politely without recording an outcome.`,
  );
  return lines.join("\n");
}

const FLOW = "## Conversation Flow";

/**
 * Put the steps FIRST in the lane's Conversation Flow, straight under its
 * heading: finding out who rang comes before everything the lane's own flow
 * does. Inside the section, so the bound prompt keeps the docs' five sections
 * in order. A prompt with no such section gets them appended.
 */
export function withCallbackSteps(instructions: string, steps: string): string {
  const at = instructions.indexOf(FLOW);
  if (at < 0) return `${instructions}\n\n${steps}`;
  const lineEnd = instructions.indexOf("\n", at);
  if (lineEnd < 0) return `${instructions}\n${steps}`;
  return `${instructions.slice(0, lineEnd + 1)}${steps}\n${instructions.slice(lineEnd + 1)}`;
}

/** Why the campaign called, for a policy that has not said. Says nothing
 * private, because it knows nothing. */
export const DEFAULT_CALLBACK_PURPOSE =
  "our team was trying to reach them, and you can take a message for the team.";

export function callbackPurpose(policy: Pick<OutboundLanePolicy, "callbackPurpose">): string {
  return policy.callbackPurpose?.trim() || DEFAULT_CALLBACK_PURPOSE;
}
