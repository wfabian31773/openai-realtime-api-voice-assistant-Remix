import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlPluginStore, type SqlExec } from "./sqlStore";
import { operatorLineEnabled } from "./operatorLineSettings";
import { MemoryPluginStore } from "./store";

describe("durable operator settings and messages", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("claims notifications with an atomic conflict guard shared across SQL store instances", async () => {
    const eventId = `opline:CA${"a".repeat(32)}:completed`;
    vi.stubEnv("OPERATOR_NOTIFICATION_CLAIM_LEASE_MS", "60000");
    const exec = vi.fn<SqlExec>().mockImplementationOnce(async (_sql, params) => [{ claim_token: params![1] }])
      .mockResolvedValueOnce([]);
    const token = await createSqlPluginStore(exec).claimOperatorNotification(eventId);
    expect(token).toEqual(expect.any(String));
    expect(await createSqlPluginStore(exec).claimOperatorNotification(eventId)).toBeNull();
    expect(exec).toHaveBeenCalledTimes(2);
    const sql = exec.mock.calls[0][0];
    expect(sql).toContain("INSERT INTO plugin_operator_notifications (event_id, claimed_at, claim_token)");
    expect(sql).toContain("VALUES ($1, NOW(), $2)");
    expect(sql).toContain("ON CONFLICT (event_id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at, claim_token = EXCLUDED.claim_token");
    expect(sql).toContain("WHERE plugin_operator_notifications.delivered_at IS NULL");
    expect(sql).toContain("AND plugin_operator_notifications.claimed_at < NOW() - ($3::double precision * INTERVAL '1 millisecond')");
    expect(sql).toContain("RETURNING claim_token");
    expect(exec.mock.calls[0][1]).toEqual([eventId, token, 60_000]);
    expect(exec.mock.calls[1][1]![1]).not.toBe(token);
  });

  it("marks delivery separately and only releases undelivered SQL claims", async () => {
    const eventId = "opline:sms:SM-synthetic";
    const claimToken = "synthetic-claim-token";
    const exec = vi.fn<SqlExec>().mockResolvedValue([]);
    const store = createSqlPluginStore(exec);
    await store.markOperatorNotificationDelivered(eventId, claimToken);
    await store.releaseOperatorNotification(eventId, claimToken);
    expect(exec.mock.calls[0][0]).toContain("UPDATE plugin_operator_notifications SET delivered_at = NOW()");
    expect(exec.mock.calls[1][0]).toContain("DELETE FROM plugin_operator_notifications");
    for (const [sql, params] of exec.mock.calls) {
      expect(sql).toContain("WHERE event_id = $1 AND claim_token = $2 AND delivered_at IS NULL");
      expect(params).toEqual([eventId, claimToken]);
    }
  });

  it("releases failed memory claims while retaining delivered events", async () => {
    const store = new MemoryPluginStore();
    const eventId = "opline:sms:SM-synthetic";
    const firstToken = (await store.claimOperatorNotification(eventId))!;
    expect(firstToken).toEqual(expect.any(String));
    expect(await store.claimOperatorNotification(eventId)).toBeNull();
    expect(store.operatorNotifications.get(eventId)?.deliveredAt).toBeNull();
    await store.releaseOperatorNotification(eventId, firstToken);
    const secondToken = (await store.claimOperatorNotification(eventId))!;
    expect(secondToken).toEqual(expect.any(String));
    expect(secondToken).not.toBe(firstToken);
    // Even an immediate release/reclaim must fence off the previous holder.
    await store.markOperatorNotificationDelivered(eventId, firstToken);
    await store.releaseOperatorNotification(eventId, firstToken);
    expect(store.operatorNotifications.get(eventId)?.deliveredAt).toBeNull();
    await store.markOperatorNotificationDelivered(eventId, secondToken);
    expect(store.operatorNotifications.get(eventId)?.deliveredAt).toBeInstanceOf(Date);
    await store.releaseOperatorNotification(eventId, secondToken);
    expect(await store.claimOperatorNotification(eventId)).toBeNull();
  });

  it("reclaims an abandoned claim exactly once and fences off the stale holder", async () => {
    vi.useFakeTimers();
    const store = new MemoryPluginStore({ operatorNotificationClaimLeaseMs: 60_000 });
    const eventId = "opline:sms:SM-abandoned";
    const staleToken = (await store.claimOperatorNotification(eventId))!;
    await vi.advanceTimersByTimeAsync(60_001);
    const claims = await Promise.all([
      store.claimOperatorNotification(eventId), store.claimOperatorNotification(eventId),
    ]);
    expect(claims.filter((token) => token !== null)).toHaveLength(1);
    expect(claims.filter((token) => token === null)).toHaveLength(1);
    const currentToken = claims.find((token) => token !== null)!;
    expect(currentToken).not.toBe(staleToken);
    const current = structuredClone(store.operatorNotifications.get(eventId));
    await store.markOperatorNotificationDelivered(eventId, staleToken);
    await store.releaseOperatorNotification(eventId, staleToken);
    expect(store.operatorNotifications.get(eventId)).toEqual(current);
    expect(await store.claimOperatorNotification(eventId)).toBeNull();
    await store.markOperatorNotificationDelivered(eventId, currentToken);
    expect(store.operatorNotifications.get(eventId)?.deliveredAt).toBeInstanceOf(Date);
  });

  it("blocks fresh claims through the exact lease boundary without extending them", async () => {
    vi.useFakeTimers();
    const store = new MemoryPluginStore({ operatorNotificationClaimLeaseMs: 60_000 });
    const eventId = "opline:sms:SM-fresh";
    const token = await store.claimOperatorNotification(eventId);
    const initial = structuredClone(store.operatorNotifications.get(eventId));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await store.claimOperatorNotification(eventId)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await store.claimOperatorNotification(eventId)).toBeNull();
    expect(store.operatorNotifications.get(eventId)).toEqual(initial);
    await vi.advanceTimersByTimeAsync(1);
    const reclaimed = await store.claimOperatorNotification(eventId);
    expect(reclaimed).toEqual(expect.any(String));
    expect(reclaimed).not.toBe(token);
  });

  it("never reclaims delivered events even after the lease expires", async () => {
    vi.useFakeTimers();
    const store = new MemoryPluginStore({ operatorNotificationClaimLeaseMs: 60_000 });
    const eventId = "opline:sms:SM-delivered";
    const token = (await store.claimOperatorNotification(eventId))!;
    await store.markOperatorNotificationDelivered(eventId, token);
    const delivered = structuredClone(store.operatorNotifications.get(eventId));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await Promise.all([store.claimOperatorNotification(eventId), store.claimOperatorNotification(eventId)]))
      .toEqual([null, null]);
    await store.releaseOperatorNotification(eventId, token);
    expect(store.operatorNotifications.get(eventId)).toEqual(delivered);
  });

  it.each([undefined, "", "invalid", "0", "-1", "Infinity", "1.5", "9007199254740992", "1500"])(
    "uses the same validated env lease in both stores (%s)", async (setting) => {
      vi.useFakeTimers();
      vi.stubEnv("OPERATOR_NOTIFICATION_CLAIM_LEASE_MS", setting);
      const leaseMs = setting === "1500" ? 1500 : 60_000;
      const exec = vi.fn<SqlExec>().mockResolvedValue([]);
      await createSqlPluginStore(exec).claimOperatorNotification("env-lease");
      expect(exec.mock.calls[0][1]![2]).toBe(leaseMs);
      const store = new MemoryPluginStore();
      await store.claimOperatorNotification("env-lease");
      await vi.advanceTimersByTimeAsync(leaseMs);
      expect(await store.claimOperatorNotification("env-lease")).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(await store.claimOperatorNotification("env-lease")).toEqual(expect.any(String));
    },
  );

  it("allows an explicit lease to override the env in both stores", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPERATOR_NOTIFICATION_CLAIM_LEASE_MS", "60000");
    const options = { operatorNotificationClaimLeaseMs: 250 };
    const exec = vi.fn<SqlExec>().mockResolvedValue([]);
    await createSqlPluginStore(exec, options).claimOperatorNotification("option-lease");
    expect(exec.mock.calls[0][1]![2]).toBe(250);
    const store = new MemoryPluginStore(options);
    await store.claimOperatorNotification("option-lease");
    await vi.advanceTimersByTimeAsync(251);
    expect(await store.claimOperatorNotification("option-lease")).toEqual(expect.any(String));
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
