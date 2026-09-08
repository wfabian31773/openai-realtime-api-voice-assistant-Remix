/**
 * CAbf717457, 2026-09-08 14:47 — AND THE SHAPE THAT REPLACES IT.
 *
 * A caller opened with "I am calling from Loma Linda Surgery Center and I need
 * to speak to a representative", was never transferred, and hung up at 82
 * seconds with no ticket. The transfer half of that failure is what this file
 * covers: on the warm path the caller waits in silence for up to 45 seconds
 * while the queue rings, and the runtime has no hold ladder to fill it.
 *
 * Rosa's design, approved by the operator the same day: say what is about to
 * happen, hand them into the queue, and keep the ticket either way.
 *
 * The properties that must not rot, in the order they matter:
 *   1. the caller is TOLD, in the approved words, before anything moves;
 *   2. nothing is recorded as a connection, because nothing has connected;
 *   3. the redirect is marked as a transfer BEFORE it happens, or the stream's
 *      death reads as a caller hangup;
 *   4. no destination means nothing was attempted — the agent takes a message.
 */
import { describe, it, expect } from "vitest";
import {
  BLIND_TRANSFER_NO_ANSWER,
  BLIND_TRANSFER_WARNING,
  QUEUE_DIAL_TIMEOUT_SECONDS,
  performBlindTransfer,
} from "./blindTransfer";
import { buildBlindTransferTwiml, buildDialFailedTwiml } from "./transferTwilioOps";

type Redirect = {
  callerCallSid: string;
  destination: string;
  warning: string;
  actionUrl: string;
  timeoutSeconds: number;
  callerId?: string;
};

function harness(over: { redirectThrows?: boolean } = {}) {
  const order: string[] = [];
  const redirects: Redirect[] = [];
  const deps = {
    twilio: {
      redirectCallerToQueue: async (input: Redirect) => {
        order.push("redirect");
        redirects.push(input);
        if (over.redirectThrows) throw new Error("twilio said no");
      },
    },
    dialResultUrl: "https://example.test/voice/transfer-dial-result",
    callerId: "+15550000000",
    onCallerRedirectStarting: () => void order.push("markStarting"),
    onCallerRedirectFailed: () => void order.push("markFailed"),
    log: () => {},
  };
  return { deps, order, redirects };
}

describe("the caller is told, in the operator's own words", () => {
  it("carries the approved sentence to Twilio verbatim", async () => {
    const { deps, redirects } = harness();
    await performBlindTransfer(
      { callerCallSid: "CAcaller", destination: "+17149564300" },
      deps,
    );
    expect(redirects[0].warning).toBe(BLIND_TRANSFER_WARNING);
  });

  /**
   * PINNED WORD FOR WORD. The operator approved this sentence on 2026-09-08
   * ("that wording is fine") and each clause is load-bearing: what is
   * happening, that the wait is not promised (#265), and that the details are
   * already recorded so giving up in the queue costs nothing.
   *
   * Anyone changing it is making an operator decision, and this test is where
   * they find that out.
   */
  it("says what happens, refuses to promise a wait, and says the details are kept", () => {
    expect(BLIND_TRANSFER_WARNING).toBe(
      "I'm going to put you through to our PCP team's line now. " +
        "I can't tell you how long the wait will be — and I've taken your details down, " +
        "so they have them either way.",
    );
  });

  /**
   * #265 forbids telling a caller anyone is busy or will be free shortly, and
   * standing instruction 10 forbids telling anybody to call back. Both copies
   * go out on a leg the agent can no longer supervise, so the guard is here
   * rather than in a prompt.
   */
  it("neither copy claims availability or asks the caller to ring again", () => {
    for (const copy of [BLIND_TRANSFER_WARNING, BLIND_TRANSFER_NO_ANSWER]) {
      const said = copy.toLowerCase();
      expect(said).not.toMatch(/busy/);
      expect(said).not.toMatch(/shortly|right with you|as soon as they/);
      expect(said).not.toMatch(/call (us )?back|call again|try (us )?again/);
    }
    // And the no-answer line still promises the follow-up, which is the half
    // that makes the refusal survivable.
    expect(BLIND_TRANSFER_NO_ANSWER.toLowerCase()).toMatch(/follow up with you/);
  });
});

