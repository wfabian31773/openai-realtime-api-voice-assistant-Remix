/**
 * src/agents/queuePromptRulings.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY OPERATOR RULING STILL IN THE PROMPT, AFTER THE TRIM.
 *
 * Task #25 shortens the queue prompts for Grok, whose vendor guidance is
 * explicit: "Simplify the system prompt... Remove workaround prompting —
 * strip instructions that exist only to paper over the previous model's bugs."
 *
 * The danger in doing that is not subtle. These prompts carry rulings the
 * operator paid for with real calls — nobody is told to call back, there is no
 * transfer on this line, the callback number comes before the ticket — and a
 * trim that quietly drops one costs exactly what the ruling was bought with.
 *
 * So the rulings are asserted here as BEHAVIOUR THE PROMPT MUST STILL EXPRESS,
 * matched loosely on meaning rather than on a sentence. A regex on one phrasing
 * would be routed around by rewording, and rewording is the one thing a
 * language model — or an agent trimming a prompt — does reliably.
 */
import { describe, it, expect, vi } from 'vitest';

// Hoisted: ES imports are evaluated before plain statements, and the agent
// modules validate the environment at import time. A bare assignment here runs
// too late and every case fails with "DATABASE_URL: Required". Nothing
// connects — the value only has to exist.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { buildSurgeryPrompt } from './surgeryAgent';
import { buildTechPrompt } from './techAgent';
import { GREETING_ALREADY_PLAYED } from '../runtime/greetingAlreadyPlayed';
import { buildOpticalPrompt } from './opticalAgent';
import { buildRecordsPrompt } from './recordsAgent';

/** One ruling, and the several ways a prompt might legitimately word it. */
interface Ruling {
  /** Where it came from, so a failure is traceable to the call that bought it. */
  readonly source: string;
  /** Every alternative must appear (AND); each alternative is a set of
   *  case-insensitive substrings of which ANY may match (OR). */
  readonly requires: readonly (readonly string[])[];
}

const SHARED: readonly Ruling[] = [
  {
    source: 'Standing instruction 10 (2026-08-13) — nobody is told to call back',
    requires: [
      ['wrong number', 'wrong extension', 'wrong department'],
      ['never say', 'do not say', "don't say"],
    ],
  },
  {
    source: 'Standing instruction 9 (2026-08-12) — no transfer on this line',
    requires: [['transfer'], ['not able to transfer', 'cannot transfer', 'no way to do it', 'never say you will put them through']],
  },
  {
    source: 'Standing instruction 7 — capability boundary, file a ticket instead',
    requires: [['call you back', 'callback', 'call back']],
  },
  {
    /**
     * Codex, PR #272 round 2. Tech's identity block read "one at a time, in
     * these words" while its language line said only "continue in their
     * language" — so a Spanish caller who triggered set_spoken_language could
     * still be asked for a last name and a date of birth in English, because
     * the more concrete instruction said to use those words. The other three
     * lanes had carried the qualifier since the language fix and tech had it
     * reverted for four characters of ceiling headroom; the restructure gave
     * the room back.
     *
     * Asserted here because this ruling had NO test at all — nothing stopped
     * a trim from dropping it on all four lanes at once, which is precisely
     * what this file exists to prevent.
     */
    source: 'Codex, 2026-09-05 (PR #272) — a translated call translates the quoted asks too',
    requires: [
      ['set_spoken_language'],
      ['shape, not a script', 'shapes to translate', 'not scripts to read'],
    ],
  },
  {
    /**
     * Operator ruling, 2026-09-03: when a caller asks for a representative the
     * agent says it cannot transfer AND that it will take a message and raise a
     * request for staff to follow up. Bought with three calls in twelve minutes
     * — two hangups inside 45 seconds, and one caller who stayed three and a
     * half minutes, said "release of information" twice, and got no ticket.
     *
     * Both halves are asserted. Saying only "I can't transfer you" is what the
     * prompt already did, and it is not what was asked for.
     */
    source: 'Operator, 2026-09-03 — asked for a representative: cannot transfer, AND a request is raised',
    requires: [
      ['not able to transfer calls', 'cannot transfer calls', 'unable to transfer calls'],
      ['take a message'],
      ['put in a request', 'raise a request', 'request for'],
    ],
  },
  {
    /**
     * The same ruling's negative half. On CA2accdcbf (records, 2026-09-03
     * 20:43) the agent improvised "all of our agents are currently busy — I can
     * have the team contact you as soon as they become available", which is a
     * person the caller then waits for. The prompt forbade the OUTCOME but
     * never named the sentence, so the model routed around it.
     */
    source: 'Operator, 2026-09-03 — never imply a human is about to become free',
    requires: [
      ['never imply', 'do not imply'],
      ['currently busy'],
      ['available'],
    ],
  },
  {
    /**
     * Operator ruling, 2026-09-03:
     *
     *   *"We are not proactively structuring the conversation. On any
     *   validation we should lead... May I please have your last name? May I
     *   please have your date of birth? And when you ask for date of birth it
     *   should say starting with the month, the day, and then the year. This
     *   way you can get it in the way you want it. It's kind of a guard. If
     *   you just say can I have your date of birth, people give it to you in
     *   any format they want."*
     *
     * Both halves are asserted, and the ORDER half is the one worth the test.
     * Every date-of-birth fix that day — separators, sentences in place of
     * dates, two-digit centuries — widened what the parser accepts after the
     * fact. Naming the order in the question narrows what arrives, and a
     * mutation dropping it from one lane's prompt passed everything else.
     */
    source: 'Operator, 2026-09-03 — lead the ask, and name the date order in the question',
    requires: [
      ['may i please have'],
      ['last name'],
      ['starting with the month'],
      ['then the day', 'the day, then the year'],
    ],
  },
  {
    source: 'Standing instruction 12 — confirm the callback number BEFORE filing',
    requires: [['before you file', 'before the ticket', 'BEFORE you file']],
  },
  {
    source: 'Operator, 2026-08-13 — never ask a patient where our offices are',
    requires: [['never ask', 'do not ask'], ['office', 'city']],
  },
  {
    source: 'Voice channel — nothing spoken may contain markup',
    requires: [['markdown', 'asterisk', 'bullet']],
  },
  {
    source: 'Never invent a detail on a ticket',
    requires: [['do not guess', "don't guess", 'never file a ticket with a detail you invented', 'do not invent']],
  },
  {
    source: 'A tool asking for a field is not a fault to narrate at the caller',
    requires: [['technical problem', 'system issue', 'not a fault']],
  },
];

