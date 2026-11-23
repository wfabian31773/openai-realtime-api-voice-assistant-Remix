import { describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import {
  ON_CALL_ACK_PATH,
  ON_CALL_STATUS_PATH,
  NO_TEXT_PARAM,
  PROVIDER_ACCEPTED_LINE,
  PROVIDER_ACCEPTED_NO_NUMBER_LINE,
  PROVIDER_ACK_FAILED_LINE,
  PROVIDER_ACK_FAILED_NO_TEXT_LINE,
  PROVIDER_ALREADY_TAKEN_LINE,
  PROVIDER_CALL_OPENING,
  PROVIDER_CALL_OPENING_NO_TEXT,
  PROVIDER_CLOSED_LINE,
  PROVIDER_TOO_LATE_LINE,
  PROVIDER_TOO_LATE_NO_TEXT_LINE,
  PROVIDER_DECLINED_LINE,
  acceptedWithNumberLine,
  ackReplyTwiml,
  ackResultOf,
  attemptIdFrom,
  handleOnCallAck,
  handleOnCallStatus,
  providerCallTwiml,
  spokenDigits,
  textedFlagFrom,
  type AckReply,
  type AckResult,
  type ProviderCallWebhookDeps,
} from "./providerCall";
import type { WebhookRequest } from "../voiceWebhook";

const AUTH_TOKEN = "test-auth-token";
const HOST = "voice.example.test";

/** A genuinely signed request, over the whole URL the runner signed. */
function req(
  path: string,
  query: string,
  body: Record<string, string>,
  over: { sign?: boolean; tamperQuery?: string } = {},
): WebhookRequest {
  const signedUrl = `https://${HOST}${path}${query}`;
  const signature =
    over.sign === false ? "not-a-real-signature" : twilio.getExpectedTwilioSignature(AUTH_TOKEN, signedUrl, body);
  return {
    headers: { host: HOST, "x-forwarded-proto": "https", "x-twilio-signature": signature },
    body,
    originalUrl: `${path}${over.tamperQuery ?? query}`,
  };
}

function deps(answer: AckReply | Error = "accepted") {
  const onProviderAck = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const onProviderStatus = vi.fn(async () => {});
  const log = vi.fn();
  const d: ProviderCallWebhookDeps = {
    env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
    runner: { onProviderAck, onProviderStatus },
    log,
  };
  return { d, onProviderAck, onProviderStatus, log };
}

describe("the call we place to a provider", () => {
  it("asks for a key press twice, and reports an empty result the second time", () => {
    const xml = providerCallTwiml(`https://${HOST}${ON_CALL_ACK_PATH}?attempt=7`, { textSent: true });
    const gathers = xml.match(/<Gather [^>]*>/g) ?? [];
    expect(gathers).toHaveLength(2);
    expect(gathers[0]).not.toMatch(/actionOnEmptyResult/);
    expect(gathers[1]).toMatch(/actionOnEmptyResult="true"/);
    for (const g of gathers) {
      expect(g).toContain(`action="https://${HOST}${ON_CALL_ACK_PATH}?attempt=7"`);
      expect(g).toMatch(/input="dtmf" numDigits="1"/);
    }
    expect(xml).toContain(PROVIDER_CALL_OPENING);
  });

  it("takes # as a key press like any other, so it never ends the gather empty", () => {
    // Twilio's default finishOnKey is "#": pressed with no digit before it,
    // the gather ends empty, and the second one reads that as a decline. The
    // opening says "press any key" (review of #514, round 10).
    const gathers = providerCallTwiml(`https://${HOST}${ON_CALL_ACK_PATH}?attempt=7`, { textSent: true }).match(/<Gather [^>]*>/g) ?? [];
    expect(gathers).toHaveLength(2);
    for (const g of gathers) expect(g).toContain('finishOnKey=""');
  });

  it("carries nothing about the patient", () => {
    const xml = providerCallTwiml(`https://${HOST}${ON_CALL_ACK_PATH}?attempt=7`, { textSent: true });
    // Only the fixed lines and the URL: no slot exists for a name, a number or a reason.
    const text = xml.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\d{3}[-. ]?\d{4}/);
    expect(text.replace(/\s+/g, " ").trim()).toBe(
      `${PROVIDER_CALL_OPENING} Press any key to take this patient.`,
    );
  });

  it("escapes the ack URL", () => {
    const xml = providerCallTwiml(`https://${HOST}${ON_CALL_ACK_PATH}?attempt=7&x=<y>`, { textSent: true });
    expect(xml).toContain("&amp;x=&lt;y&gt;");
  });

  it("speaks a different line for each answer, then hangs up", () => {
    const lines: Array<[AckResult, string]> = [
      ["accepted", PROVIDER_ACCEPTED_LINE],
      ["declined", PROVIDER_DECLINED_LINE],
      ["already_taken", PROVIDER_ALREADY_TAKEN_LINE],
      ["closed", PROVIDER_CLOSED_LINE],
      ["too_late", PROVIDER_TOO_LATE_LINE],
    ];
    for (const [result, line] of lines) {
      const out = ackReplyTwiml(result);
      expect(out.status).toBe(200);
      expect(out.body).toContain(line);
      expect(out.body).toMatch(/<Hangup\/>/);
    }
  });
});

