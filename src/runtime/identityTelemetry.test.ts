/**
 * WHY THE RECORD DID OR DID NOT REACH THE CALL ROW — task #148.
 *
 * Half the assertions run the helper; the rest READ `voiceRuntime.ts`, because
 * a helper test proves the helper and not that anything calls it (recurring
 * failure mode 10) — and on THIS change that is the whole risk: the reason v51
 * produced 0 of 633 could not be found from outside precisely because nothing
 * recorded the read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { VoiceCallRecord } from "./mediaStreamBridge";
import type { RuntimeCallIdentity } from "./callRecord";
import type { IdentityStoreProbe } from "../tools/verifiedIdentity";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";

const log = vi.hoisted(() => ({
  emitted: [] as unknown[][],
  flushed: [] as string[],
  released: [] as Array<string | undefined>,
  /** What each flush answers, in order; empty means "it landed". */
  flushOk: [] as boolean[],
}));
vi.mock("../services/callEventLog", () => ({
  emitCallEvent: (...a: unknown[]) => void log.emitted.push(a),
  flushCallEvents: async (id: string) => {
    log.flushed.push(id);
    return log.flushOk.length ? (log.flushOk.shift() as boolean) : true;
  },
  releaseCallEvents: (id?: string) => void log.released.push(id),
}));

const { identityEvent, logRuntimeIdentity, IDENTITY_EVENT } = await import("./identityTelemetry");

const SID = "CA0000000000000000000000000000ab48";

function record(): VoiceCallRecord {
  return {
    callSid: SID,
    streamSid: "MZ-1",
    slug: "surgery",
    callerPhone: "+15551234567",
    dialedNumber: "+15559876543",
    outcome: "caller_hangup",
    transcript: "",
    toolEvents: [],
    agentTurns: 0,
    interruptions: 0,
    startedAtMs: 0,
    endedAtMs: 1,
  };
}

const probe = (over: Partial<IdentityStoreProbe> = {}): IdentityStoreProbe => ({
  size: 0,
  certainEntries: 0,
  sidCanonical: true,
  hasEntry: false,
  entryCertain: false,
  entryHasDob: false,
  ...over,
});
const REACHED: RuntimeCallIdentity = { patientFound: true, patientName: "Q E" };
const NOTHING: RuntimeCallIdentity = {};

beforeEach(() => {
  log.emitted.length = 0;
  log.flushed.length = 0;
  log.released.length = 0;
  log.flushOk.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the verdict names which of the four happened", () => {
  it("reached_row when the identity was written", () => {
    const ev = identityEvent(REACHED, probe({ size: 1, certainEntries: 1, hasEntry: true, entryCertain: true }));
    expect(ev.data.verdict).toBe("reached_row");
    expect(ev.data.reachedRow).toBe(true);
    expect(ev.level).toBe("info");
  });

  /**
   * The 2026-09-17 shape, if the store turns out to be holding the entry: a
   * certain match that did not reach the row is v51 failing outright.
   */
  it("certain_but_dropped, and WARNS, when a certain entry did not reach the row", () => {
    const ev = identityEvent(NOTHING, probe({ size: 1, certainEntries: 1, hasEntry: true, entryCertain: true }));
    expect(ev.data.verdict).toBe("certain_but_dropped");
    expect(ev.level).toBe("warn");
  });

  /**
   * The hypothesis the production data could not test: entries exist, under
   * other keys. That is the write and the read disagreeing about this SID.
   */
  it("key_mismatch, and WARNS, when the store holds entries but none for this call", () => {
    const ev = identityEvent(NOTHING, probe({ size: 4, certainEntries: 2, hasEntry: false }));
    expect(ev.data.verdict).toBe("key_mismatch");
    expect(ev.level).toBe("warn");
  });

  it("entry_not_certain when the entry survives and its certainty does not", () => {
    const ev = identityEvent(NOTHING, probe({ size: 1, hasEntry: true, entryCertain: false }));
    expect(ev.data.verdict).toBe("entry_not_certain");
    expect(ev.level).toBe("info");
  });

  it("no_entry when the store is empty — the honest absence, not a defect", () => {
    const ev = identityEvent(NOTHING, probe());
    expect(ev.data.verdict).toBe("no_entry");
    expect(ev.level).toBe("info");
  });

  it("sid_not_canonical when the key could never have had an entry", () => {
    const ev = identityEvent(NOTHING, probe({ sidCanonical: false }));
    expect(ev.data.verdict).toBe("sid_not_canonical");
  });

  /**
   * An empty store on THIS call while other calls hold entries is still
   * no_entry, not key_mismatch, when the SID was never usable — otherwise the
   * warn bucket fills with calls whose key was junk.
   */
  it("a non-canonical SID never reads as a key mismatch", () => {
    expect(identityEvent(NOTHING, probe({ size: 3, sidCanonical: false })).data.verdict).toBe("sid_not_canonical");
  });
});

