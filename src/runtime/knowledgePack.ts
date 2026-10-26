/**
 * src/runtime/knowledgePack.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What every agent on this runtime knows by heart, before a word of its own
 * prompt: who it works for, where the offices are, who the providers are,
 * what the practice does, when it is open, how people pay.
 *
 * Wayne, on why this belongs to the runtime and not to each agent:
 *
 *   "Our locations, our providers, our addresses, phone numbers, fax
 *    numbers, services rendered … things that are on our website, that
 *    anyone can go and fetch. All of this material should be part of the
 *    runtime. The agent should know this by memory, by heart, should be
 *    completely familiar with our practice. We shouldn't have to inject
 *    this information into each agent."
 *
 * Today four of the twelve agents import the practice knowledge and eight
 * do not, which is exactly the divergence this removes: on the runtime, no
 * agent can be missing it, because no agent supplies it.
 *
 * THREE PROPERTIES THIS FILE HAS TO KEEP.
 *
 * 1. GENERATED, NEVER HAND-MAINTAINED. Every fact below is read from
 *    src/config/azulVisionKnowledge.ts through its own builders. A phone
 *    number changed there changes here, and there is no second copy to
 *    drift. This file adds framing, not facts.
 *
 * 2. PUBLIC ONLY. Everything here is on azulvision.com. Nothing about any
 *    patient is in the pack — not a name, not an appointment, nothing. It
 *    is spoken to whoever dials the number, so it must be safe to say to a
 *    stranger. That is a safety property, not a style preference.
 *
 * 3. BYTE-IDENTICAL ON EVERY CALL AND EVERY LANE. The pack is the head of
 *    the cached prefix (ADR-001): a prefix that varies by a character
 *    misses the cache, and a prefix that varies by a TIMESTAMP misses it on
 *    every single call. Nothing volatile goes in here — no date, no time,
 *    no caller, no lane. Volatile context belongs after the agent's own
 *    instructions, where it costs one cache segment instead of all of them.
 *    Measured today: text caching runs 83.7% overall but only 30.6% on
 *    short calls, because the prefix has to be re-read before it is warm.
 *    A test asserts the pack is stable across calls; it is the only thing
 *    standing between this design and a silent 0% cache rate.
 *
 * THE RISK, NAMED. A model that has been handed thirty addresses will
 * recite one confidently when it is wrong. The pack therefore ends with the
 * only instruction it contains, which is Wayne's own rule turned around and
 * pointed at the agent: if it is not written here, do not state it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  AZUL_VISION_KNOWLEDGE,
  AZUL_VISION_LOCATIONS,
  buildProvidersReference,
  buildServicesReference,
} from "../config/azulVisionKnowledge";

/**
 * Bump when the pack's SHAPE changes (a section added, framing reworded).
 * Facts flowing in from azulVisionKnowledge.ts do not need a bump — they
 * change the pack's bytes, which is the point. The version exists so a
 * cache-rate change can be attributed to a prefix change rather than
 * guessed at.
 */
export const KNOWLEDGE_PACK_VERSION = "v1";

/** Who the agent works for. Identical for every lane: an agent taking an
 * optical overflow call and an agent taking a surgery call work for the
 * same practice, and only their own prompt makes them different. */
const ORG_IDENTITY = `YOU WORK FOR AZUL VISION.

You are a voice agent employed by ${AZUL_VISION_KNOWLEDGE.practice.name}, an
eye-care organization — ${AZUL_VISION_KNOWLEDGE.practice.tagline},
${AZUL_VISION_KNOWLEDGE.practice.size}.
Everyone who calls is calling an eye-care practice, and every request you
handle is an eye-care request. You are not a general assistant, and you are
never a person — if a caller asks, say plainly that you are an automated
assistant for the practice.`;

/**
 * Locations WITH fax numbers and hours. The shared
 * buildCompactLocationReference() drops both, and Wayne named fax numbers
 * explicitly as something the agent should know by heart — an office
 * asking where to fax a referral is a routine call. Built from the same
 * AZUL_VISION_LOCATIONS array rather than a second list, so the "generated,
 * never hand-maintained" property holds; the shared builder is left alone
 * because four agents already depend on its exact shape.
 */
function buildLocationBlock(): string {
  return AZUL_VISION_LOCATIONS.map(
    (loc) =>
      `${loc.name}: ${loc.address}, ${loc.city}, ${loc.state} ${loc.zip} | ` +
      `phone ${loc.phone} | fax ${loc.fax} | ${loc.hours}`,
  ).join("\n");
}

const PRACTICE_FACTS = `PRACTICE FACTS

Website: ${AZUL_VISION_KNOWLEDGE.practice.website}
Hours: ${AZUL_VISION_KNOWLEDGE.businessHours.standard}
Holidays: ${AZUL_VISION_KNOWLEDGE.businessHours.holidays}

Request an appointment: ${AZUL_VISION_KNOWLEDGE.scheduling.appointmentRequestUrl}
Make a payment: ${AZUL_VISION_KNOWLEDGE.scheduling.paymentUrl}

Payment methods: ${AZUL_VISION_KNOWLEDGE.payment.methods.join(", ")}
Financing: ${AZUL_VISION_KNOWLEDGE.payment.financing.join(" | ")}
Insurance: ${AZUL_VISION_KNOWLEDGE.payment.insurance}
${AZUL_VISION_KNOWLEDGE.payment.note}

Partner practices: ${AZUL_VISION_KNOWLEDGE.partnerPractices.join(", ")}`;

/** The one instruction the pack carries — see THE RISK, NAMED above. */
const ACCURACY_FLOOR = `USING THIS KNOWLEDGE

Everything above is public and you may say any of it to any caller.

If a caller asks something this pack does not answer — a specific
appointment, a balance, whether a particular plan is accepted, anything
about a particular person — you do not know it, and saying you do not know
is the correct answer. Do not reconstruct an address, a phone number, a fax
number or a provider's location from memory or from what sounds right: read
what is written above or say you will have someone confirm it. A confident
wrong address sends a patient to the wrong city.`;

/**
 * The pack, assembled. No arguments by design: an argument is a way for
 * the prefix to differ between calls, and a prefix that differs is a
 * prefix that is not cached.
 */
export function buildKnowledgePack(): string {
  return [
    ORG_IDENTITY,
    "OFFICE LOCATIONS",
    buildLocationBlock(),
    buildProvidersReference().trim(),
    buildServicesReference().trim(),
    PRACTICE_FACTS,
    ACCURACY_FLOOR,
  ].join("\n\n");
}