describe("nothing is claimed that nothing proved", () => {
  it("reports success as a BLIND hand-off, never as an accepted transfer", async () => {
    const { deps } = harness();
    const outcome = await performBlindTransfer(
      { callerCallSid: "CAcaller", destination: "+17149564300" },
      deps,
    );
    expect(outcome).toEqual({ ok: true, destination: "+17149564300", method: "blind" });
    // No office leg exists to name, and naming one would imply a dial we
    // never made.
    expect(outcome.ok && "officeCallSid" in outcome).toBe(false);
  });

  it("dials with the queue timeout and posts the result somewhere we can read it", async () => {
    const { deps, redirects } = harness();
    await performBlindTransfer(
      { callerCallSid: "CAcaller", destination: "+17149564300" },
      deps,
    );
    expect(redirects[0].timeoutSeconds).toBe(QUEUE_DIAL_TIMEOUT_SECONDS);
    expect(redirects[0].actionUrl).toBe("https://example.test/voice/transfer-dial-result");
  });
});

describe("the transfer mark precedes the redirect", () => {
  /**
   * The redirect ends the Media Stream and the resulting close races the
   * redirect's own resolution. Marking after would let a successful transfer
   * persist as `caller_hangup` with `transferred_to_human` false — the
   * corruption Codex found on PR #230 round 2, in a second mechanism.
   */
  it("marks BEFORE it moves the caller", async () => {
    const { deps, order } = harness();
    await performBlindTransfer({ callerCallSid: "CAcaller", destination: "+1714" }, deps);
    expect(order).toEqual(["markStarting", "redirect"]);
  });

  it("clears the mark FIRST when the redirect fails, so a later hangup is a hangup", async () => {
    const { deps, order } = harness({ redirectThrows: true });
    const outcome = await performBlindTransfer(
      { callerCallSid: "CAcaller", destination: "+1714" },
      deps,
    );
    expect(order).toEqual(["markStarting", "redirect", "markFailed"]);
    expect(outcome).toEqual({
      ok: false,
      status: "FAILED",
      reason: "caller_redirect_failed",
      destination: "+1714",
      method: "blind",
    });
  });
});

describe("no destination is not a failed dial", () => {
  it("returns UNAVAILABLE without touching the caller's leg", async () => {
    const { deps, order } = harness();
    const outcome = await performBlindTransfer(
      { callerCallSid: "CAcaller", destination: "   " },
      deps,
    );
    expect(order).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, status: "UNAVAILABLE", method: "blind" });
  });
});

describe("the TwiML the caller actually lands in", () => {
  const twiml = () =>
    buildBlindTransferTwiml({
      destination: "+17149564300",
      warning: BLIND_TRANSFER_WARNING,
      actionUrl: "https://example.test/voice/transfer-dial-result",
      timeoutSeconds: QUEUE_DIAL_TIMEOUT_SECONDS,
      callerId: "+15550000000",
      voice: "Polly.Joanna",
    });

  it("speaks before it dials — the sentence is the whole consideration", () => {
    const doc = twiml();
    expect(doc.indexOf("<Say")).toBeGreaterThan(-1);
    expect(doc.indexOf("<Say")).toBeLessThan(doc.indexOf("<Dial"));
  });

  it("asks Twilio for the dial result, which is the only answer we get", () => {
    expect(twiml()).toContain('action="https://example.test/voice/transfer-dial-result"');
    expect(twiml()).toContain('method="POST"');
  });

  /**
   * A second `<Say>` after the `<Dial>` would play on top of whatever the
   * action handler returns, so the caller would hear the no-answer line twice.
   * Twilio only continues past a `<Dial>` when it did not connect — exactly
   * the case the action URL already handles.
   */
  it("puts nothing after the Dial for the action response to collide with", () => {
    const doc = twiml();
    expect(doc.slice(doc.indexOf("</Dial>"))).toBe("</Dial></Response>");
  });

  it("escapes the copy rather than trusting it — an apostrophe is in the first word", () => {
    // "I'm" and the em dash both go out through the same escaper the
    // conference TwiML uses; a raw `&` or `<` in future copy must not break
    // the document.
    const doc = buildBlindTransferTwiml({
      destination: "+1714",
      warning: 'Ampersand & angle < bracket',
      actionUrl: "https://example.test/a",
      timeoutSeconds: 45,
      voice: "Polly.Joanna",
    });
    expect(doc).toContain("Ampersand &amp; angle &lt; bracket");
  });

  it("the no-answer document says the line and hangs up, nothing else", () => {
    const doc = buildDialFailedTwiml(BLIND_TRANSFER_NO_ANSWER, "Polly.Joanna");
    expect(doc).toContain("<Hangup/>");
    expect(doc).toContain("I wasn&apos;t able to get someone on the line just now");
    expect(doc).not.toContain("<Dial");
  });
});