describe("a call whose text did not send (review of #514, round 12)", () => {
  const url = `https://${HOST}${ON_CALL_ACK_PATH}?attempt=7&${NO_TEXT_PARAM}=0`;

  it("opens without claiming a text, and still carries nothing about the patient", () => {
    const xml = providerCallTwiml(url, { textSent: false });
    expect(xml).toContain(PROVIDER_CALL_OPENING_NO_TEXT);
    expect(xml).not.toContain("The details are in the text message");
    const text = xml.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\d{3}[-. ]?\d{4}/);
    expect(xml).toContain(`attempt=7&amp;${NO_TEXT_PARAM}=0`);
  });

  it("reads a ten-digit number in three groups, twice, after the key press", () => {
    expect(spokenDigits("+17145550100")).toBe("7 1 4, 5 5 5, 0 1 0 0");
    expect(spokenDigits("(714) 555-0100")).toBe("7 1 4, 5 5 5, 0 1 0 0");
    const line = acceptedWithNumberLine("+17145550100")!;
    expect(line.match(/7 1 4, 5 5 5, 0 1 0 0/g)).toHaveLength(2);
    expect(line).toContain("We could not text you the details");
    const out = ackReplyTwiml({ result: "accepted", noText: true, callbackNumber: "+17145550100" });
    expect(out.body).toContain(line);
    expect(out.body).not.toContain(PROVIDER_ACCEPTED_LINE);
    expect(out.body).toMatch(/<Hangup\/>/);
  });

  it("reads any other length digit by digit, and nothing when there are no digits", () => {
    expect(spokenDigits("5550100")).toBe("5 5 5 0 1 0 0");
    expect(spokenDigits("+441632960961")).toBe("4 4 1 6 3 2 9 6 0 9 6 1");
    expect(spokenDigits("anonymous")).toBeNull();
    expect(acceptedWithNumberLine("anonymous")).toBeNull();
  });

  it("says there is no number to read when none is known", () => {
    for (const callbackNumber of [null, "anonymous"]) {
      const out = ackReplyTwiml({ result: "accepted", noText: true, callbackNumber });
      expect(out.body).toContain(PROVIDER_ACCEPTED_NO_NUMBER_LINE);
      expect(out.body).not.toContain(PROVIDER_ACCEPTED_LINE);
    }
  });

  it("reads the reply's result for both shapes", () => {
    expect(ackResultOf("declined")).toBe("declined");
    expect(ackResultOf({ result: "accepted", noText: true, callbackNumber: null })).toBe("accepted");
  });

  it("reads the flag from the URL", () => {
    expect(textedFlagFrom(`${ON_CALL_ACK_PATH}?attempt=7&${NO_TEXT_PARAM}=0`)).toBe(false);
    expect(textedFlagFrom(`${ON_CALL_ACK_PATH}?attempt=7`)).toBe(true);
    expect(textedFlagFrom(`${ON_CALL_ACK_PATH}?attempt=7&${NO_TEXT_PARAM}=1`)).toBe(true);
    expect(textedFlagFrom(ON_CALL_ACK_PATH)).toBe(true);
  });

  it("reads the number in the webhook's reply when the runner says no text reached the provider", async () => {
    const { d } = deps({ result: "accepted", noText: true, callbackNumber: "+17145550100" });
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, `?attempt=42&${NO_TEXT_PARAM}=0`, { Digits: "1" }), d);
    expect(out.body).toContain("7 1 4, 5 5 5, 0 1 0 0");
    expect(out.body).not.toContain(PROVIDER_ACCEPTED_LINE);
  });

  it("does not point at a text when a key press cannot be recorded on a call with no text", async () => {
    const { d } = deps(new Error("hub down"));
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, `?attempt=42&${NO_TEXT_PARAM}=0`, { Digits: "1" }), d);
    expect(out.body.replace(/&apos;/g, "'")).toContain(PROVIDER_ACK_FAILED_NO_TEXT_LINE);
    expect(out.body).not.toContain("the number in the text message");
  });

  it("keeps the text line when a key press cannot be recorded on a call with a text", async () => {
    const { d } = deps(new Error("hub down"));
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, "?attempt=42", { Digits: "1" }), d);
    expect(out.body).toContain(PROVIDER_ACK_FAILED_LINE);
  });

  it("tells a provider whose key press was not recorded that we keep trying another provider (review of #514, round 14)", () => {
    // Nothing marks the patient taken, so the chain carries on; the line says
    // so before it asks them to call, on both forms.
    for (const line of [PROVIDER_ACK_FAILED_LINE, PROVIDER_ACK_FAILED_NO_TEXT_LINE]) {
      expect(line).toMatch(/keep trying to reach a provider for this patient/);
      expect(line).not.toMatch(/patient is yours|has been taken/);
    }
    expect(PROVIDER_ACK_FAILED_LINE.indexOf("keep trying")).toBeLessThan(
      PROVIDER_ACK_FAILED_LINE.indexOf("please call the patient"),
    );
  });

  it("refuses a request whose no-text flag was removed after signing", async () => {
    const { d, onProviderAck } = deps();
    const out = await handleOnCallAck(
      req(ON_CALL_ACK_PATH, `?attempt=42&${NO_TEXT_PARAM}=0`, { Digits: "1" }, { tamperQuery: "?attempt=42" }),
      d,
    );
    expect(out.status).toBe(403);
    expect(onProviderAck).not.toHaveBeenCalled();
  });
});

