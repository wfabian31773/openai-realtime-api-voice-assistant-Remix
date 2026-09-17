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
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  parkRecording,
  takeParkedRecording,
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
  it("hands a parked URL back exactly once", () => {
    parkRecording(SID, URL_A);
    expect(takeParkedRecording(SID)).toBe(URL_A);
    expect(takeParkedRecording(SID)).toBeUndefined();
  });

  it("forgets a URL nobody took inside the TTL", () => {
    const t0 = 1_000_000;
    parkRecording(SID, URL_A, t0);
    expect(takeParkedRecording(SID, t0 + PARKED_RECORDING_TTL_MS + 1)).toBeUndefined();
  });

  it("is capped — the oldest entry goes first", () => {
    for (let i = 0; i < PARKED_RECORDING_CAP; i++) parkRecording(`CA${i}`, URL_A, 1_000 + i);
    parkRecording("CAnewest", URL_B, 5_000);
    expect(parkedRecordingCount()).toBe(PARKED_RECORDING_CAP);
    expect(takeParkedRecording("CA0", 5_000)).toBeUndefined();
    expect(takeParkedRecording("CAnewest", 5_000)).toBe(URL_B);
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

describe("the recording-status handler parks a callback that finds no row", () => {
  const routes = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");

  it("the CallSid branch's no-row arm calls parkRecording with the CallSid and the URL", () => {
    expect(routes).toMatch(/import \{ parkRecording \} from '\.\/runtime\/parkedRecordings'/);
    const handler = routes.slice(routes.indexOf(`app.post("/api/voice/recording-status"`));
    const branch = handler.indexOf("target?.by === 'call'");
    const body = handler.slice(branch, handler.indexOf("res.status(200).send('OK')", branch));
    const found = body.indexOf("if (callLog) {");
    const noRow = body.indexOf("} else {", found);
    expect(noRow, "the CallSid branch has no no-row arm").toBeGreaterThan(found);
    expect(body.slice(noRow)).toMatch(/parkRecording\(target\.callSid, recordingUrl\)/);
  });
});
