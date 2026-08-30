import { describe, it, expect, vi } from "vitest";
import {
  ACCEPT_WINDOW_MS,
  conferenceNameFor,
  handoffCallbackFor,
  OFFICE_DIAL_TIMEOUT_SECONDS,
  performWarmTransfer,
  type TransferTwilioOps,
  type WarmTransferDeps,
} from "./warmTransfer";
import { describesNonKeypressAccept } from "../services/warmTransferBriefing";

/**
 * A Twilio that records the ORDER of operations, because the order is the
 * safety property. Moving the caller before a human accepts drops them into an
 * empty conference with no agent — the transport gives no way back.
 */
function fakeTwilio(over: Partial<TransferTwilioOps> = {}) {
  const calls: string[] = [];
  const ops: TransferTwilioOps = {
    createOfficeLeg: async () => {
      calls.push("dial");
      return { sid: "CAoffice" };
    },
    redirectCallerToConference: async () => {
      calls.push("redirect");
    },
    endCall: async () => {
      calls.push("endCall");
    },
    ...over,
  };
  return { ops, calls };
}

function deps(over: Partial<WarmTransferDeps> = {}): WarmTransferDeps {
  const { ops } = fakeTwilio();
  return {
    twilio: ops,
    awaitAccept: async () => undefined,
    acceptUrl: "https://example.test/voice/transfer-accept",
    fromNumber: "+15550000000",
    log: () => undefined,
    ...over,
  };
}

const request = {
  callerCallSid: "CAcaller",
  destination: "+17149564300",
  briefing: "This is Azul Vision with a live patient transfer. Reason: refill.",
};

describe("the caller is never moved before a human accepts", () => {
  it("dials the office first and redirects only after the accept resolves", async () => {
    const { ops, calls } = fakeTwilio();
    const order: string[] = [];
    const out = await performWarmTransfer(request, {
      ...deps({ twilio: ops }),
      awaitAccept: async () => {
        order.push("accepted");
      },
    });

    expect(out.ok).toBe(true);
    expect(calls).toEqual(["dial", "redirect"]);
    // The accept has to land between the two, not after both.
    expect(order).toEqual(["accepted"]);
  });

  it("does NOT redirect the caller when the office never answers", async () => {
    const { ops, calls } = fakeTwilio();
    const out = await performWarmTransfer(request, {
      ...deps({ twilio: ops }),
      awaitAccept: async () => {
        throw new Error("timeout");
      },
    });

    expect(calls).not.toContain("redirect");
    expect(out).toMatchObject({ ok: false, status: "NO_ANSWER", reason: "office_no_answer" });
  });

  it("does NOT redirect the caller when the office declines", async () => {
    const { ops, calls } = fakeTwilio();
    const out = await performWarmTransfer(request, {
      ...deps({ twilio: ops }),
      awaitAccept: async () => {
        throw new Error("declined");
      },
    });

    expect(calls).not.toContain("redirect");
    expect(out).toMatchObject({ ok: false, status: "DECLINED", reason: "office_declined" });
  });

  it("does NOT redirect the caller when the dial itself fails", async () => {
    const { ops, calls } = fakeTwilio({
      createOfficeLeg: async () => {
        throw new Error("twilio 500");
      },
    });
    const out = await performWarmTransfer(request, deps({ twilio: ops }));

    expect(calls).not.toContain("redirect");
    expect(out).toMatchObject({ ok: false, status: "FAILED", reason: "dial_failed" });
  });

  it("never dials at all when no destination is configured", async () => {
    const { ops, calls } = fakeTwilio();
    const out = await performWarmTransfer(
      { ...request, destination: null },
      deps({ twilio: ops }),
    );

    expect(calls).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      status: "UNAVAILABLE",
      reason: "transfer_destination_not_configured",
    });
  });

  it("treats a blank destination as unconfigured rather than dialling empty", async () => {
    const { ops, calls } = fakeTwilio();
    const out = await performWarmTransfer({ ...request, destination: "   " }, deps({ twilio: ops }));
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ status: "UNAVAILABLE" });
  });
});

