/**
 * src/runtime/recordingBeatsTheRow.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A RECORDING CALLBACK THAT BEATS ITS CALL ROW IS PARKED, NOT DROPPED —
 * Codex P2 on #321, round 2.
 *
 * The runtime records from the stream's first frame, before the row opens,
 * so a setup hangup or a slow row open can deliver Twilio's completed-
 * recording callback to a handler that finds no row. It answered 200, and
 * Twilio does not retry a 200. The handler now parks the URL by CallSid and
 * the teardown persist takes it onto the row it writes — before the write,
 * and again after it, so a callback landing in between cannot fall in the
 * gap. The wiring is read from source (failure mode 10): a store that works
 * proves nothing about whether the handler parks into it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  parkRecording,
  peekParkedRecording,
  releaseParkedRecording,
  landRecording,
  clearParkedRecordings,
  parkedRecordingCount,
  PARKED_RECORDING_TTL_MS,
  PARKED_RECORDING_CAP,
} from "./parkedRecordings";
import {
  persistRuntimeCall,
  toConflictUpdate,
  toCallLogRow,
  type RuntimeCallLogRow,
} from "./callRecord";
import type { VoiceCallRecord } from "./mediaStreamBridge";

const SID = "CA00000000000000000000000000000abc";
const URL_A = "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1";
const URL_B = "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE2";

function record(over: Partial<VoiceCallRecord> = {}): VoiceCallRecord {
  return {
    callSid: SID,
    streamSid: "MZ-1",
    slug: "optical",
    callerPhone: "+15551234567",
    dialedNumber: "+15559876543",
    outcome: "caller_hangup",
    transcript: "",
    toolEvents: [],
    agentTurns: 0,
    interruptions: 0,
    startedAtMs: 1_000_000,
    endedAtMs: 1_002_000,
    ...over,
  };
}

type Write = { row: RuntimeCallLogRow; update: Partial<RuntimeCallLogRow> };
function recordingUpsert(onWrite?: (n: number) => void) {
  const writes: Write[] = [];
  const upsert = async (row: RuntimeCallLogRow, update: Partial<RuntimeCallLogRow>) => {
    writes.push({ row: { ...row }, update: { ...update } });
    onWrite?.(writes.length);
  };
  return { writes, upsert };
}

beforeEach(() => clearParkedRecordings());

describe("the parking store", () => {
  it("keeps a parked URL until the write that carried it is released — reading does not consume", () => {
    parkRecording(SID, URL_A);
    expect(peekParkedRecording(SID)).toBe(URL_A);
    expect(peekParkedRecording(SID)).toBe(URL_A);
    releaseParkedRecording(SID, URL_A);
    expect(peekParkedRecording(SID)).toBeUndefined();
  });

  it("a release for a URL that was since replaced keeps the newer one", () => {
    parkRecording(SID, URL_A);
    parkRecording(SID, URL_B);
    releaseParkedRecording(SID, URL_A);
    expect(peekParkedRecording(SID)).toBe(URL_B);
  });

  it("forgets a URL nobody took inside the TTL", () => {
    const t0 = 1_000_000;
    parkRecording(SID, URL_A, t0);
    expect(peekParkedRecording(SID, t0 + PARKED_RECORDING_TTL_MS + 1)).toBeUndefined();
  });

  it("is capped — the oldest entry goes first", () => {
    for (let i = 0; i < PARKED_RECORDING_CAP; i++) parkRecording(`CA${i}`, URL_A, 1_000 + i);
    parkRecording("CAnewest", URL_B, 5_000);
    expect(parkedRecordingCount()).toBe(PARKED_RECORDING_CAP);
    expect(peekParkedRecording("CA0", 5_000)).toBeUndefined();
    expect(peekParkedRecording("CAnewest", 5_000)).toBe(URL_B);
  });
});

/**
 * CODEX P2, ROUND 4: the URL was taken off the store BEFORE the upsert, so a
 * write that threw lost the only copy. It now stays parked until the write
 * that carried it has succeeded, and the teardown write itself is retried.
 */