describe("what the row may carry", () => {
  it("is counts and booleans only — no name, no date, no key", () => {
    const ev = identityEvent(REACHED, probe({ size: 1, certainEntries: 1, hasEntry: true, entryCertain: true, entryHasDob: true }));
    const serialised = JSON.stringify(ev.data);
    for (const leak of ["Q E", "Quill", "1959", SID, "+1555"]) {
      expect(serialised).not.toContain(leak);
    }
    for (const [k, v] of Object.entries(ev.data)) {
      if (k === "verdict") continue;
      expect(["number", "boolean"], `${k} must be a count or a boolean`).toContain(typeof v);
    }
  });

  it("writes one row for EVERY call — an empty store is the finding, not a reason to skip", async () => {
    await logRuntimeIdentity(record(), NOTHING, probe(), { callLogId: "row-1" });
    expect(log.emitted).toHaveLength(1);
    const [sid, level, category, message] = log.emitted[0];
    expect(sid).toBe(SID);
    expect(category).toBe("tool");
    expect(message).toBe(IDENTITY_EVENT);
    expect(level).toBe("info");
  });
});

describe("durability, the rule round 9 of #321 established", () => {
  it("releases the buffer only once the flush has landed", async () => {
    expect(await logRuntimeIdentity(record(), NOTHING, probe(), {}, { backoffMs: [], sleep: async () => {} })).toBe(true);
    expect(log.released).toEqual([SID]);
  });

  it("keeps the buffer for the reaper when every attempt fails", async () => {
    log.flushOk.push(false, false, false);
    const durable = await logRuntimeIdentity(record(), NOTHING, probe(), {}, { backoffMs: [1, 1], sleep: async () => {} });
    expect(durable).toBe(false);
    // Three attempts (one plus two backoffs) and NOT released — a database
    // blip must not delete the only copy of the measurement it made necessary.
    expect(log.flushed).toHaveLength(3);
    expect(log.released).toEqual([]);
  });

  it("retries and releases when a later attempt lands", async () => {
    log.flushOk.push(false);
    expect(await logRuntimeIdentity(record(), NOTHING, probe(), {}, { backoffMs: [1], sleep: async () => {} })).toBe(true);
    expect(log.released).toEqual([SID]);
  });
});

/**
 * THE WIRING. Read from the source, because the helper being correct says
 * nothing about the runtime calling it — and because the probe must be taken
 * at the same moment as the read it describes.
 */
describe("the runtime's teardown", () => {
  const src = readFileSync(new URL("./voiceRuntime.ts", import.meta.url), "utf8");

  it("takes the identity and the probe together, BEFORE the row is written", () => {
    const readAt = src.indexOf("identityForRow(record.callSid)");
    const probeAt = src.indexOf("identityStoreProbe(record.callSid)");
    const writeAt = src.indexOf("persistCall(record, identity)");
    expect(readAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(readAt);
    expect(writeAt).toBeGreaterThan(probeAt);
  });

  it("hands both to the identity log, with the row id", () => {
    expect(src).toContain("logIdentity(record, identity, identityProbe, { callLogId })");
  });

  it("defaults the seam to the real writer", () => {
    expect(src).toContain("options.logIdentity ?? logRuntimeIdentity");
  });

  it("never awaits it — telemetry must not hold teardown", () => {
    const at = src.indexOf("logIdentity(record, identity, identityProbe");
    expect(src.slice(Math.max(0, at - 40), at)).toContain("void ");
  });
});