/**
 * MEDICAL SAFETY IS NOT SHARED, AND THAT IS THE FINDING.
 *
 * Extending this file to optical and records on 2026-09-03 was supposed to be
 * bookkeeping. It failed instead: neither prompt says anything about not giving
 * medical advice. Surgery and tech both do.
 *
 * That is issue #53 — the queue lanes have no medical-safety guardrail of any
 * kind, on either pipeline, and on these two lanes the prompt is not carrying
 * it either. It is asserted below only where it actually exists, because a test
 * that asserted it everywhere would have to be made to pass by inventing
 * clinical wording nobody has ruled on. Escalated to the operator, not guessed.
 */
const MEDICAL_SAFETY: Ruling = {
  source: 'Medical safety — no diagnosis, no medication advice (#53: the prompt IS the guardrail on queue lanes)',
  requires: [['medical advice', 'do not give medical', 'not tell anyone whether']],
};

const SURGERY_ONLY: readonly Ruling[] = [
  {
    source: 'Emergency handling — curtain/shadow/flashes/severe pain go to 911',
    requires: [['911', 'emergency care'], ['urgent']],
  },
  {
    source: 'This queue is ASSIGNED BY SURGEON (2026-08-17: 66 of 74 filed unrouted)',
    requires: [['surgeon']],
  },
  {
    source: 'Do NOT pass last_provider — it is often the optometrist, and it overrides the record',
    requires: [['last_provider']],
  },
];

/**
 * RECORDS HAD NO PINNED RULINGS AT ALL, AND IT IS THE LANE WITH THE MOST
 * DOMAIN RULES IN ITS PROMPT.
 *
 * Written BEFORE trimming records from 1,907 tokens, deliberately in that
 * order: a trim is exactly the operation that drops a ruling quietly, and
 * SHARED alone would not have noticed any of these going. Every one is
 * something the records team or the law needs and no other lane has.
 *
 * It earned itself immediately. The trim's first draft wrapped "records have
 * been sent" across a line break, which reads fine and is invisible to a
 * substring check — the same way a line break once split "currently busy".
 */