describe("a parked URL survives a write that fails", () => {
  const noWait = { backoffMs: [0, 0] as readonly number[], sleep: async () => {} };

  it("stays parked, and the persist reports false, when every attempt throws", async () => {
    parkRecording(SID, URL_A);
    let attempts = 0;
    const upsert = async () => { attempts++; throw new Error("connection reset"); };
    expect(await persistRuntimeCall(record(), {}, upsert, noWait)).toBe(false);
    expect(attempts).toBe(3);
    expect(peekParkedRecording(SID)).toBe(URL_A);
    expect(parkedRecordingCount()).toBe(1);
  });

  it("lands on the retry when the first attempt throws", async () => {
    parkRecording(SID, URL_A);
    const writes: RuntimeCallLogRow[] = [];
    let attempts = 0;
    const upsert = async (row: RuntimeCallLogRow) => {
      attempts++;
      if (attempts === 1) throw new Error("connection reset");
      writes.push({ ...row });
    };
    expect(await persistRuntimeCall(record(), {}, upsert, noWait)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].recordingUrl).toBe(URL_A);
    expect(parkedRecordingCount()).toBe(0);
  });

  /**
   * REWRITTEN, NOT LOOSENED — Codex P2, #322 round 5. This asserted `false`
   * here, which is the defect written down: the ROW landed on the first upsert
   * and only the late recording URL did not, and the one consumer of that
   * boolean is v58's identity telemetry, which turns it into
   * `row_write_failed` — the write-stage measurement corrupted by exactly the
   * intermittent failure it exists to diagnose. The property this test is
   * really for is that the URL stays parked; that is unchanged and still
   * asserted.
   */
  it("a URL parked during the write stays parked when ITS write fails, and the ROW still reports true", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
    try {
      let n = 0;
      const upsert = async () => {
        n++;
        if (n === 1) { parkRecording(SID, URL_B); return; }
        throw new Error("connection reset");
      };
      expect(await persistRuntimeCall(record(), {}, upsert, noWait)).toBe(true);
      expect(peekParkedRecording(SID)).toBe(URL_B);
      // And it says which of the two writes failed, because "the row did not
      // land" is the alarming one and this is not it.
      expect(errors.join(" ")).toContain("late recording URL did not");
      expect(errors.join(" ")).not.toContain("call_logs write failed");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The control on the sentence above: when the ROW itself never lands, the
   * answer is still false and the log still says so. A fix that reported the
   * primary write by always returning true would pass the test above and fail
   * this one.
   */
  it("still reports false, with the row's own log line, when the FIRST write never lands", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
    try {
      const upsert = async () => { throw new Error("connection reset"); };
      expect(await persistRuntimeCall(record(), {}, upsert, noWait)).toBe(false);
      expect(errors.join(" ")).toContain("call_logs write failed");
      expect(errors.join(" ")).not.toContain("late recording URL did not");
    } finally {
      spy.mockRestore();
    }
  });

  it("the default backoff is short and bounded", async () => {
    const { PERSIST_RETRY_BACKOFF_MS } = await import("./callRecord");
    expect(PERSIST_RETRY_BACKOFF_MS.length).toBeGreaterThanOrEqual(1);
    expect(PERSIST_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  });
});

describe("the teardown persist takes a parked URL onto the row", () => {
  it("writes a URL parked before the persist onto the row AND the conflict update", async () => {
    parkRecording(SID, URL_A);
    const { writes, upsert } = recordingUpsert();
    expect(await persistRuntimeCall(record(), {}, upsert)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].row.recordingUrl).toBe(URL_A);
    // The row may already exist (opened before the deadline, the callback in
    // the window between the open and this write): the conflict arm must
    // carry it too, or the update path drops it.
    expect(writes[0].update.recordingUrl).toBe(URL_A);
    expect(parkedRecordingCount()).toBe(0);
  });

  it("a URL parked DURING the write still lands, on a second write", async () => {
    const { writes, upsert } = recordingUpsert((n) => {
      if (n === 1) parkRecording(SID, URL_B);
    });
    expect(await persistRuntimeCall(record(), {}, upsert)).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[0].row.recordingUrl).toBeUndefined();
    expect(writes[1].row.recordingUrl).toBe(URL_B);
    expect(writes[1].update.recordingUrl).toBe(URL_B);
    expect(parkedRecordingCount()).toBe(0);
  });

  /**
   * THE GUARD ON THE GUARD. In the common case the callback finds the row
   * and writes the column itself; the teardown's conflict update must then
   * not mention recording_url at all, or it overwrites a URL with nothing.
   */
  it("with nothing parked, the write does not touch recording_url", async () => {
    const { writes, upsert } = recordingUpsert();
    await persistRuntimeCall(record(), {}, upsert);
    expect(writes).toHaveLength(1);
    expect("recordingUrl" in writes[0].row).toBe(false);
    expect("recordingUrl" in writes[0].update).toBe(false);
    expect("recordingUrl" in toConflictUpdate(toCallLogRow(record()))).toBe(false);
  });

  it("a parked URL for ANOTHER call is left alone", async () => {
    parkRecording("CA00000000000000000000000000000fff", URL_A);
    const { writes, upsert } = recordingUpsert();
    await persistRuntimeCall(record(), {}, upsert);
    expect("recordingUrl" in writes[0].row).toBe(false);
    expect(parkedRecordingCount()).toBe(1);
  });
});

