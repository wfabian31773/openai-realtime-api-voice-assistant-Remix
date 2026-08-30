import { describe, it, expect } from "vitest";
import twilio from "twilio";
import { handleTransferAccept, type TransferAcceptDeps } from "./transferAcceptWebhook";
import { TransferAcceptRegistry } from "./transferAccepts";
import type { WebhookRequest } from "./voiceWebhook";

const AUTH_TOKEN = "test-auth-token";
const HOST = "example.test";
const PATH = "/voice/transfer-accept";

/**
 * A genuinely signed request — the webhook runs the same validateRequest the
 * production gate runs, so the tests mint real signatures rather than
 * injecting a validator that would let the check itself drift untested.
 */
function req(over: { body?: Record<string, string>; sign?: boolean } = {}): WebhookRequest {
  const body = over.body ?? { CallSid: "CAoffice", Digits: "1" };
  const signature =
    over.sign === false
      ? "not-a-real-signature"
      : twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://${HOST}${PATH}`, body);
  return {
    headers: {
      host: HOST,
      "x-forwarded-proto": "https",
      "x-twilio-signature": signature,
    },
    body,
    originalUrl: PATH,
  };
}

function deps(over: Partial<TransferAcceptDeps> = {}): TransferAcceptDeps {
  return {
    env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
    accepts: new TransferAcceptRegistry({ windowMs: 45_000, log: () => undefined }),
    conferenceFor: () => "runtime_xfer_CAcaller",
    log: () => undefined,
    ...over,
  };
}

/** Swallow the rejection so an expected decline is not an unhandled error. */
function waiting(reg: TransferAcceptRegistry, sid = "CAoffice") {
  const p = reg.waitFor(sid).then(
    () => "resolved",
    (e: Error & { resolution?: string }) => e.resolution ?? "rejected",
  );
  return p;
}

describe("a forged accept must not bridge a stranger into a live call", () => {
  it("refuses a bad signature with 403 and no conference", () => {
    const out = handleTransferAccept(req({ sign: false }), deps());
    expect(out.status).toBe(403);
    expect(out.body).not.toContain("<Conference");
  });

  it("refuses a request whose params were tampered with after signing", () => {
    // Signed over one CallSid, delivered with another — the HMAC covers the
    // params, so swapping the leg invalidates the signature.
    const signed = req({ body: { CallSid: "CAoffice", Digits: "1" } });
    const tampered = { ...signed, body: { CallSid: "CAother", Digits: "1" } };
    const out = handleTransferAccept(tampered, deps());
    expect(out.status).toBe(403);
    expect(out.body).not.toContain("<Conference");
  });

  it("does not settle the pending transfer when the signature is bad", async () => {
    const d = deps();
    const settled = waiting(d.accepts);
    handleTransferAccept(req({ sign: false }), d);
    // Still pending — a forged request must not consume the real accept.
    expect(d.accepts.pendingCount()).toBe(1);
    d.accepts.abandon("CAoffice");
    expect(await settled).toBe("abandoned");
  });
});

describe("missing configuration answers 200, never 5xx", () => {
  /** Twilio treats ANY 5xx as failure and plays its own handling instead. */
  it("returns a controlled hangup when no auth token is configured", () => {
    const out = handleTransferAccept(req(), deps({ env: {} }));
    expect(out.status).toBe(200);
    expect(out.body).toContain("<Hangup/>");
  });
});

describe("the keypress decision table", () => {
  it("bridges into the conference on a digit", async () => {
    const d = deps();
    const settled = waiting(d.accepts);
    const out = handleTransferAccept(req(), d);
    expect(out.status).toBe(200);
    expect(out.body).toContain("<Conference");
    expect(out.body).toContain("runtime_xfer_CAcaller");
    expect(await settled).toBe("resolved");
  });

  it("hangs up with no conference when the briefing played out unanswered", async () => {
    const d = deps();
    const settled = waiting(d.accepts);
    const out = handleTransferAccept(req({ body: { CallSid: "CAoffice", Digits: "" } }), d);
    expect(out.body).not.toContain("<Conference");
    expect(await settled).toBe("declined");
  });

  it("tells a late presser the transfer is gone rather than bridging them", () => {
    const d = deps(); // nothing pending
    const out = handleTransferAccept(req(), d);
    expect(out.body).toContain("no longer waiting");
    expect(out.body).not.toContain("<Conference");
  });

  it("refuses to guess a conference when none is known for the leg", async () => {
    const d = deps({ conferenceFor: () => undefined });
    const settled = waiting(d.accepts);
    const out = handleTransferAccept(req(), d);
    // Dropping a staffer into a guessed room would be a stranger's call.
    expect(out.body).not.toContain("<Conference");
    expect(await settled).toBe("resolved");
  });

  it("handles a post with no CallSid at all", () => {
    const out = handleTransferAccept(req({ body: {} }), deps());
    expect(out.status).toBe(200);
    expect(out.body).not.toContain("<Conference");
  });
});

describe("ordering", () => {
  /**
   * The conference must be read BEFORE the settle.
   *
   * The first version of this test asserted the order via a promise `.then`,
   * which can never fire during a synchronous handler — it passed against the
   * reordered code too. This one models the coupling being defended against:
   * a registry whose settle tears down the state the conference lookup reads.
   */
  it("reads the conference before settling, so a settle-driven cleanup cannot erase it", () => {
    let conference: string | undefined = "runtime_xfer_CAcaller";
    const accepts = {
      // Settling tears down the transfer's state, exactly as a real cleanup
      // keyed on the office leg would.
      recordDigits: (_sid: string, digits: string | null | undefined) => {
        conference = undefined;
        return String(digits ?? "").trim().length > 0;
      },
      pendingCount: () => 0,
    } as unknown as TransferAcceptRegistry;

    const out = handleTransferAccept(
      req(),
      deps({ accepts, conferenceFor: () => conference }),
    );

    expect(out.body).toContain("<Conference");
    expect(out.body).toContain("runtime_xfer_CAcaller");
  });
});