const RECORDS_ONLY: readonly Ruling[] = [
  {
    /**
     * The one field the filing tool refuses without. A patient asking for
     * their own records starts a clock the practice must report on; a health
     * plan or an attorney asking does not, and nobody can reconstruct which it
     * was after the call.
     */
    source: 'Records — WHO IS ASKING, in what capacity, is required before filing',
    requires: [
      ['are you the patient', "on someone's behalf", 'on someone', 'behalf'],
      ['capacity', 'parent', 'attorney', 'health plan', 'power of attorney'],
    ],
  },
  {
    source: 'Records — the caller may not be the patient; take both sets of details',
    requires: [['may not be the patient', "caller's details separately", 'patient themselves']],
  },
  {
    source: 'Records — never read anything from a record back to anyone',
    requires: [['do not read', 'you do not read', 'never read'], ['diagnosis']],
  },
  {
    source: 'Records — where they go and which dates, for a patient asking for their own',
    requires: [['where should these be sent', 'where it goes', 'where they go'], ['dates']],
  },
  {
    /**
     * The counterweight to the two required fields above, and part of the same
     * ruling: the tool refuses without an ANSWER, not without a good one. A
     * caller must never be interrogated or turned away over a detail they
     * genuinely do not have.
     */
    source: 'Records — an answer is all that is needed, not a good one; ask once',
    requires: [['ask once', 'never interrogate', 'not a good one']],
  },
  {
    source: 'Records — a wrong fax number sends a chart to a stranger; read it back digit by digit',
    requires: [['digit by digit'], ['fax']],
  },
  {
    source: 'Records — never say records have been sent, and never promise a date',
    requires: [['have been sent', 'were already sent'], ['do not promise', 'not promise a date']],
  },
];

const TECH_ONLY: readonly Ruling[] = [
  {
    source: 'Running out of glaucoma drops is not routine',
    requires: [['glaucoma']],
  },
];

function check(prompt: string, rulings: readonly Ruling[], label: string) {
  describe(label, () => {
    for (const ruling of rulings) {
      it(`still expresses: ${ruling.source}`, () => {
        const hay = prompt.toLowerCase();
        for (const alternatives of ruling.requires) {
          const hit = alternatives.some((a) => hay.includes(a.toLowerCase()));
          expect(hit, `none of ${JSON.stringify(alternatives)} appear in the prompt`).toBe(true);
        }
      });
    }
  });
}

/**
 * THE CLOCK IS PINNED, AND IT IS PINNED TO THE WIDEST RENDERING THERE IS.
 *
 * Every queue prompt embeds `getPacificTimeContext()`, and that block is
 * VARIABLE WIDTH: the weekday appears twice, the month once, the date is one
 * or two digits, and `timeStr` appears twice. So the measured length of a
 * prompt depends on the day the suite happens to run.
 *
 * THIS IS NOT HYPOTHETICAL. The recognised-arm ratchets below were pinned on
 * 2026-09-15, a Tuesday, and on Wednesday 2026-09-16 all three failed by
 * EXACTLY ONE TOKEN — "Wednesday" is one character longer than "Tuesday",
 * twice over. The slack guard failed the same morning by exactly one
 * character. Nothing in any prompt had changed. Reproduced on a pristine
 * checkout before touching anything, which is the only way to tell the
 * calendar from the diff (CLAUDE.md's v32 row records the same lesson from
 * `schedulingReachesTheHub.test.ts`).
 *
 * The comment above the slack guard already warned that "'Wednesday' instead
 * of 'Saturday' would have failed this suite on the calendar rather than on
 * the diff" — and then the v29 ratchets were added without that protection.
 * A guard whose warning is written down and not applied is how this happens.
 *
 * Swept every hour of a year against the real formatter: the widest the block
 * ever renders is 111 characters, at a Wednesday in September with a
 * two-digit date and a two-digit twelve-hour clock —
 *
 *   Current Pacific Coast Time: Wednesday, September 16, 2026 at 12:59 AM
 *   Today is Wednesday.
 *   The time is 12:59 AM.
 *
 * Pinning THERE rather than at an arbitrary instant makes every number below
 * both reproducible AND worst-case: a prompt that fits here fits on every day
 * of the year. September is inside PDT (UTC-7), so 12:59 AM Pacific is 07:59
 * UTC.
 *
 * Set at module scope on purpose — the prompts on the next lines are built
 * when this module is evaluated, so a `beforeAll` would run far too late.
 */
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(new Date('2026-09-16T07:59:00.000Z'));