describe("the recording-status handler lands every CallSid callback through landRecording", () => {
  const routes = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");

  it("the CallSid branch hands the callback to landRecording and does not look the row up itself first", () => {
    expect(routes).toMatch(/import \{ landRecording \} from '\.\/runtime\/parkedRecordings'/);
    const handler = routes.slice(routes.indexOf(`app.post("/api/voice/recording-status"`));
    const branch = handler.indexOf("target?.by === 'call'");
    const body = handler.slice(branch, handler.indexOf("res.status(200).send('OK')", branch));
    const landing = body.indexOf("landRecording(target.callSid, recordingUrl");
    expect(landing, "the CallSid branch does not call landRecording").toBeGreaterThan(-1);
    // A lookup BEFORE the landing is the round-7 race put back: the park must
    // precede it, and only the lander holds that order.
    const lookup = body.indexOf("getCallLogBySid(");
    expect(lookup === -1 || lookup > landing, "the branch looks the row up before parking").toBe(true);
  });
});

describe("the callback parks BEFORE it looks — the race with the teardown (Codex P2, round 7)", () => {
  const deps = (row: { id: string } | undefined, onWrite?: () => void) => {
    const writes: Array<[string, string]> = [];
    const pushes: Array<[string, string]> = [];
    let sawParkedDuringLookup: string | undefined;
    return {
      writes,
      pushes,
      seen: () => sawParkedDuringLookup,
      deps: {
        findRow: async () => {
          sawParkedDuringLookup = peekParkedRecording(SID);
          return row;
        },
        writeUrl: async (id: string, url: string) => {
          onWrite?.();
          writes.push([id, url]);
        },
        push: (id: string, url: string) => {
          pushes.push([id, url]);
        },
      },
    };
  };

  it("the URL is already parked when the row is looked up", async () => {
    const d = deps({ id: "row-1" });
    expect(await landRecording(SID, URL_A, d.deps)).toBe("written");
    expect(d.seen()).toBe(URL_A);
    expect(d.writes).toEqual([["row-1", URL_A]]);
    expect(d.pushes).toEqual([["row-1", URL_A]]);
    expect(parkedRecordingCount()).toBe(0);
  });

  it("no row: the URL stays parked for the persist, nothing is written or pushed", async () => {
    const d = deps(undefined);
    expect(await landRecording(SID, URL_A, d.deps)).toBe("parked");
    expect(d.writes).toEqual([]);
    expect(d.pushes).toEqual([]);
    expect(peekParkedRecording(SID)).toBe(URL_A);
  });

  it("the teardown persists and peeks WHILE the lookup is in flight, and the lookup then reports no row — the URL still lands", async () => {
    const { writes, upsert } = recordingUpsert();
    const d = {
      findRow: async () => {
        // The teardown runs its whole persist — write, then the late peek —
        // inside the callback's lookup window, and the lookup's snapshot
        // predates the row.
        expect(await persistRuntimeCall(record(), {}, upsert)).toBe(true);
        return undefined;
      },
      writeUrl: async () => undefined,
    };
    expect(await landRecording(SID, URL_A, d)).toBe("parked");
    // Parked before the lookup, so the teardown's peek found it and wrote it.
    expect(writes.some((w) => w.row.recordingUrl === URL_A || w.update.recordingUrl === URL_A)).toBe(true);
    expect(parkedRecordingCount()).toBe(0);
  });

  it("a write that throws leaves the URL parked", async () => {
    const d = {
      findRow: async () => ({ id: "row-1" }),
      writeUrl: async () => {
        throw new Error("db down");
      },
    };
    await expect(landRecording(SID, URL_A, d)).rejects.toThrow("db down");
    expect(peekParkedRecording(SID)).toBe(URL_A);
  });
});
