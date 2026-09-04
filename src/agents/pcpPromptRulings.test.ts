/**
 * src/agents/pcpPromptRulings.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY OPERATOR RULING IN THE PCP PROMPT, BEFORE ANYBODY TRIMS IT.
 *
 * `queuePromptRulings.test.ts` exists because trimming the four queue prompts
 * for Grok risked dropping rulings the operator paid for with real calls. pcp
 * has never been trimmed and has never had this net, for one reason: it has
 * spent its whole life refused by the runtime, so nobody measured it. Measured
 * 2026-09-04 through `realLanes.test.ts` with a transfer injected, it is
 * **~2,260 prompt tokens — a third larger than any lane that WAS trimmed**,
 * against a standing note of *"Grok requires minimal prompting, we should not
 * be near our ceilings."*
 *
 * So the net comes first and the trim second. This file is written against the
 * prompt AS IT STANDS TODAY, so it is green before a single character is cut
 * and stays green after — which is the only way to tell a trim from a
 * regression. Every ruling below traces to a standing instruction or to a
 * dated incident recorded in `pcpAgent.ts` itself; where the provenance is the
 * prompt's own text and nothing more, it says so rather than inventing a date.
 *
 * Matched loosely on MEANING, never on a sentence — a regex on one phrasing is
 * routed around by rewording, and rewording is precisely what a trim does.
 */
import { describe, it, expect, vi } from 'vitest';

// Hoisted: ES imports evaluate before plain statements, and the agent modules
// validate the environment at import time. A bare assignment runs too late and
// every case fails with "DATABASE_URL: Required". Nothing connects.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { buildPcpPrompt } from './pcpAgent';

/** One ruling, and the several ways a prompt might legitimately word it. */
interface Ruling {
  /** Where it came from, so a failure is traceable to what bought it. */
  readonly source: string;
  /** Every alternative must appear (AND); each alternative is a set of
   *  case-insensitive substrings of which ANY may match (OR). */
  readonly requires: readonly (readonly string[])[];
}

