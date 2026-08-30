import { describe, it, expect, vi } from "vitest";
import {
  ACCEPT_WINDOW_MS,
  conferenceNameFor,
  handoffCallbackFor,
  MAX_BRIEFING_CHARS,
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

  it("caps a runaway briefing at the length the accept window budgets for", async () => {
    // Escalation reasons are model-written and the schemas allow
    // narratives far past the budget's 800-character assumption (PCP up
    // to 12,000): unclipped, the staffer is still hearing details when
    // the registry's fixed window expires and hangs up their leg (Codex,
    // PR #230 round 4). Same slice the SIP path applies, and on the RAW
    // text — the builder escapes after, so no entity is cut in half.
    let twiml = "";
    const { ops } = fakeTwilio({
      createOfficeLeg: async (input) => {
        twiml = input.twiml;
        return { sid: "CAoffice" };
      },
    });
    const runaway = `Reason: chest pain and ${"a very long narrative ".repeat(600)}TAIL-SENTINEL-NEVER-SPOKEN`;
    await performWarmTransfer({ ...request, briefing: runaway }, deps({ twilio: ops }));
    const says = [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]);
    // The head survives; the tail is gone. The script speaks the briefing
    // in BOTH Gather cycles, so the bound is per utterance: no single Say
    // may exceed the cap (plus prompt wording), where the raw narrative
    // runs past 12,000 characters.
    expect(says.join(" ")).toContain("Reason: chest pain");
    expect(Math.max(...says.map((s) => s.length))).toBeLessThan(MAX_BRIEFING_CHARS + 200);
    expect(twiml).not.toContain("TAIL-SENTINEL-NEVER-SPOKEN");
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
    // The accept window must EXCEED the full ring window, not equal it:
    // the clock starts at the dial, so an office answering at the
    // measured 40-41s otherwise had seconds or nothing to hear the
    // briefing and press a key (Codex, PR #230 round 2).
    expect(ACCEPT_WINDOW_MS).toBeGreaterThan(OFFICE_DIAL_TIMEOUT_SECONDS * 1000);
    expect(ACCEPT_WINDOW_MS - OFFICE_DIAL_TIMEOUT_SECONDS * 1000).toBeGreaterThanOrEqual(60_000);
  });

  it("marks the call transferred BEFORE the redirect, and unmarks on a failed one", async () => {
    // The redirect ends the Media Stream, and the resulting close can race
    // the redirect's own resolution — an unmarked close records a
    // successful transfer as caller_hangup with transferred_to_human=false
    // (Codex, PR #230 round 2).
    const order: string[] = [];
    const { ops } = fakeTwilio({
      redirectCallerToConference: async () => {
        order.push("redirect");
      },
    });
    await performWarmTransfer(request, {
      ...deps({ twilio: ops }),
      onCallerRedirectStarting: () => order.push("marked"),
      onCallerRedirectFailed: () => order.push("unmarked"),
    });
    expect(order).toEqual(["marked", "redirect"]);

    const failing = fakeTwilio({
      redirectCallerToConference: async () => {
        order.push("redirect-fails");
        throw new Error("redirect failed");
      },
    });
    order.length = 0;
    const outcome = await performWarmTransfer(request, {
      ...deps({ twilio: failing.ops }),
      onCallerRedirectStarting: () => order.push("marked"),
      onCallerRedirectFailed: () => order.push("unmarked"),
    });
    expect(outcome.ok).toBe(false);
    // Unmarked FIRST in the failure path: the caller never moved, and a
    // later genuine hangup must not be mislabeled a transfer.
    expect(order).toEqual(["marked", "redirect-fails", "unmarked"]);
  });

  it("hands the office leg the status URL, so a dead dial settles early", async () => {
    let statusCallbackUrl: string | undefined;
    const { ops } = fakeTwilio({
      createOfficeLeg: async (input) => {
        statusCallbackUrl = input.statusCallbackUrl;
        return { sid: "CAoffice" };
      },
    });
    await performWarmTransfer(request, {
      ...deps({ twilio: ops }),
      statusUrl: "https://runtime.example.test/voice/transfer-status",
    });
    expect(statusCallbackUrl).toBe("https://runtime.example.test/voice/transfer-status");
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