describe("reading the attempt id", () => {
  it("takes a positive whole number from the query", () => {
    expect(attemptIdFrom(`${ON_CALL_ACK_PATH}?attempt=12`)).toBe(12);
    expect(attemptIdFrom(`${ON_CALL_ACK_PATH}?x=1&attempt=12`)).toBe(12);
  });

  it("refuses anything else", () => {
    for (const bad of [
      ON_CALL_ACK_PATH,
      `${ON_CALL_ACK_PATH}?attempt=`,
      `${ON_CALL_ACK_PATH}?attempt=0`,
      `${ON_CALL_ACK_PATH}?attempt=-3`,
      `${ON_CALL_ACK_PATH}?attempt=1.5`,
      `${ON_CALL_ACK_PATH}?attempt=abc`,
      `${ON_CALL_ACK_PATH}?attempt=1234567890123`,
    ]) {
      expect(attemptIdFrom(bad), bad).toBeNull();
    }
  });
});

describe("the key-press webhook", () => {
  it("records the key press for the attempt in the signed URL", async () => {
    const { d, onProviderAck } = deps("accepted");
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, "?attempt=42", { Digits: "3" }), d);
    expect(onProviderAck).toHaveBeenCalledWith(42, "3");
    expect(out.status).toBe(200);
    expect(out.body).toContain(PROVIDER_ACCEPTED_LINE);
  });

  it("hands an empty result to the runner as no digits", async () => {
    const { d, onProviderAck } = deps("declined");
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, "?attempt=42", {}), d);
    expect(onProviderAck).toHaveBeenCalledWith(42, "");
    expect(out.body).toContain(PROVIDER_DECLINED_LINE);
  });

  it("refuses a forged request and records nothing", async () => {
    const { d, onProviderAck } = deps();
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, "?attempt=42", { Digits: "1" }, { sign: false }), d);
    expect(out.status).toBe(403);
    expect(onProviderAck).not.toHaveBeenCalled();
  });

  it("refuses a signed request whose attempt id was changed", async () => {
    const { d, onProviderAck } = deps();
    const out = await handleOnCallAck(
      req(ON_CALL_ACK_PATH, "?attempt=42", { Digits: "1" }, { tamperQuery: "?attempt=43" }),
      d,
    );
    expect(out.status).toBe(403);
    expect(onProviderAck).not.toHaveBeenCalled();
  });

  it("fails closed with no auth token", async () => {
    const { d, onProviderAck } = deps();
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, "?attempt=42", { Digits: "1" }), { ...d, env: {} });
    expect(out.status).toBe(200);
    expect(out.body).not.toContain(PROVIDER_ACCEPTED_LINE);
    expect(onProviderAck).not.toHaveBeenCalled();
  });

  it("says closed when the URL carries no attempt", async () => {
    const { d, onProviderAck } = deps();
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, "", { Digits: "1" }), d);
    expect(out.body).toContain(PROVIDER_CLOSED_LINE);
    expect(onProviderAck).not.toHaveBeenCalled();
  });

  it("tells the provider to call the patient when the key press cannot be recorded", async () => {
    const { d, log } = deps(new Error("hub down"));
    const out = await handleOnCallAck(req(ON_CALL_ACK_PATH, "?attempt=42", { Digits: "1" }), d);
    expect(out.status).toBe(200);
    expect(out.body).toContain("please call the patient from the number in the text message");
    expect(out.body).toContain("we will keep trying to reach a provider for this patient");
    expect(out.body).not.toContain(PROVIDER_ACCEPTED_LINE);
    expect(out.body).not.toContain(PROVIDER_CLOSED_LINE);
    expect(log).toHaveBeenCalled();
  });
});

