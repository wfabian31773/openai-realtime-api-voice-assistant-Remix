/**
 * The parsing, the refusals, and the request shape.
 *
 * The request shape is pinned because xAI's schema is easy to get subtly
 * wrong — `values` takes objects with an aggregation, not bare strings, and
 * `timeUnit` is the prefixed enum. A wrong body returns a 400, which this
 * module correctly turns into "could not read", so the failure would look
 * like an outage rather than a bug.
 */
import { describe, it, expect } from "vitest";
import {
  readXaiBillingConfig,
  buildDailyUsageRequest,
  sumDailyUsage,
  fetchDailySpend,
  type FetchLike,
  parseInvoicePreview,
  type UnitComparison,
  compareBilledUnits,
  fetchInvoicePreview,
} from "./xaiBilling";

const SETUP = {
  configured: true as const,
  config: { baseUrl: "https://management-api.x.ai", managementKey: "mk-test", teamId: "team-1" },
};

const respond = (status: number, body: unknown): FetchLike =>
  async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

describe("configuration", () => {
  it("names BOTH missing variables, not just the first", () => {
    const setup = readXaiBillingConfig({});
    expect(setup.configured).toBe(false);
    if (!setup.configured) expect(setup.missing).toEqual(["XAI_MANAGEMENT_KEY", "XAI_TEAM_ID"]);
  });

  /**
   * The trap worth pinning: XAI_API_KEY is already set in this deployment and
   * cannot read billing. Having it must not make this look configured.
   */
  it("is NOT satisfied by the inference key that already exists", () => {
    // The team id is supplied, so ONLY the key question is under test — an
    // earlier version of this passed because teamId was missing too, and
    // would have let XAI_API_KEY quietly stand in for the management key.
    expect(
      readXaiBillingConfig({ XAI_API_KEY: "xai-live-key", XAI_TEAM_ID: "team-1" }).configured,
    ).toBe(false);
  });

  it("treats whitespace as unset", () => {
    expect(readXaiBillingConfig({ XAI_MANAGEMENT_KEY: "   ", XAI_TEAM_ID: "t" }).configured).toBe(false);
  });

  it("defaults to the management host, which is not the inference host", () => {
    const setup = readXaiBillingConfig({ XAI_MANAGEMENT_KEY: "k", XAI_TEAM_ID: "t" });
    expect(setup.configured).toBe(true);
    if (setup.configured) {
      expect(setup.config.baseUrl).toBe("https://management-api.x.ai");
      expect(setup.config.baseUrl).not.toContain("//api.x.ai");
    }
  });

  it("strips a trailing slash so the path does not double up", () => {
    const setup = readXaiBillingConfig({
      XAI_MANAGEMENT_KEY: "k", XAI_TEAM_ID: "t",
      XAI_MANAGEMENT_BASE_URL: "https://example.test/",
    });
    if (setup.configured) expect(setup.config.baseUrl).toBe("https://example.test");
  });
});

describe("the request xAI actually accepts", () => {
  it("uses the prefixed enum and an aggregation object, not the shorthand", () => {
    const body = buildDailyUsageRequest("2026-09-03") as any;
    expect(body.analyticsRequest.timeUnit).toBe("TIME_UNIT_DAY");
    expect(body.analyticsRequest.values).toEqual([{ name: "usd", aggregation: "AGGREGATION_SUM" }]);
    expect(body.analyticsRequest.groupBy).toEqual(["description"]);
  });

  it("covers the whole day", () => {
    const body = buildDailyUsageRequest("2026-09-03") as any;
    expect(body.analyticsRequest.timeRange.startTime).toBe("2026-09-03 00:00:00");
    expect(body.analyticsRequest.timeRange.endTime).toBe("2026-09-03 23:59:59");
    expect(body.analyticsRequest.timeRange.timezone).toBe("UTC");
  });
});

