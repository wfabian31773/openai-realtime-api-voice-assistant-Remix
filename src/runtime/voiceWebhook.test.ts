import { describe, it, expect, vi } from "vitest";
import twilio from "twilio";
import {
  handleVoiceWebhook,
  handleAfterRedirect,
  checkTwilioSignature,
  isValidSlug,
  RUNTIME_UNAVAILABLE_LINE,
  RUNTIME_TECHNICAL_TROUBLE_LINE,
  VOICE_STREAM_PATH,
  type WebhookRequest,
} from "./voiceWebhook";
import { CallSessionRegistry } from "./sessionRegistry";

const AUTH_TOKEN = "test-auth-token";
const LIVE_ENV = {
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  XAI_API_KEY: "k",
  DATABASE_URL: "postgres://x",
};

/** A genuinely signed request — the signature is computed the same way
 * Twilio computes it, so the handler's own validateRequest accepts it. */
function signedRequest(
  path: string,
  body: Record<string, string>,
  host = "runtime.example.com",
): WebhookRequest {
  const url = `https://${host}${path}`;
  const sig = (
    twilio as unknown as {
      getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string;
    }
  ).getExpectedTwilioSignature(AUTH_TOKEN, url, body);
  return {
    headers: { host, "x-forwarded-proto": "https", "x-twilio-signature": sig },
    body,
    originalUrl: path,
  };
}

function deps(over: Partial<Parameters<typeof handleVoiceWebhook>[2]> = {}) {
  return {
    env: LIVE_ENV as Record<string, string | undefined>,
    registry: new CallSessionRegistry(),
    laneIsAvailable: () => true,
    ...over,
  };
}

const BODY = { CallSid: "CA123", From: "+15551234567", To: "+15559876543" };

/** What the caller actually hears: the <Say> text, XML-unescaped. Asserting
 * on the raw TwiML would pass on an apostrophe and fail on an escaped one,
 * which is a fact about XML, not about what was said. */
function spoken(twiml: string): string {
  return (twiml.match(/<Say>([\s\S]*?)<\/Say>/)?.[1] ?? "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("webhook security posture", () => {
  it("fails CLOSED with no auth token — never an unauthenticated accept", () => {
    const d = deps({ env: { XAI_API_KEY: "k", DATABASE_URL: "d" } });
    const res = handleVoiceWebhook("optical", signedRequest("/voice/optical", BODY), d);
    // 200, not 503: "Twilio treats ANY 5xx as failure regardless of
    // content" (server/index.ts:93) — a 5xx means the controlled line this
    // branch exists to speak is never played to the caller.
    expect(res.status).toBe(200);
    expect(spoken(res.body)).toBe(RUNTIME_UNAVAILABLE_LINE);
    expect(res.body).not.toContain("<Stream");
  });

  it("rejects a request with no signature", () => {
    const req: WebhookRequest = {
      headers: { host: "runtime.example.com" },
      body: BODY,
      originalUrl: "/voice/optical",
    };
    expect(handleVoiceWebhook("optical", req, deps()).status).toBe(403);
  });

  it("rejects a forged signature", () => {
    const req = signedRequest("/voice/optical", BODY);
    req.headers["x-twilio-signature"] = "not-the-signature";
    expect(handleVoiceWebhook("optical", req, deps()).status).toBe(403);
  });

  it("rejects a valid signature replayed against a DIFFERENT lane's URL", () => {
    // The signature covers the URL, so a token minted for /voice/optical
    // cannot be pointed at /voice/surgery.
    const req = signedRequest("/voice/optical", BODY);
    req.originalUrl = "/voice/surgery";
    expect(handleVoiceWebhook("surgery", req, deps()).status).toBe(403);
  });

  it("accepts a genuinely signed request", () => {
    expect(checkTwilioSignature(signedRequest("/voice/optical", BODY), LIVE_ENV)).toBe("valid");
  });
});

describe("webhook readiness and lane gating", () => {
  it("speaks the controlled unavailable line when the process is not live-ready", () => {
    const d = deps({ env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN } });
    const res = handleVoiceWebhook("optical", signedRequest("/voice/optical", BODY), d);
    expect(res.status).toBe(200);
    expect(spoken(res.body)).toBe(RUNTIME_UNAVAILABLE_LINE);
    expect(res.body).toContain("<Hangup/>");
    expect(res.body).not.toContain("<Stream");
  });

  it("does NOT substitute another agent for a lane that is off", () => {
    const d = deps({ laneIsAvailable: () => false });
    const res = handleVoiceWebhook("surgery", signedRequest("/voice/surgery", BODY), d);
    expect(spoken(res.body)).toBe(RUNTIME_UNAVAILABLE_LINE);
    expect(res.body).not.toContain("<Stream");
  });

  it("refuses a slug that is a path or a probe, not a lane name", () => {
    expect(isValidSlug("optical")).toBe(true);
    expect(isValidSlug("azul-scheduling")).toBe(true);
    expect(isValidSlug("../etc/passwd")).toBe(false);
    expect(isValidSlug("Optical")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    // Authenticated, so the 404 is the SLUG being rejected rather than the
    // signature — the security gate runs first by design.
    const res = handleVoiceWebhook("Optical", signedRequest("/voice/Optical", BODY), deps());
    expect(res.status).toBe(404);
  });

  it("refuses a request Twilio would never send — no CallSid", () => {
    const body = { From: "+1", To: "+2" };
    const res = handleVoiceWebhook("optical", signedRequest("/voice/optical", body), deps());
    expect(res.status).toBe(400);
  });
});