const surgery = buildSurgeryPrompt({ callerPhone: '+17605551234' });
const tech = buildTechPrompt({ callerPhone: '+17605551234' });
/**
 * Optical and records carry the same shared rulings and were not covered here
 * at all — the file was written alongside the surgery/tech trim. Optical is the
 * lane with the most substantive calls today and records is the one that lost a
 * request to the improvisation the ruling above now forbids, so neither is a
 * lane where a silently dropped ruling would be noticed by anything else.
 */
const optical = buildOpticalPrompt({ callerPhone: '+17605551234' });
const records = buildRecordsPrompt({ callerPhone: '+17605551234' });

check(surgery, [...SHARED, MEDICAL_SAFETY, ...SURGERY_ONLY], 'surgery prompt keeps every ruling');
check(tech, [...SHARED, MEDICAL_SAFETY, ...TECH_ONLY], 'tech prompt keeps every ruling');
check(optical, SHARED, 'optical prompt keeps every ruling');
check(records, [...SHARED, ...RECORDS_ONLY], 'records prompt keeps every ruling');

/**
 * THE MUTATION GUARD FOR THE RULING ABOVE, stated as the defect rather than
 * the fix. "in this shape" is one way to say it and a future rewording is
 * fine; telling the model to use a quoted English question VERBATIM is not,
 * on any lane, because it outranks a general "continue in their language".
 */
describe('no queue prompt pins a quoted ask to English', () => {
  for (const [name, prompt] of [
    ['surgery', surgery],
    ['tech', tech],
    ['optical', optical],
    ['records', records],
  ] as const) {
    it(`${name} does not instruct verbatim wording`, () => {
      expect(prompt, `${name} says "in these words" above a quoted ask`).not.toMatch(
        /in these (?:exact )?words/i,
      );
    });
  }
});

