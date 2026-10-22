/**
 * Ticketing webhook signatures. Synthetic bodies only — no PHI.
 */
import { describe, expect, it } from "vitest";
import {
  CALLBACK_SIGNATURE_MAX_AGE_SEC,
  createCallbackReporter,
  signCallbackPayload,
  verifyCallbackSignature,
} from "./callbackReport";

const SECRET = "test-callback-secret";

describe("callback webhook signature", () => {
  it("signs HMAC-SHA256 of timestamp.rawBody and rejects a stamp older than five minutes", async () => {
    const captured: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const reporter = createCallbackReporter(
      {
        SI_ASSISTANT_CALLBACK_WEBHOOK_URL: "https://ticketing.example/si-assistant",
        SI_ASSISTANT_CALLBACK_WEBHOOK_SECRET: SECRET,
      },
      (async (url, init) => {
        captured.push({
          url: String(url),
          headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])),
          body: String(init?.body ?? ""),
        });
        return new Response("", { status: 200 });
      }) as typeof fetch,
    );
    expect(reporter).not.toBeNull();
    const before = Math.floor(Date.now() / 1000);
    await reporter!.report({ event: "callback", slug: "si-assistant", callSid: "CA" + "c".repeat(32), outcome: "completed" });
    const after = Math.floor(Date.now() / 1000);
    expect(captured).toHaveLength(1);
    const ts = Number(captured[0].headers["X-SI-Assistant-Timestamp"]);
    expect(Number.isInteger(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(captured[0].headers["X-SI-Assistant-Signature"]).toBe(
      signCallbackPayload(captured[0].body, SECRET, ts),
    );
    expect(
      verifyCallbackSignature({
        body: captured[0].body,
        secret: SECRET,
        signature: captured[0].headers["X-SI-Assistant-Signature"],
        timestamp: ts,
        nowSec: ts,
      }),
    ).toBe(true);
    expect(
      verifyCallbackSignature({
        body: captured[0].body,
        secret: SECRET,
        signature: captured[0].headers["X-SI-Assistant-Signature"],
        timestamp: ts,
        nowSec: ts + CALLBACK_SIGNATURE_MAX_AGE_SEC + 1,
      }),
    ).toBe(false);
    expect(CALLBACK_SIGNATURE_MAX_AGE_SEC).toBe(5 * 60);
    expect(captured[0].body).not.toMatch(/555555|Patient|DOB/i);
  });
});
