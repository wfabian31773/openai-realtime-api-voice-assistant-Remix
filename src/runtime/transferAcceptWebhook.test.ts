import { describe, it, expect } from "vitest";
import { handleTransferAccept, type TransferAcceptDeps } from "./transferAcceptWebhook";
import { TransferAcceptRegistry } from "./transferAccepts";
import type { WebhookRequest } from "./voiceWebhook";

function req(over: Partial<WebhookRequest> = {}): WebhookRequest {
  return {
    headers: { "x-twilio-signature": "sig" },
    body: { CallSid: "CAoffice", Digits: "1" },
    originalUrl: "/voice/transfer-accept",
    ...over,
  };
}

function deps(over: Partial<TransferAcceptDeps> = {}): TransferAcceptDeps {
  return {
    env: { TWILIO_AUTH_TOKEN: "token", PUBLIC_BASE_URL: "https://example.test" },
    accepts: new TransferAcceptRegistry({ windowMs: 45_000, log: () => undefined }),
    conferenceFor: () => "runtime_xfer_CAcaller",
    validateSignature: () => true,
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
    const d = deps({ validateSignature: () => false });
    const out = handleTransferAccept(req(), d);
    expect(out.status).toBe(403);
    expect(out.body).not.toContain("<Conference");
  });

  it("refuses a missing signature", () => {
    const out = handleTransferAccept(req({ headers: {} }), deps());
    expect(out.status).toBe(403);
    expect(out.body).not.toContain("<Conference");
  });

  it("does not settle the pending transfer when the signature is bad", async () => {
    const d = deps({ validateSignature: () => false });
    const settled = waiting(d.accepts);
    handleTransferAccept(req(), d);
    // Still pending — a forged request must not consume the real accept.
    expect(d.accepts.pendingCount()).toBe(1);
    d.accepts.abandon("CAoffice");
    expect(await settled).toBe("abandoned");
  });

  it("validates against the public URL, not the raw path", () => {
    const seen: string[] = [];
    const d = deps({
      validateSignature: (_t, _s, url) => {
        seen.push(url);
        return true;
      },
    });
    handleTransferAccept(req(), d);
    expect(seen[0]).toBe("https://example.test/voice/transfer-accept");
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