describe('the trim actually happened', () => {
  /**
   * A ceiling, not a target. Surgery was ~2,636 prompt tokens on 2026-09-03
   * with `# HOW A CALL RUNS` alone running 87 of its 158 lines — six times
   * tech's version of the same section. If it creeps back, this fails and
   * somebody has to justify it rather than discovering it a fortnight later.
   */
  it('surgery stays under 1,800 prompt tokens', () => {
    expect(Math.round(surgery.length / 4)).toBeLessThan(1800);
  });

  it('tech stays under 1,600 prompt tokens', () => {
    expect(Math.round(tech.length / 4)).toBeLessThan(1600);
  });

  /**
   * THESE CEILINGS ARE CLOCK-DEPENDENT, AND TECH'S ONCE HAD FOUR CHARACTERS
   * IN IT.
   *
   * Every queue prompt embeds `getPacificTimeContext()`, whose weekday, date
   * and time are variable width — and `timeStr` appears TWICE in that block,
   * so a minute's difference can move the prompt by two characters.
   *
   * The history is why this guard exists rather than a bare length check.
   * Tech rendered at 6,332 with 66 characters of slack, and a sixteen-token
   * language fix (Codex, 2026-09-05) took it to 6,395 — FOUR characters — at
   * which point "Wednesday" instead of "Saturday" would have failed this
   * suite on the calendar rather than on the diff. That fix was reverted on
   * tech and kept on the three lanes with real slack.
   *
   * Restructuring all four prompts to xAI's recommended section order bought
   * the room back: tech fell to 6,242, so the language fix went in on tech
   * too (PR #272 round 2) and it still holds 65 characters. Whoever eats that
   * should buy tech room, not raise the number.
   *
   * This test asserts the SLACK rather than the length, so a future prompt
   * that eats it fails here with the reason attached.
   */
  /**
   * THE PIN ITSELF, ASSERTED.
   *
   * Every length below is only worst-case while the fake clock is actually in
   * effect. Drop the `vi.setSystemTime` at the top of this file and the
   * ratchets keep passing on most days — they measure a SMALLER prompt — and
   * then fail on the one day of the week nobody is looking. That is the exact
   * failure this pin exists to remove, so the pin gets its own assertion
   * rather than being trusted.
   */
  it('is measuring the widest clock, not whatever day the suite ran on', () => {
    expect(tech).toContain('Wednesday, September 16, 2026 at 12:59 AM');
    expect(tech).toContain('Today is Wednesday.');
    expect(tech).toContain('The time is 12:59 AM.');
  });

  it('tech keeps enough slack that the clock cannot fail the ceiling', () => {
    // Math.round(len / 4) reaches 1600 at 6398, so 6398 is the first failing
    // length — NOT 1600 * 4, which this used and which was two characters
    // optimistic about the room left.
    const boundary = 6398;
    const slack = boundary - tech.length;
    // GREATER THAN ZERO, not greater than 20, and that is STRONGER rather
    // than weaker. The 20 was a cushion for clock swing, guessed at. The
    // clock is now pinned to its widest rendering of the year (see the top of
    // this file), so there is no swing left to absorb: a prompt that fits
    // here fits on every day of the year, and the cushion has moved from a
    // guess into the fixture. Whoever eats the remaining room should buy tech
    // room, not raise the number.
    expect(slack, `tech has only ${slack} characters of slack at the widest clock`).toBeGreaterThan(0);
  });

  /**
   * WHAT THE CEILING DOES NOT MEASURE, recorded because it is invisible here.
   *
   * On the runtime the transport appends `GREETING_ALREADY_PLAYED` — 272
   * characters, about 68 tokens — to whatever the lane's prompt says. So the
   * instructions Grok actually receives on tech are ~1,667 tokens, not the
   * 1,583 this file guards. The ceilings above are BASE-prompt ceilings and
   * always were; nothing is violated, but nobody reading them would know the
   * as-sent figure is higher, and it is the as-sent figure that costs
   * latency.
   *
   * Asserted so the gap is a number somebody has to update deliberately
   * rather than a fact that has to be rediscovered.
   */
  it('records what the runtime actually sends, over and above the ceiling', () => {
    expect(GREETING_ALREADY_PLAYED.length).toBe(272);
    const asSent = Math.round((tech.length + GREETING_ALREADY_PLAYED.length) / 4);
    expect(asSent).toBeGreaterThan(1600); // the base ceiling is not the wire
    expect(asSent).toBeLessThan(1700);
  });

  /**
   * OPTICAL AND RECORDS HAD NO CEILING AT ALL until 2026-09-03, which is how
   * records became the fattest prompt in the fleet at 1,907 tokens while
   * surgery — the one everybody watched — sat at 1,268.
   *
   * Operator, 2026-09-03: *"grok requires minimal prompting, we should not be
   * near our ceilings."* Records trimmed to 1,679 the same afternoon; the
   * headroom here is deliberately as tight as tech's, because tech's is the
   * one that has actually caught something.
   */
  it('optical stays under 1,500 prompt tokens', () => {
    expect(Math.round(optical.length / 4)).toBeLessThan(1500);
  });

  it('records stays under 1,750 prompt tokens', () => {
    expect(Math.round(records.length / 4)).toBeLessThan(1750);
  });
});

