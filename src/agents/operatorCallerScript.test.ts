import { describe, expect, it } from "vitest";
import { OPERATOR_GREETING, openingFromScript, operatorInstructions, operatorOpening } from "./operatorLineAgent";
import { parseOperatorPayload, type OperatorCallPayload } from "../plugin/operatorLine";

/**
 * v158 — CA e8113f… (session 2226ee26, 2026-10-31 08:38 ET) was given a
 * Benchmark Tester callerScript and still opened "Hello, I'm Grok Bot ...
 * calling on behalf of Wayne Fabian". The script now drives persona + opening.
 */
const SCRIPT = `You are Benchmark Tester, a QA caller from the voice benchmark team.
Opening: "Hi, this is Benchmark Tester calling to run a quick voice benchmark. Do you have two minutes?"
Ask three short questions and thank them.`;
const base: OperatorCallPayload = { callKind: "operator", phone: "+19094795435", purpose: "Run the voice benchmark.", initiated_by: "owner_request", maxDurationSec: 600 };
const env = { OPERATOR_LINE_MAX_CALL_MINUTES: "60" };

describe("v158 operator callerScript drives persona and opening", () => {
  it("accepts callerScript and openingLine through the operator payload", () => {
    const parsed = parseOperatorPayload({ phone: base.phone, purpose: base.purpose, callerScript: ` ${SCRIPT} `, openingLine: "Hi there." }, env);
    expect(parsed).toMatchObject({ ok: true, payload: { callerScript: SCRIPT, openingLine: "Hi there." } });
    expect(parseOperatorPayload({ phone: base.phone, purpose: base.purpose, callerScript: "" }, env).ok).toBe(false);
    expect(parseOperatorPayload({ phone: base.phone, purpose: base.purpose, callerScript: 5 }, env).ok).toBe(false);
  });

  it("script given: opening and persona come from the script", () => {
    const call = { ...base, callerScript: SCRIPT };
    expect(operatorOpening(call)).toBe("Hi, this is Benchmark Tester calling to run a quick voice benchmark. Do you have two minutes?");
    const text = operatorInstructions(call);
    expect(text).toContain("Caller script/persona");
    expect(text).toContain("You are Benchmark Tester");
    expect(text).toContain(base.purpose);
    expect(text).not.toContain("You are Grok Bot, an AI assistant on Wayne Fabian's operator line");
    expect(text).not.toContain("The greeting has already disclosed");
    expect(text).toContain("end_call immediately");
  });

  it("reads a quoted line, then the first line, when no Opening: label exists", () => {
    expect(openingFromScript('Persona: tester.\nStart with "Good morning, this is the benchmark line."')).toBe("Good morning, this is the benchmark line.");
    expect(openingFromScript("Hello, this is Sam from the test team.\nThen ask about latency.")).toBe("Hello, this is Sam from the test team.");
  });

  it("a labelled quoted opening speaks only the quote, not trailing directions", () => {
    expect(openingFromScript('You are Benchmark Tester.\nOpening: "Hi, this is Benchmark Tester." Wait for a reply.')).toBe("Hi, this is Benchmark Tester.");
  });

  it.each([
    ['Opening: Hi, please say "ready" when you can hear me.', 'Hi, please say "ready" when you can hear me.'],
    ["Opening: 'Hi, this is Benchmark Tester.' Wait for a reply.", "Hi, this is Benchmark Tester."],
    ["Opening: \u201CHi, it's Benchmark Tester.\u201D Pause.", "Hi, it's Benchmark Tester."],
  ])("labelled opening %j speaks %j", (script, spoken) => {
    expect(openingFromScript(script)).toBe(spoken);
  });

  it("openingLine without a script: instructions describe that opening, not the default disclosure", () => {
    const text = operatorInstructions({ ...base, openingLine: "Hi, do you have two minutes?" });
    expect(text).toContain('You already opened the call with: "Hi, do you have two minutes?"');
    expect(text).not.toContain("The greeting has already disclosed");
    expect(text).toContain("You are Grok Bot");
  });

  it("an explicit openingLine wins over the script", () => {
    expect(operatorOpening({ ...base, callerScript: SCRIPT, openingLine: "Hey, quick test call." })).toBe("Hey, quick test call.");
  });

  it("no script: default Grok Bot opening and persona", () => {
    expect(operatorOpening(base)).toBe(OPERATOR_GREETING);
    expect(operatorOpening(undefined)).toBe(OPERATOR_GREETING);
    const text = operatorInstructions(base);
    expect(text).toContain("You are Grok Bot");
    expect(text).not.toContain("Caller script/persona");
    expect(text).toContain(base.purpose);
  });
});