const PCP_RULINGS: readonly Ruling[] = [
  /* ── how the call is paced ───────────────────────────────────────────── */
  {
    /**
     * Operator, quoted in pcpAgent.ts: *"you gotta wait for a fucking answer.
     * One answer at a time."* The prompt's own words call this "the rule the
     * whole call runs on", and it outranks everything else in the prompt.
     */
    source: 'Operator — one question, then stop talking; it outranks the rest of the prompt',
    requires: [
      ['ask one question', 'one question'],
      ['wait for the caller', 'then stop talking', 'stop. wait'],
    ],
  },
  {
    /**
     * The half a reworded trim would drop first, because it reads like tone
     * advice and is not: acknowledging an answer nobody gave is the model
     * writing the caller's half of the conversation.
     */
    source: "Prompt ruling — never thank someone for an answer they have not given",
    requires: [
      ['never thank', 'do not thank'],
      ['not spoken', 'have not given', 'not been given'],
    ],
  },
  {
    /**
     * 2026-08-14, CAc88c6e9c: the model asked for the organization and the
     * callback number 1,141ms apart. #201 put the whole numbered intake in the
     * prompt so it could not invent an order; it stopped inventing and started
     * RECITING. The fix was to remove the list — so the prompt must describe
     * the PROTOCOL and never the contents.
     */
    source: '2026-08-14 (CAc88c6e9c) — the director names the next field; the model must not hold the list',
    requires: [
      ['record_pcp_intake'],
      ['one field', 'exactly one field', 'single next question'],
      ['you do not have the list', 'never re-ask', 'do not have the list'],
    ],
  },

  /* ── who is on the phone ─────────────────────────────────────────────── */
  {
    /**
     * The PCP number is published for clinics, but patients ring it, "and that
     * is not their mistake to fix". A patient must be switched to a much
     * shorter intake rather than interrogated with professional questions.
     */
    source: 'Prompt ruling — a patient reaching this line becomes patient_caller, and professional questions stop',
    requires: [
      ['patient_caller'],
      ['no role', 'stop asking professional questions', 'never ask them a professional question'],
    ],
  },
  {
    /**
     * Found on the second review pass, 2026-08-17: distinct from
     * patient_caller. Someone ringing for their OWN records is the patient, and
     * without this flag the agent asks them for "the patient's name" when it
     * already has it.
     */
    source: '2026-08-17 review — callerIsThePatient is separate from patient_caller',
    requires: [
      ['calleristhepatient'],
      ['family member', 'someone else'],
    ],
  },
  {
    source: 'Prompt ruling — never re-ask something the caller already volunteered',
    requires: [
      ['already given you', 'before you asked'],
      ['record it and skip', 'skip it'],
    ],
  },

  /* ── standing instructions ───────────────────────────────────────────── */
  {
    source: 'Standing instruction 10 (2026-08-13) — nobody is told to call back or sent to another number',
    requires: [
      ['wrong number', 'wrong extension'],
      ['never say', 'do not say', "don't say"],
    ],
  },
  {
    source: 'Standing instruction 12 — confirm the callback number BEFORE filing, never after',
    requires: [
      ['before the ticket', 'before you file', 'then file'],
      ['already filed', 'after you have filed'],
    ],
  },
  {
    /**
     * Standing instruction 7's shape on this lane: a patient cannot be
     * transferred from a queue staffed to speak with clinics, so the boundary
     * is stated plainly AND the request is taken.
     */
    source: 'Standing instruction 7 — state the boundary plainly, then take the request',
    requires: [
      ['not able to put you through', 'cannot transfer', 'not able to transfer'],
      ['call you back', 'callback', 'call back'],
      ['create_pcp_task', 'take this down', "i'll take this"],
    ],
  },

  /* ── the transfer, which is the entire point of this lane ────────────── */
  {
    /**
     * The handoff files the request BEFORE dialling. 57 PCP handoffs in the 90
     * days to 2026-08-13 produced 11 connections — so the request surviving a
     * failed dial is not a nicety, it is the common case.
     */
    source: '90 days to 2026-08-13 — 57 handoffs, 11 connected: file BEFORE dialling',
    requires: [
      ['handoff_to_pcp'],
      ['before dialling', 'before dialing', 'nothing is lost'],
    ],
  },
  {
    /**
     * #19, the contradictory transfer briefing. Whether one person, several or
     * a queue is reached is a configuration decision; a promise about it is a
     * promise the lane cannot keep.
     */
    source: '#19 — never promise HOW they are being reached',
    requires: [
      ['never promise how', 'do not promise how'],
      ['configuration decision', 'one person, several'],
    ],
  },
  {
    source: 'Prompt ruling — never say somebody answered unless they did',
    requires: [['never say somebody answered', 'unless they did']],
  },
  {
    source: 'Prompt ruling — only the director decides whether a transfer is available',
    requires: [['only the director', 'the director decides']],
  },

  /* ── never invent, never leak ────────────────────────────────────────── */
  {
    source: 'Prompt ruling — never invent a patient, a number, a verification, a provider or a location',
    requires: [
      ['never invent'],
      ['verification', 'callback number'],
    ],
  },
  {
    source: 'Prompt ruling — this lane verifies nobody on the call; take it and check afterwards',
    requires: [['do not verify', 'you do not verify'], ['afterwards', 'let it be checked']],
  },
  {
    /**
     * The refusal channel, and the reason it is split in two. `guidance` is for
     * the model and must never reach the caller; `say` is the caller's
     * sentence. A caller learning that a tool refused something is the failure
     * this separation exists to prevent.
     */
    source: 'Prompt ruling — guidance is for the model and is NEVER read out; say is for the caller',
    requires: [
      ['guidance'],
      ['never read this out', 'never read it out', 'must never learn'],
      ['say'],
    ],
  },
  {
    source: 'Prompt ruling — never tell a caller something is unavailable, unfinalized or still processing',
    requires: [
      ['unavailable'],
      ['not finalized', 'still processing'],
      ['never say goodbye twice', 'goodbye twice'],
    ],
  },

  /* ── safety and the shape of speech ──────────────────────────────────── */
  {
    source: 'Prompt ruling — no diagnosis, triage, treatment or dosage advice',
    requires: [['no diagnosis', 'diagnosis'], ['triage'], ['medication', 'dosage']],
  },
  {
    /**
     * The 911 line names WHY: this lane's transfer is administrative. An
     * emergency caller told "let me connect you" would be waiting on a queue
     * that cannot help them.
     */
    source: 'Prompt ruling — an emergency is 911; this transfer is administrative, not an emergency path',
    requires: [['911'], ['administrative'], ['not an emergency path', 'emergency path']],
  },
  {
    source: 'Prompt ruling — never go silent while a tool runs; say a line first, then call it',
    requires: [
      ['never go silent', 'do not go silent'],
      ['one moment', 'one second'],
      ['never call a tool cold', 'tool cold'],
    ],
  },
  {
    source: 'Prompt ruling — spoken output: no markdown, no bullets, no spelling unless asked',
    requires: [['markdown'], ['spoken', 'out loud'], ['spell']],
  },
  {
    source: 'Prompt ruling — do not end the call until terminate_call confirms the outcome was recorded',
    requires: [['terminate_call'], ['recorded', 'confirms']],
  },
  {
    source: 'Prompt ruling — medical records tool only for an explicit records request',
    requires: [
      ['handle_patient_medical_records_request'],
      ['only when', 'explicitly asks'],
      ['peer-to-peer', 'referral'],
    ],
  },
];

const pcp = buildPcpPrompt({ callerPhone: '+17605551234' } as never);

describe('pcp prompt keeps every ruling', () => {
  for (const ruling of PCP_RULINGS) {
    it(`still expresses: ${ruling.source}`, () => {
      const hay = pcp.toLowerCase();
      for (const alternatives of ruling.requires) {
        const hit = alternatives.some((a) => hay.includes(a.toLowerCase()));
        expect(hit, `none of ${JSON.stringify(alternatives)} appear in the prompt`).toBe(true);
      }
    });
  }
});