/**
 * THE CEILINGS ABOVE MEASURE THE PROMPT NOBODY IS RECOGNISED ON.
 *
 * Every constant above is built with `{ callerPhone }` and no `precontext`,
 * so `pc` is undefined and `recognisedCallerBlock` / `identityAskScript` /
 * `identityCertainMeaning` all emit their COLD arm. The recognised arm is
 * strictly larger — it adds the whole recognition block — and until this
 * block existed nothing measured it at all.
 *
 * Measured 2026-09-15, the recognised arm costs a uniform +342 tokens, and
 * THREE OF FOUR LANES ARE ALREADY PAST THE OPERATOR'S CEILING ON IT:
 *
 *   lane      ceiling   cold   recognised   over by
 *   surgery      1800   1298         1652   -- inside
 *   tech         1600   1594         1948        348
 *   optical      1500   1385         1739        239
 *   records      1750   1697         2051        301
 *
 * THOSE THREE NUMBERS WERE RAISED ONCE, DELIBERATELY, AND THIS IS THE RECORD
 * OF IT. They were first pinned at 1936 / 1727 / 2040. Codex's round-2 P1 on
 * #311 showed the recognised arm keyed its exception on a `candidate_count`
 * field that two of the three ambiguous lookup shapes do not carry, so a
 * genuinely ambiguous match read as a single one. Correcting it to key on the
 * tool's warning cost ~12 tokens per lane. The ratchet went red, which is the
 * ratchet working; it is raised here with the reason rather than quietly
 * relaxed. Correctness over twelve tokens, on an arm already 200-350 over.
 *
 * THIS IS NOT A v29 REGRESSION. The block was inline in all four agents long
 * before it moved into the runtime; v27 and v28 each added to that arm, and
 * v29 adds ~10 tokens more, but the bulk predates all three. What is new is
 * that anybody can see it.
 *
 * WHY IT MATTERS MORE THAN THE NUMBER LOOKS: tasks #88 and #110 exist to make
 * pre-context recognise MOST callers (135 of 170 are on file). Succeeding
 * there moves nearly every call onto the arm that busts the ceiling — so the
 * better pre-context gets, the more often we serve the oversized prompt.
 *
 * THESE ARE RATCHETS, NOT CEILINGS, AND THAT IS DELIBERATE. Lowering the
 * recognised arm to the operator's stated numbers means deleting capability
 * from it, which is his call under standing instruction 1 and a
 * `docs/BACKEND_HANDOFF.md` change — not something a test should decide. So
 * today's measured values are pinned: they may not GROW without somebody
 * justifying it, which is what the ceiling block above says it exists for.
 * Surgery is the exception and keeps its real ceiling, because it still fits.
 */
describe('the recognised-caller prompt is measured too', () => {
  const PC = { matched: true, firstName: 'Casey' } as const;
  const meta = { callerPhone: '+17605551234', precontext: PC } as never;
  const warm = {
    surgery: Math.round(buildSurgeryPrompt(meta).length / 4),
    tech: Math.round(buildTechPrompt(meta).length / 4),
    optical: Math.round(buildOpticalPrompt(meta).length / 4),
    records: Math.round(buildRecordsPrompt(meta).length / 4),
  };

  it('surgery still fits its real ceiling when the caller is recognised', () => {
    expect(warm.surgery).toBeLessThan(1800);
  });

  // Ratchets at the WORST-CASE clock, re-measured 2026-09-16 under the pin at
  // the top of this file. Each is exactly one token above the 2026-09-15
  // value it replaces, and that one token is the weekday, not a prompt
  // change — these numbers now describe the widest day of the year rather
  // than whichever day the suite ran on. Going UP fails; going down is always
  // welcome and the number should be lowered when it does.
  //
  // RAISED ONCE MORE ON 2026-09-17 FOR v54 (+24 tokens per lane): the YES
  // bullet of the recognised-caller block now tells the model to call
  // lookup_patient with the affirmed first name, which is what lets a phone
  // that carries several people resolve to the one who answered — all 26
  // recognised-caller date-of-birth refusals on 09-16 were that shape. The
  // ratchet went red, which is the ratchet working; it is raised with the
  // reason rather than quietly relaxed, as the v29 raise above was.
  for (const [lane, baseline] of [
    ['tech', 1973],
    ['optical', 1764],
    ['records', 2076],
  ] as const) {
    it(`${lane}'s recognised prompt does not grow past ${baseline} tokens`, () => {
      expect(warm[lane]).toBeLessThanOrEqual(baseline);
    });
  }

  it('the recognised arm is measurably larger than the cold one on every lane', () => {
    // The guard above this one is worthless if `precontext` stops reaching
    // the block — the warm build would silently equal the cold build and
    // every ratchet would pass while measuring nothing. This is the check
    // that the arm under test is actually the recognised one.
    expect(warm.surgery).toBeGreaterThan(Math.round(surgery.length / 4));
    expect(warm.tech).toBeGreaterThan(Math.round(tech.length / 4));
    expect(warm.optical).toBeGreaterThan(Math.round(optical.length / 4));
    expect(warm.records).toBeGreaterThan(Math.round(records.length / 4));
  });

  it('neither prompt carries a war story — those belong in code comments', () => {
    // "a war story is not an instruction" — surgeryAgent.ts's own comment,
    // written while the prompt beside it carried three.
    for (const [name, p] of [['surgery', surgery], ['tech', tech]] as const) {
      expect(p, `${name} still cites a dated incident`).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
      expect(p, `${name} still quotes a call count`).not.toMatch(/\b\d+ of \d+ filed\b/);
    }
  });
});