describe("reading a day's spend out of the response", () => {
  it("sums every point of the VOICE series", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [
        { groupLabels: ["grok-voice-think-fast-2.0"], dataPoints: [{ values: [30.5] }, { values: [3.18] }] },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.totalUsd).toBeCloseTo(33.68, 6);
  });

  /**
   * THE ONE THAT MATTERS (Codex, PR #268). The team's text inference is not
   * this runtime's phone calls. Summing it would allocate someone else's
   * grok-4 batch job across the day's callers and mark every one of those
   * rows reconciled at an inflated price — an authoritative-looking wrong
   * number, which is strictly worse than the honest estimate it replaced.
   */
  it("EXCLUDES non-voice spend rather than allocating it across phone calls", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [
        { groupLabels: ["grok-voice-think-fast-2.0"], dataPoints: [{ values: [33.68] }] },
        { groupLabels: ["grok-4"], dataPoints: [{ values: [420.0] }] },
        { groupLabels: ["grok-4-fast-reasoning"], dataPoints: [{ values: [12.5] }] },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.totalUsd).toBeCloseTo(33.68, 6);
      expect(out.value.lines).toHaveLength(1);
      // What was excluded is reported, not silently dropped.
      expect(out.value.ignored.map((l) => l.description)).toEqual(["grok-4", "grok-4-fast-reasoning"]);
    }
  });

  /**
   * A rename must not read as a free day. Allocating $0 would mark every
   * call reconciled at nothing, silently — the exact class of failure this
   * module is built to refuse.
   */
  it("REFUSES when no line matches the voice model, and names what did come back", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [{ groupLabels: ["grok-4"], dataPoints: [{ values: [9.0] }] }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("grok-voice");
      expect(out.reason).toContain("grok-4");
    }
  });

  /**
   * A response we cannot read is not a free day (Codex, PR #268 round 4).
   * Skipping invalid points is right; skipping ALL of them and calling the
   * result $0 writes zero to every call and marks them reconciled — an
   * unreadable billing response presented, permanently, as authoritative.
   */
  it("REFUSES a voice series whose points carry no readable amount", () => {
    for (const dataPoints of [[], [{ values: [] }], [{ values: [null as any] }]]) {
      const out = sumDailyUsage("2026-09-03", {
        timeSeries: [{ groupLabels: ["grok-voice-think-fast-2.0"], dataPoints }],
      });
      expect(out.ok, JSON.stringify(dataPoints)).toBe(false);
      if (!out.ok) expect(out.reason).toContain("no readable amount");
    }
  });

  it("still accepts a voice series with SOME bad points and at least one good", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [
        {
          groupLabels: ["grok-voice-think-fast-2.0"],
          dataPoints: [{ values: [null as any] }, { values: [7.5] }],
        },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.totalUsd).toBe(7.5);
  });

  it("does not refuse over an unreadable NON-voice series", () => {
    // Someone else's broken line is not our problem — it is excluded anyway.
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [
        { groupLabels: ["grok-voice-2"], dataPoints: [{ values: [3] }] },
        { groupLabels: ["grok-4"], dataPoints: [] },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.totalUsd).toBe(3);
  });

  it("accepts a genuine zero — a real number that happens to be 0", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [{ groupLabels: ["grok-voice-2"], dataPoints: [{ values: [0] }] }],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.totalUsd).toBe(0);
  });

  it("takes a different needle when the model is renamed", () => {
    const out = sumDailyUsage(
      "2026-09-03",
      { timeSeries: [{ groupLabels: ["grok-speech-3"], dataPoints: [{ values: [5] }] }] },
      "grok-speech",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.totalUsd).toBe(5);
  });

  /**
   * A truncated series is not a total. Summing it would hand the reconciler a
   * number that is quietly too small and it would allocate every call low.
   */
  it("REFUSES a truncated series rather than under-reporting", () => {
    const out = sumDailyUsage("2026-09-03", {
      limitReached: true,
      timeSeries: [{ groupLabels: ["x"], dataPoints: [{ values: [1] }] }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("too low");
  });

  it("refuses a response with no series at all instead of calling it zero", () => {
    expect(sumDailyUsage("2026-09-03", {}).ok).toBe(false);
    expect(sumDailyUsage("2026-09-03", null).ok).toBe(false);
  });

  it("ignores a non-numeric value rather than turning the total into NaN", () => {
    const out = sumDailyUsage("2026-09-03", {
      timeSeries: [
        { groupLabels: ["grok-voice-2"], dataPoints: [{ values: [2] }, { values: [null as any] }] },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.totalUsd).toBe(2);
  });

  it("labels an ungrouped series rather than dropping it", () => {
    const out = sumDailyUsage("2026-09-03", { timeSeries: [{ dataPoints: [{ values: [5] }] }] });
    // Ungrouped is not identifiable as voice, so it is refused, not summed —
    // and the reason names it so the grouping can be fixed.
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("(ungrouped)");
  });
});

describe("fetching, and every way it can decline", () => {
  it("says which variables to set, and that the inference key will not do", async () => {
    const out = await fetchDailySpend("2026-09-03", { setup: { configured: false, missing: ["XAI_TEAM_ID"] } });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("XAI_TEAM_ID");
      expect(out.reason).toContain("Management Keys");
      expect(out.reason).toContain("NOT the same credential");
    }
  });

  it("sends the bearer token to the team's usage path", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const spy: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization ?? "";
      return { ok: true, status: 200, text: async () => JSON.stringify({ timeSeries: [] }) };
    };
    await fetchDailySpend("2026-09-03", { setup: SETUP, fetchImpl: spy });
    expect(seenUrl).toBe("https://management-api.x.ai/v1/billing/teams/team-1/usage");
    expect(seenAuth).toBe("Bearer mk-test");
  });

  /** A billing error body can echo account details; only the status travels. */
  it("reports the status of a rejection and never its body", async () => {
    const out = await fetchDailySpend("2026-09-03", {
      setup: SETUP,
      fetchImpl: respond(403, { error: "team acct-99887766 is not authorized" }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("403");
      expect(out.reason).not.toContain("acct-99887766");
    }
  });

  it("does not throw when the network is down", async () => {
    const out = await fetchDailySpend("2026-09-03", {
      setup: SETUP,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("unreachable");
  });

  it("does not throw on a body that is not JSON", async () => {
    const out = await fetchDailySpend("2026-09-03", {
      setup: SETUP,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>gateway</html>" }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not JSON");
  });
});

// ─── invoice/preview ─────────────────────────────────────────────────────────

describe('parseInvoicePreview', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    description: 'grok-voice-think-fast-2.0',
    unitType: 'minutes',
    unitPrice: 0.08,
    numUnits: 418.6,
    amount: 33.49,
    ...over,
  });

  it('reads the fields the endpoint exists for', () => {
    const r = parseInvoicePreview({ lineItems: [line()] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lines[0]).toMatchObject({ unitType: 'minutes', numUnits: 418.6, unitPrice: 0.08 });
  });

  it.each(['lineItems', 'lines', 'items'])('accepts the array under %s', (key) => {
    expect(parseInvoicePreview({ [key]: [line()] }).ok).toBe(true);
  });

  it('accepts numeric strings, which billing APIs return for money', () => {
    const r = parseInvoicePreview({ lineItems: [line({ numUnits: '418.6', unitPrice: '0.08' })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0].numUnits).toBe(418.6);
  });

  /**
   * The whole point of the endpoint is a number. A line we cannot read has no
   * answer in it, and defaulting to 0 would look exactly like one — the same
   * reasoning as "no voice line is not zero" in sumDailyUsage.
   */
  it('REFUSES a line whose numUnits cannot be read, rather than defaulting it', () => {
    const r = parseInvoicePreview({ lineItems: [line({ numUnits: null })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cannot read');
  });

  it('refuses when no line matches the voice needle, and names what came back', () => {
    const r = parseInvoicePreview({ lineItems: [line({ description: 'grok-4-text' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('grok-4-text');
  });

  it('refuses a body with no line items at all', () => {
    expect(parseInvoicePreview({}).ok).toBe(false);
  });

  /**
   * Parsing runs AFTER request()'s try/catch, so a throw here would escape
   * fetchInvoicePreview's never-throws contract rather than being reported.
   */
  it.each([null, 'a string', 42, []])('refuses a %s line item without throwing', (entry) => {
    let r: ReturnType<typeof parseInvoicePreview>;
    expect(() => { r = parseInvoicePreview({ lineItems: [entry] }); }).not.toThrow();
    expect(r!.ok).toBe(false);
  });
});

describe('compareBilledUnits — the question five rounds of review could not settle', () => {
  const OUR_SECONDS = 25_116; // 2026-09-03, the reconciled day: 418.6 minutes
  const ALIGNED = { ourPeriod: '2026-09-03', periodVerifiedAligned: true };
  const UNALIGNED = { ourPeriod: '2026-09-03', periodVerifiedAligned: false };
  const MINUTES = { unitType: 'minutes', unitPrice: 0.08, numUnits: 418.6, amountUsd: 33.49, description: 'grok-voice' };

  it('xAI counted OUR minutes -> the duration is not the gap', () => {
    const c = compareBilledUnits(
      { unitType: 'minutes', unitPrice: 0.08, numUnits: 418.6, amountUsd: 33.49, description: 'grok-voice' },
      OUR_SECONDS,
      ALIGNED,
    );
    expect(c.ratio).toBeCloseTo(1, 2);
    expect(c.verdict).toContain('rules out a gross duration difference');
    // The over-claim this replaced. Agreeing TOTALS cannot establish a
    // PER-CALL property: 1 and 119 minutes each billed as 60 preserves the
    // 120-minute total and breaks a duration-proportional split.
    expect(c.verdict).not.toContain('sound');
    expect(c.verdict).toContain('UNPROVEN');
  });

  it('every result carries the two things it cannot see', () => {
    const c = compareBilledUnits(MINUTES, OUR_SECONDS, ALIGNED);
    expect(c.caveats).toHaveLength(2);
    expect(c.caveats.join(' ')).toContain('totals only');
    expect(c.caveats.join(' ')).toContain('INDIVIDUAL call');
  });

  it('refuses to interpret a ratio when the period is not verified aligned', () => {
    const c = compareBilledUnits(MINUTES, OUR_SECONDS, UNALIGNED);
    expect(c.verdict).toContain('period alignment has not been verified');
    expect(c.verdict).toContain('UNPROVEN');
    expect(c.verdict).not.toContain('rules out');
    expect(c.caveats[0]).toContain('PERIOD ALIGNMENT NOT VERIFIED');
  });

  /**
   * The case that would invalidate the current allocation. 669.4 minutes is
   * the 418.6 we recorded plus a 63-second per-call minimum over 239 calls —
   * one concrete way the gap could be duration rather than rate.
   */
  it('xAI counted MORE than our minutes -> the per-second split is distributing it wrongly', () => {
    const c = compareBilledUnits(
      { unitType: 'minutes', unitPrice: 0.08, numUnits: 669.4, amountUsd: 53.55, description: 'grok-voice' },
      OUR_SECONDS,
      ALIGNED,
    );
    expect(c.ratio).toBeGreaterThan(1.5);
    expect(c.verdict).toContain('longer duration than Twilio reports');
    // It must NOT conclude the allocation is wrong. A uniform 1.5x on every
    // call gives this same aggregate ratio while a per-second split stays
    // exactly right; only a flat per-call minimum breaks it, and the
    // aggregate cannot tell them apart.
    expect(c.verdict).toContain('cannot say WHICH');
    expect(c.verdict).toContain('UNPROVEN');
  });

  it('a non-duration unit says the allocation denominator itself is wrong', () => {
    const c = compareBilledUnits(
      { unitType: 'audio_tokens', unitPrice: 0.000004, numUnits: 13_387_500, amountUsd: 53.55, description: 'grok-voice' },
      OUR_SECONDS,
      ALIGNED,
    );
    expect(c.ourUnits).toBeNull();
    expect(c.ratio).toBeNull();
    expect(c.verdict).toContain('not a duration');
    // And must not condemn the split on the unit label alone: audio tokens
    // accruing at a constant rate per second are recovered exactly by it.
    expect(c.verdict).not.toContain('do not split');
    expect(c.verdict).toContain('constant rate per second');
    expect(c.verdict).toContain('UNPROVEN');
  });

  /**
   * THE INVARIANT, over a GENERATED input space rather than a hand-written
   * list of branches.
   *
   * The previous version of this test listed the branches by hand, and the
   * bug it was written to catch — two early returns that skipped the caveat —
   * survived it, because the list omitted those same two. A list of branches
   * maintained by the person adding a branch is not a check on that person.
   *
   * So the cases are now the cross-product of every input DIMENSION that
   * `compareBilledUnits` reads: the unit type, the ratio it works out to, our
   * denominator, and whether the period is verified. A branch added later is
   * covered if it is reachable from these inputs, without anyone remembering
   * to add it here.
   *
   * The invariant also holds by construction now — the caveat is appended at
   * `compareBilledUnits`' single return and the wording functions cannot
   * append it — so this test's job is to catch a future return that bypasses
   * that site, not to enumerate today's branches.
   */
  it('NO verdict ever claims the per-call allocation is settled', () => {
    const unitTypes = ['minutes', 'min', 'seconds', 'sec', 'audio_tokens', 'tokens', 'requests', ''];
    // Chosen to straddle every threshold in findingFor: below 0.98, inside
    // the 0.98-1.02 band on both edges, and above 1.02.
    const unitCounts = [0, 1, 209.3, 410.2, 418.6, 427, 669.4, 25_116, 13_387_500];
    const ourSecondsValues = [0, 1, OUR_SECONDS];
    const periods = [ALIGNED, UNALIGNED];

    const cases: UnitComparison[] = [];
    for (const unitType of unitTypes) {
      for (const numUnits of unitCounts) {
        for (const ourSeconds of ourSecondsValues) {
          for (const period of periods) {
            cases.push(compareBilledUnits({ ...MINUTES, unitType, numUnits }, ourSeconds, period));
          }
        }
      }
    }

    expect(cases).toHaveLength(
      unitTypes.length * unitCounts.length * ourSecondsValues.length * periods.length,
    );
    // The space must actually reach every shape of outcome, or "all cases
    // pass" would be satisfiable by a space that exercises one branch.
    expect(cases.some((c) => c.ratio === null && c.ourUnits === null)).toBe(true); // non-duration
    expect(cases.some((c) => c.ratio === null && c.ourUnits !== null)).toBe(true); // zero denominator
    expect(cases.some((c) => c.ratio !== null && c.ratio > 1.02)).toBe(true);
    expect(cases.some((c) => c.ratio !== null && c.ratio < 0.98)).toBe(true);
    expect(cases.some((c) => c.ratio !== null && c.ratio >= 0.98 && c.ratio <= 1.02)).toBe(true);

    for (const c of cases) {
      expect(c.verdict, `verdict omits the allocation caveat: ${c.verdict}`).toContain('UNPROVEN');
      expect(c.verdict).not.toMatch(/allocation is (sound|correct|right)/i);
      // The caveat is appended once, at one site. Twice means a branch
      // appended it for itself as well.
      expect(c.verdict.match(/UNPROVEN/g)).toHaveLength(1);
    }
  });

  it('handles seconds as the unit', () => {
    const c = compareBilledUnits(
      { unitType: 'seconds', unitPrice: 0.00133, numUnits: 25_116, amountUsd: 33.49, description: 'grok-voice' },
      OUR_SECONDS,
      ALIGNED,
    );
    expect(c.ratio).toBeCloseTo(1, 3);
  });

  it('says so rather than dividing by zero when we recorded nothing', () => {
    const c = compareBilledUnits(
      { unitType: 'minutes', unitPrice: 0.08, numUnits: 10, amountUsd: 0.8, description: 'grok-voice' },
      0,
      ALIGNED,
    );
    expect(c.ratio).toBeNull();
    expect(c.verdict).toContain('nothing to compare');
    expect(c.verdict).toContain('UNPROVEN');
  });
});

describe('fetchInvoicePreview', () => {
  const setup = { configured: true as const, config: { baseUrl: 'https://management-api.x.ai', managementKey: 'k', teamId: 't' } };

  it('GETs the documented path with the management key', async () => {
    let seen: { url: string; init?: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: string, init?: Record<string, unknown>) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify({ lineItems: [
        { description: 'grok-voice-think-fast-2.0', unitType: 'minutes', unitPrice: 0.08, numUnits: 418.6, amount: 33.49 },
      ] }) };
    }) as never;
    const r = await fetchInvoicePreview({ setup, fetchImpl });
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe('https://management-api.x.ai/v1/billing/teams/t/postpaid/invoice/preview');
    expect(seen!.init!.method).toBe('GET');
    expect((seen!.init!.headers as Record<string, string>).Authorization).toBe('Bearer k');
    // A GET must not carry a body — some gateways reject one outright.
    expect(seen!.init!.body).toBeUndefined();
  });

  it('names the missing variables when unconfigured, and does not call out', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; throw new Error('should not be reached'); }) as never;
    const r = await fetchInvoicePreview({ setup: { configured: false, missing: ['XAI_MANAGEMENT_KEY'] }, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('XAI_MANAGEMENT_KEY');
    expect(called).toBe(false);
  });

  /** An error body from a billing endpoint can echo account details. */
  it('reports the status and never the body on an HTTP error', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403, text: async () => 'team_id=SECRET org=SECRET' })) as never;
    const r = await fetchInvoicePreview({ setup, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('403');
      expect(r.reason).not.toContain('SECRET');
    }
  });
});
