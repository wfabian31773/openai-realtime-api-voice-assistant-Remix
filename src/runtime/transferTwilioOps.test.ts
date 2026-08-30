import { describe, it, expect } from "vitest";
import {
  buildCallerConferenceTwiml,
  buildDeclinedTransferTwiml,
  buildExpiredTransferTwiml,
  buildOfficeAcceptTwiml,
  createTransferTwilioOps,
  type MinimalTwilioClient,
} from "./transferTwilioOps";
import { conferenceNameFor } from "./warmTransfer";

function fakeClient() {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ sid: string; opts: Record<string, unknown> }> = [];
  const calls = ((sid: string) => ({
    update: async (opts: Record<string, unknown>) => {
      updated.push({ sid, opts });
      return {};
    },
  })) as unknown as MinimalTwilioClient["calls"];
  calls.create = async (opts: Record<string, unknown>) => {
    created.push(opts);
    return { sid: "CAoffice" };
  };
  return { client: { calls } as MinimalTwilioClient, created, updated };
}

describe("both legs land in the same room", () => {
  it("puts caller and office in the conference derived from the caller's SID", () => {
    const name = conferenceNameFor("CAcaller");
    expect(buildCallerConferenceTwiml({ conferenceName: name })).toContain(name);
    expect(buildOfficeAcceptTwiml({ conferenceName: name })).toContain(name);
  });

  it("labels the two participants differently, so a conference log is readable", () => {
    expect(buildCallerConferenceTwiml({ conferenceName: "c" })).toContain('participantLabel="caller"');
    expect(buildOfficeAcceptTwiml({ conferenceName: "c" })).toContain('participantLabel="office"');
  });

  it("ends the conference when either party leaves, never stranding the other", () => {
    for (const twiml of [
      buildCallerConferenceTwiml({ conferenceName: "c" }),
      buildOfficeAcceptTwiml({ conferenceName: "c" }),
    ]) {
      expect(twiml).toContain('endConferenceOnExit="true"');
      expect(twiml).toContain('startConferenceOnEnter="true"');
    }
  });

  it("plays no hold music to the caller — the office is already in the room", () => {
    const twiml = buildCallerConferenceTwiml({ conferenceName: "c" });
    expect(twiml).not.toContain("waitUrl");
    expect(twiml).not.toContain("holdmusic");
  });
});

describe("escaping", () => {
  it("escapes a callerId rather than emitting a broken attribute", () => {
    const twiml = buildCallerConferenceTwiml({
      conferenceName: "c",
      callerId: '+1555"><Hangup/><Dial>',
    });
    expect(twiml).not.toContain('"><Hangup/>');
    expect(twiml).toContain("&quot;");
  });

  it("escapes an ampersand in a conference name", () => {
    expect(buildCallerConferenceTwiml({ conferenceName: "a&b" })).toContain("a&amp;b");
  });

  it("omits the callerId attribute entirely when none is configured", () => {
    expect(buildCallerConferenceTwiml({ conferenceName: "c" })).not.toContain("callerId=");
  });
});

describe("the adapter", () => {
  it("dials the office with the briefing and the ring timeout", async () => {
    const { client, created } = fakeClient();
    const ops = createTransferTwilioOps(client, { fromNumber: "+15550000000", log: () => undefined });
    const out = await ops.createOfficeLeg({
      to: "+17149564300",
      from: "+15550000000",
      twiml: "<Response/>",
      timeoutSeconds: 45,
    });
    expect(out.sid).toBe("CAoffice");
    expect(created[0]).toMatchObject({ to: "+17149564300", timeout: 45 });
  });

  it("redirects the caller by replacing their TwiML, which is what ends the stream", async () => {
    const { client, updated } = fakeClient();
    const ops = createTransferTwilioOps(client, { fromNumber: "+15550000000", log: () => undefined });
    await ops.redirectCallerToConference({
      callerCallSid: "CAcaller",
      conferenceName: "runtime_xfer_CAcaller",
    });
    expect(updated[0].sid).toBe("CAcaller");
    expect(String(updated[0].opts.twiml)).toContain("runtime_xfer_CAcaller");
  });

  it("prefers a per-call callerId over the configured default", async () => {
    const { client, updated } = fakeClient();
    const ops = createTransferTwilioOps(client, {
      fromNumber: "+15550000000",
      callerId: "+15551111111",
      log: () => undefined,
    });
    await ops.redirectCallerToConference({
      callerCallSid: "CAcaller",
      conferenceName: "c",
      callerId: "+15552222222",
    });
    expect(String(updated[0].opts.twiml)).toContain("+15552222222");
    expect(String(updated[0].opts.twiml)).not.toContain("+15551111111");
  });

  it("hangs up an office leg by completing it, not by redirecting it", async () => {
    const { client, updated } = fakeClient();
    const ops = createTransferTwilioOps(client, { fromNumber: "+1", log: () => undefined });
    await ops.endCall("CAoffice");
    expect(updated[0]).toEqual({ sid: "CAoffice", opts: { status: "completed" } });
  });
});

describe("the two dead ends the office can hit", () => {
  it("tells a late presser the transfer is gone rather than bridging them", () => {
    const twiml = buildExpiredTransferTwiml();
    expect(twiml).toContain("no longer waiting");
    expect(twiml).toContain("<Hangup/>");
    expect(twiml).not.toContain("<Conference");
  });

  it("hangs up silently on a decline, with no conference", () => {
    expect(buildDeclinedTransferTwiml()).not.toContain("<Conference");
    expect(buildDeclinedTransferTwiml()).toContain("<Hangup/>");
  });
});