describe("the TwiML a live call gets", () => {
  it("connects the stream and carries callSid + a single-use token as Parameters", () => {
    const registry = new CallSessionRegistry();
    const res = handleVoiceWebhook(
      "optical",
      signedRequest("/voice/optical", BODY),
      deps({ registry }),
    );
    expect(res.status).toBe(200);
    // Twilio does not support query parameters on a <Stream url>.
    expect(res.body).toContain(`<Stream url="wss://runtime.example.com${VOICE_STREAM_PATH}">`);
    expect(res.body).not.toContain(`${VOICE_STREAM_PATH}?`);
    const entry = registry.get("CA123")!;
    expect(entry.slug).toBe("optical");
    expect(entry.callerPhone).toBe("+15551234567");
    expect(res.body).toContain(`<Parameter name="callSid" value="CA123"/>`);
    expect(res.body).toContain(`<Parameter name="token" value="${entry.streamToken}"/>`);
  });

  it("continues to the lane's own after-redirect once the stream ends", () => {
    const res = handleVoiceWebhook("surgery", signedRequest("/voice/surgery", BODY), deps());
    expect(res.body).toContain("<Redirect method=\"POST\">/voice/surgery/after</Redirect>");
  });

  it("issues a different token per call — a token is not reusable across calls", () => {
    const registry = new CallSessionRegistry();
    handleVoiceWebhook("optical", signedRequest("/voice/optical", BODY), deps({ registry }));
    const first = registry.get("CA123")!.streamToken;
    handleVoiceWebhook(
      "optical",
      signedRequest("/voice/optical", { ...BODY, CallSid: "CA999" }),
      deps({ registry }),
    );
    expect(registry.get("CA999")!.streamToken).not.toBe(first);
  });
});

describe("the post-stream redirect", () => {
  it("speaks the trouble line after a runtime-side failure", () => {
    const registry = new CallSessionRegistry();
    registry.register({ callSid: "CA123", slug: "optical", callerPhone: "", dialedNumber: "" });
    registry.recordOutcome("CA123", "provider_failure");
    const res = handleAfterRedirect(
      signedRequest("/voice/optical/after", { CallSid: "CA123" }),
      deps({ registry }),
    );
    expect(spoken(res.body)).toBe(RUNTIME_TECHNICAL_TROUBLE_LINE);
  });

  it("also explains a dead-air teardown — the caller was cut off mid-call", () => {
    const registry = new CallSessionRegistry();
    registry.register({ callSid: "CA123", slug: "optical", callerPhone: "", dialedNumber: "" });
    registry.recordOutcome("CA123", "dead_air");
    const res = handleAfterRedirect(
      signedRequest("/voice/optical/after", { CallSid: "CA123" }),
      deps({ registry }),
    );
    expect(spoken(res.body)).toBe(RUNTIME_TECHNICAL_TROUBLE_LINE);
  });

  it("hangs up cleanly after a normal ending — no invented apology", () => {
    const registry = new CallSessionRegistry();
    for (const outcome of ["completed", "agent_ended", "caller_hangup", "max_duration"] as const) {
      registry.register({ callSid: outcome, slug: "optical", callerPhone: "", dialedNumber: "" });
      registry.recordOutcome(outcome, outcome);
      const res = handleAfterRedirect(
        signedRequest("/voice/optical/after", { CallSid: outcome }),
        deps({ registry }),
      );
      expect(res.body).toContain("<Hangup/>");
      expect(res.body).not.toContain("<Say>");
    }
  });

  it("hangs up cleanly for a call it never saw", () => {
    const res = handleAfterRedirect(
      signedRequest("/voice/optical/after", { CallSid: "unknown" }),
      deps(),
    );
    expect(res.body).toContain("<Hangup/>");
  });

  it("authenticates too — it can speak to the caller", () => {
    const req = signedRequest("/voice/optical/after", { CallSid: "CA123" });
    req.headers["x-twilio-signature"] = "forged";
    expect(handleAfterRedirect(req, deps()).status).toBe(403);
  });
});

describe("the words the runtime owns", () => {
  it("claims nothing beyond a follow-up — the practice's promises are the agent's to make", () => {
    for (const line of [RUNTIME_UNAVAILABLE_LINE, RUNTIME_TECHNICAL_TROUBLE_LINE]) {
      expect(line).not.toMatch(/appointment|schedul|transfer|ticket|prescription|refill/i);
      expect(line).toMatch(/follow up/i);
    }
  });
});

describe("host derivation", () => {
  it("prefers the forwarded host, which is what a proxy signs against", () => {
    const req = signedRequest("/voice/optical", BODY, "proxied.example.com");
    req.headers["x-forwarded-host"] = "proxied.example.com";
    req.headers.host = "internal:8080";
    expect(checkTwilioSignature(req, LIVE_ENV)).toBe("valid");
  });
});

describe("no unhandled throw reaches Twilio", () => {
  it("a validateRequest that throws is a rejection, not a crash", () => {
    const spy = vi.spyOn(twilio, "validateRequest").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      expect(handleVoiceWebhook("optical", signedRequest("/voice/optical", BODY), deps()).status)
        .toBe(403);
    } finally {
      spy.mockRestore();
    }
  });
});
