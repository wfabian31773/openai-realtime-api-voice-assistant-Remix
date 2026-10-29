import { describe, expect, it, vi } from "vitest";
import { createSqlPluginStore, type SqlExec } from "./sqlStore";
import { operatorLineEnabled } from "./operatorLineSettings";
import { MemoryPluginStore } from "./store";

describe("durable operator settings and messages", () => {
  it("claims notifications with an atomic conflict guard shared across SQL store instances", async () => {
    const eventId = `opline:CA${"a".repeat(32)}:completed`;
    const exec = vi.fn<SqlExec>().mockResolvedValueOnce([{ event_id: eventId }]).mockResolvedValueOnce([]);
    expect(await createSqlPluginStore(exec).claimOperatorNotification(eventId)).toBe(true);
    expect(await createSqlPluginStore(exec).claimOperatorNotification(eventId)).toBe(false);
    expect(exec.mock.calls[0][0]).toContain("INSERT INTO plugin_operator_notifications (event_id)");
    expect(exec.mock.calls[0][0]).toContain("ON CONFLICT DO NOTHING RETURNING event_id");
    expect(exec.mock.calls[0][1]).toEqual([eventId]);
  });

  it("uses the env hard default, the persisted switch and fail-closed storage", async () => {
    const store = new MemoryPluginStore();
    for (const flag of [undefined, "false", "TRUE", "1"]) expect(await operatorLineEnabled({ OPERATOR_LINE_INBOUND_ENABLED: flag }, store)).toBe(false);
    expect(await operatorLineEnabled({ OPERATOR_LINE_INBOUND_ENABLED: "true" }, store)).toBe(true);
    await store.setOperatorLineEnabled(false, "staff");
    expect(await operatorLineEnabled({ OPERATOR_LINE_INBOUND_ENABLED: "true" }, store)).toBe(false);
    expect(await operatorLineEnabled({ OPERATOR_LINE_INBOUND_ENABLED: "true" }, null)).toBe(false);
    vi.spyOn(store, "getOperatorLineEnabled").mockRejectedValue(new Error("private database error"));
    expect(await operatorLineEnabled({ OPERATOR_LINE_INBOUND_ENABLED: "true" }, store)).toBe(false);
  });

  it("reads and updates the shared persisted setting without overriding an env off", async () => {
    let value: string | undefined;
    const exec = vi.fn<SqlExec>().mockImplementation(async (sql, params) => {
      if (sql.startsWith("SELECT")) return value === undefined ? [] : [{ value }];
      value = params![0] as string;
      return [];
    });
    const first = createSqlPluginStore(exec);
    expect(await first.getOperatorLineEnabled()).toBe(true);
    await first.setOperatorLineEnabled(false, "staff-id");
    // Another adapter instance observes the same durable row.
    const second = createSqlPluginStore(exec);
    expect(await second.getOperatorLineEnabled()).toBe(false);
    expect(exec.mock.calls[1][0]).toContain("ON CONFLICT (key) DO UPDATE");
    expect(exec.mock.calls[1][1]).toEqual(["false", "staff-id"]);
    await second.setOperatorLineEnabled(true, "staff-id");
    expect(await operatorLineEnabled({ OPERATOR_LINE_INBOUND_ENABLED: "false" }, first)).toBe(false);
    value = "malformed";
    expect(await first.getOperatorLineEnabled()).toBe(false);
  });

  it("parameterizes SMS content and uses an atomic first-write-wins MessageSid", async () => {
    const record = { message_sid: `SM${"a".repeat(32)}`, caller_number: "+15555550123", body: "PRIVATE ' SMS", received_at: new Date().toISOString(), fetch_url: "https://fleet.example/sms/id" };
    const exec = vi.fn<SqlExec>().mockResolvedValueOnce([record]).mockResolvedValueOnce([]).mockResolvedValueOnce([record]);
    const store = createSqlPluginStore(exec);
    const input = { messageSid: record.message_sid, callerNumber: record.caller_number, body: record.body, receivedAt: new Date(record.received_at), fetchUrl: record.fetch_url };
    expect(await store.saveOperatorSms(input)).toEqual(input);
    expect(await store.saveOperatorSms(input)).toBeNull();
    expect(await store.getOperatorSms(input.messageSid)).toEqual(input);
    expect(exec.mock.calls[0][0]).toContain("ON CONFLICT (message_sid) DO NOTHING RETURNING *");
    expect(exec.mock.calls[0][0]).not.toContain(record.body);
    expect(exec.mock.calls[0][1]).toContain(record.body);
  });

  it("atomically merges recording and transcription fields and binds updates to one CallSid", async () => {
    const row = { recording_sid: `RE${"b".repeat(32)}`, call_sid: `CA${"c".repeat(32)}`, recording_url: "https://api.twilio.com/private",
      transcript: "PRIVATE transcript", transcription_status: "completed", received_at: new Date().toISOString(), fetch_url: "https://fleet.example/voicemail/id" };
    const exec = vi.fn<SqlExec>().mockResolvedValueOnce([row]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    const store = createSqlPluginStore(exec);
    const input = { recordingSid: row.recording_sid, callSid: row.call_sid, recordingUrl: row.recording_url,
      transcript: row.transcript, transcriptionStatus: row.transcription_status, receivedAt: new Date(row.received_at), fetchUrl: row.fetch_url };
    expect(await store.saveOperatorVoicemail(input)).toEqual(input);
    expect(await store.saveOperatorVoicemail(input)).toBeNull();
    expect(await store.getOperatorVoicemail(input.recordingSid)).toEqual(input);
    const sql = exec.mock.calls[0][0];
    expect(sql).toContain("ON CONFLICT (recording_sid) DO UPDATE");
    expect(sql).toContain("COALESCE(EXCLUDED.transcript, plugin_operator_voicemails.transcript)");
    expect(sql).toContain("plugin_operator_voicemails.call_sid = EXCLUDED.call_sid");
    expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).not.toContain(row.transcript);
    expect(exec.mock.calls[0][1]).toContain(row.transcript);
  });
});