describe('the caller-ID seeded callback number', () => {
  /**
   * Not a ruling about wording — a branch. With caller ID the number is
   * already seeded and asking for it again wastes a turn on a line where
   * professionals are brief; without it the agent MUST ask, and a trim that
   * collapsed the two would silently file tickets with no way to call back.
   */
  it('says do not ask when the number is known', () => {
    expect(buildPcpPrompt({ callerPhone: '+17605551234' } as never)).toMatch(
      /do NOT ask for one unless they offer/,
    );
  });

  it('says you will have to ask when it was withheld', () => {
    const withheld = buildPcpPrompt({} as never).toLowerCase();
    expect(withheld).toContain('withheld');
    expect(withheld).toMatch(/ask for a callback number/);
  });
});

/**
 * EVERY SECTION EARNS ITS TOKENS, OR IS NAMED HERE AS ONE THAT DOES NOT.
 *
 * The rulings above prove nothing was lost. They cannot tell you whether a
 * section is worth keeping — and the trim this file exists to make safe needs
 * exactly that. So the coverage runs the other way: delete each section from
 * the rendered prompt and see which rulings stop holding. A section whose
 * removal breaks nothing is either dead weight or a hole in the net, and
 * somebody has to decide which.
 *
 * Swept 2026-09-04. Three sections came back empty and all three are listed
 * below with the reason, because an allowlist that does not say why is just a
 * suppressed failure. A NEW empty section fails this test rather than joining
 * them silently.
 */
const NO_UNIQUE_RULING: Record<string, string> = {
  '# WHAT YOU DO':
    'A 49-token framing of the capability boundary — answer from a lookup, file, ' +
    'or connect, "Nothing else". Kept deliberately: the boundary is real even ' +
    'though no ruling below is worded from it.',
  '# THE DIRECTOR DECIDES, NOT YOU':
    'Overlaps "## HOW YOU KNOW WHAT TO ASK" on "ask only the next question ' +
    'record_pcp_intake gives you". It alone says the director also decides ' +
    'whether a TRANSFER is available, so it is not a pure duplicate.',
  '## HOW YOU KNOW WHAT TO ASK':
    'The other half of the same overlap. It alone carries the four-step loop ' +
    'and "you do not have the list" — the #201 lesson, where showing the model ' +
    'the intake order stopped it inventing a sequence and started it reciting one.',
};

describe('section coverage', () => {
  const holds = (text: string, r: Ruling) =>
    r.requires.every((alts) => alts.some((a) => text.toLowerCase().includes(a.toLowerCase())));

  const heads = [...pcp.matchAll(/^#{1,3} .+$/gm)].map((m) => [m.index as number, m[0]] as const);
  const marks = [...heads, [pcp.length, 'EOF'] as const];

  for (let k = 0; k < marks.length - 1; k++) {
    const [start, heading] = marks[k];
    const withoutIt = pcp.slice(0, start) + pcp.slice(marks[k + 1][0]);
    it(`${heading} — carries a ruling, or is a named exception`, () => {
      const lost = PCP_RULINGS.filter((r) => holds(pcp, r) && !holds(withoutIt, r));
      if (heading in NO_UNIQUE_RULING) {
        // Pinned the other way round: if this section starts carrying a unique
        // ruling, the note beside it has gone stale and should be removed.
        expect(
          lost,
          `${heading} now carries a unique ruling — drop it from NO_UNIQUE_RULING`,
        ).toEqual([]);
        return;
      }
      expect(
        lost.length,
        `${heading} (~${Math.round((marks[k + 1][0] - start) / 4)} tokens) can be deleted ` +
          `without breaking any ruling. Either it is trim-able, or a ruling it carries ` +
          `is missing from this file. Decide which, then say so in NO_UNIQUE_RULING.`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('what the prompt costs', () => {
  /**
   * A CEILING SET WHERE THE PROMPT ACTUALLY IS — deliberately, and it is not
   * yet the operator's number.
   *
   * The four queue lanes were trimmed first and pinned just above where they
   * landed: surgery 1,800, records 1,750, tech 1,600, optical 1,500. pcp is at
   * ~2,260 and has never been trimmed, so pinning it at 2,300 asserts only one
   * thing today — that it does not grow while nobody is looking. Lowering it
   * is the point of the trim, and how far is Wayne's call, not this file's.
   */
  it('does not grow beyond where it stands today', () => {
    expect(Math.round(pcp.length / 4)).toBeLessThan(2300);
  });

  it('carries no war story — those belong in code comments', () => {
    // The rule the queue lanes are held to. pcp passes it today; the check
    // exists so a trim cannot "explain itself" into the prompt.
    expect(pcp, 'the prompt cites a dated incident').not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(pcp, 'the prompt quotes a call count').not.toMatch(/\b\d+ of \d+\b/);
  });
});