describe("cleanup after a failed transfer", () => {
  it("hangs up the office leg the caller never joined", async () => {
    const ended: string[] = [];
    const { ops } = fakeTwilio({ endCall: async (sid) => void ended.push(sid) });
    await performWarmTransfer(request, {
      ...deps({ twilio: ops }),
      awaitAccept: async () => {
        throw new Error("timeout");
      },
    });
    expect(ended).toEqual(["CAoffice"]);
  });

  it("hangs up the office leg when the redirect fails after an accept", async () => {
    const ended: string[] = [];
    const { ops } = fakeTwilio({
      redirectCallerToConference: async () => {
        throw new Error("call already completed");
      },
      endCall: async (sid) => void ended.push(sid),
    });
    const out = await performWarmTransfer(request, deps({ twilio: ops }));

    // A staffer holding an empty conference is the thing this prevents.
    expect(ended).toEqual(["CAoffice"]);
    expect(out).toMatchObject({ ok: false, reason: "caller_redirect_failed" });
  });

  it("does not let a cleanup failure mask why the transfer failed", async () => {
    const { ops } = fakeTwilio({
      endCall: async () => {
        throw new Error("twilio unreachable");
      },
    });
    const out = await performWarmTransfer(request, {
      ...deps({ twilio: ops }),
      awaitAccept: async () => {
        throw new Error("timeout");
      },
    });
    // Still NO_ANSWER — not "twilio unreachable".
    expect(out).toMatchObject({ ok: false, status: "NO_ANSWER", reason: "office_no_answer" });
  });
});

describe("what the office hears", () => {
  it("plays the briefing behind a keypress gate and offers no other way in", async () => {
    let twiml = "";
    const { ops } = fakeTwilio({
      createOfficeLeg: async (input) => {
        twiml = input.twiml;
        return { sid: "CAoffice" };
      },
    });
    await performWarmTransfer(request, deps({ twilio: ops }));

    expect(twiml).toContain("Reason: refill.");
    const spoken = [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]).join(" ");
    expect(describesNonKeypressAccept(spoken)).toBeNull();
  });

  it("rings for the full window, because most real accepts take over 20 seconds", async () => {
    let seconds = 0;
    const { ops } = fakeTwilio({
      createOfficeLeg: async (input) => {
        seconds = input.timeoutSeconds;
        return { sid: "CAoffice" };
      },
    });
    await performWarmTransfer(request, deps({ twilio: ops }));

    // Measured on the real PCP queue: ring-to-accept was 17,20,27,28,29,30,
    // 35,35,35,40,40,41s — ten of twelve over twenty seconds.
    expect(seconds).toBe(OFFICE_DIAL_TIMEOUT_SECONDS);
    expect(seconds).toBeGreaterThanOrEqual(41);
    expect(ACCEPT_WINDOW_MS / 1000).toBeGreaterThanOrEqual(41);
  });
});

describe("the conference both legs meet in", () => {
  it("is derived from the caller's SID, so two calls never collide", () => {
    expect(conferenceNameFor("CAaaa")).not.toBe(conferenceNameFor("CAbbb"));
    expect(conferenceNameFor("CAaaa")).toContain("CAaaa");
  });

  it("is the same name the office is waiting in and the caller is sent to", async () => {
    let redirectedTo = "";
    const { ops } = fakeTwilio({
      redirectCallerToConference: async (input) => {
        redirectedTo = input.conferenceName;
      },
    });
    await performWarmTransfer(request, deps({ twilio: ops }));
    expect(redirectedTo).toBe(conferenceNameFor("CAcaller"));
  });
});

describe("the callback the agent factories receive", () => {
  /**
   * Factories take `() => Promise<void>`. A blocked handoff that RESOLVES lets
   * the agent say "connecting you now" with nobody dialled — observed live
   * 2026-08-04, and why handoff-silent-failures.md exists.
   */
  it("throws on a failed transfer rather than resolving", async () => {
    const cb = handoffCallbackFor(() => request, {
      ...deps(),
      awaitAccept: async () => {
        throw new Error("timeout");
      },
    });
    await expect(cb()).rejects.toThrow(/handoff_failed:NO_ANSWER/);
  });

  it("resolves only when the caller actually reached a human", async () => {
    const cb = handoffCallbackFor(() => request, deps());
    await expect(cb()).resolves.toBeUndefined();
  });

  it("gives the model a fixed slug, never a raw provider error", async () => {
    const cb = handoffCallbackFor(() => request, {
      ...deps({
        twilio: fakeTwilio({
          createOfficeLeg: async () => {
            throw new Error("Twilio 21215: account not authorized to call +1714...");
          },
        }).ops,
      }),
    });
    const err = await cb().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("handoff_failed:FAILED");
    expect(err?.message).not.toMatch(/21215|not authorized/);
  });

  it("reads the request at call time, so a late-resolved destination is used", async () => {
    const seen: Array<string | null | undefined> = [];
    const { ops } = fakeTwilio({
      createOfficeLeg: async (input) => {
        seen.push(input.to);
        return { sid: "CAoffice" };
      },
    });
    let destination: string | null = null;
    const cb = handoffCallbackFor(() => ({ ...request, destination }), deps({ twilio: ops }));

    await expect(cb()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    destination = "+17149564300";
    await expect(cb()).resolves.toBeUndefined();
    expect(seen).toEqual(["+17149564300"]);
  });
});