describe("the call-status webhook", () => {
  it("hands the terminal status to the runner, lower-cased", async () => {
    const { d, onProviderStatus } = deps();
    const out = await handleOnCallStatus(req(ON_CALL_STATUS_PATH, "?attempt=9", { CallStatus: "No-Answer" }), d);
    expect(onProviderStatus).toHaveBeenCalledWith(9, "no-answer");
    expect(out).toEqual({ status: 200, contentType: "text/plain", body: "" });
  });

  it("refuses a forged status", async () => {
    const { d, onProviderStatus } = deps();
    const out = await handleOnCallStatus(
      req(ON_CALL_STATUS_PATH, "?attempt=9", { CallStatus: "completed" }, { sign: false }),
      d,
    );
    expect(out.status).toBe(403);
    expect(onProviderStatus).not.toHaveBeenCalled();
  });

  it("answers 200 and records nothing without an attempt or a status", async () => {
    const { d, onProviderStatus } = deps();
    expect((await handleOnCallStatus(req(ON_CALL_STATUS_PATH, "", { CallStatus: "completed" }), d)).status).toBe(200);
    expect((await handleOnCallStatus(req(ON_CALL_STATUS_PATH, "?attempt=9", {}), d)).status).toBe(200);
    expect(onProviderStatus).not.toHaveBeenCalled();
  });

  it("still answers 200 when the runner throws, because Twilio does not retry", async () => {
    const { d, log } = deps();
    d.runner.onProviderStatus = vi.fn(async () => {
      throw new Error("hub down");
    });
    const out = await handleOnCallStatus(req(ON_CALL_STATUS_PATH, "?attempt=9", { CallStatus: "busy" }), d);
    expect(out.status).toBe(200);
    expect(log).toHaveBeenCalled();
  });
});

describe("a key press after the chain ended (review of #514, round 13)", () => {
  it("tells the provider nobody was reached in time, and asks them to call if they can", () => {
    const out = ackReplyTwiml("too_late");
    expect(out.body).toContain(PROVIDER_TOO_LATE_LINE);
    expect(out.body).toContain("call the patient from the number in the text message");
    expect(out.body).not.toContain(PROVIDER_CLOSED_LINE);
    expect(out.body).toMatch(/<Hangup\/>/);
  });

  it("points at no text when none reached that number", () => {
    const out = ackReplyTwiml({ result: "too_late", noText: true });
    expect(out.body).toContain(PROVIDER_TOO_LATE_NO_TEXT_LINE);
    expect(out.body).not.toContain("text message");
    expect(out.body).toMatch(/<Hangup\/>/);
  });

  it("reads as too_late to anything that counts results", () => {
    expect(ackResultOf({ result: "too_late", noText: true })).toBe("too_late");
  });
});
