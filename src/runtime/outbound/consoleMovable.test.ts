/**
 * The live movable list (v107): read from the Console the way the Console's
 * own worklist reads it, re-checked per appointment at the dial. Synthetic
 * rows only — no Console is opened.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MOVABLE_PARK_MS,
  MOVABLE_REFRESH_MS,
  MOVABLE_SELECT,
  consoleMovableContactSource,
  consoleMovableSource,
  e164,
  movableReader,
  movableToContact,
  pacificToday,
  rowToMovable,
  type MovableAppointment,
  type MovableReader,
} from "./consoleMovable";

const ROW = {
  appointment_id: "00000000-0000-0000-0000-0000000000a1",
  person_id: "00000000-0000-0000-0000-0000000000b1",
  first_name: "Testa",
  last_name: "Synthetic",
  date_of_birth: new Date("1950-01-02T00:00:00Z"),
  cell_phone: "(555) 555-0111",
  home_phone: "555-555-0122",
  appointment_date: "2041-03-20",
  begin_time: "0900",
  office: "Test Office",
  event_name: "Comprehensive Exam",
  provider_name: "Test Provider",
  partners: ["Partner One"],
  payer: "Test Group CAP",
  built_at: "2041-03-05T18:17:00Z",
};

describe("one movable appointment", () => {
  it("carries the person base's phone — cell first — and date of birth", () => {
    const m = rowToMovable(ROW);
    expect(m).toMatchObject({
      appointmentId: ROW.appointment_id,
      personId: ROW.person_id,
      phone: "+15555550111",
      dateOfBirth: "1950-01-02",
      appointmentDate: "2041-03-20",
      partners: ["Partner One"],
    });
  });

  it("falls back to the home phone, and holds no number rather than a bad one", () => {
    expect(rowToMovable({ ...ROW, cell_phone: "555-0111" }).phone).toBe("+15555550122");
    expect(rowToMovable({ ...ROW, cell_phone: null, home_phone: "" }).phone).toBeNull();
    expect(e164("1 (555) 555-0111")).toBe("+15555550111");
    expect(e164("+447911123456")).toBeNull();
  });

  it("becomes a queue row keyed on the appointment, with the date of birth where a returned call reads it", () => {
    const c = movableToContact(rowToMovable(ROW));
    expect(c.externalRef).toBe(ROW.appointment_id);
    expect(c.data).toMatchObject({ source: "console_movable", date_of_birth: "1950-01-02", person_id: ROW.person_id });
  });
});

describe("the medical group (the NPX outreach offer matches on it)", () => {
  it("is read from the cache's payer, carried on the row and onto the queue row", () => {
    expect(MOVABLE_SELECT).toMatch(/\br\.payer\b/);
    expect(rowToMovable(ROW).medicalGroup).toBe("Test Group CAP");
    expect(movableToContact(rowToMovable(ROW)).data).toMatchObject({ medical_group: "Test Group CAP" });
  });

  it("is null, not an empty string, when the cache has none", () => {
    expect(rowToMovable({ ...ROW, payer: null }).medicalGroup).toBeNull();
    expect(rowToMovable({ ...ROW, payer: "  " }).medicalGroup).toBeNull();
  });
});

describe("the read itself", () => {
  it("is the Console worklist's own joins: the hourly cache, the LIVE appointment row, the LIVE person row", () => {
    expect(MOVABLE_SELECT).toContain("from public.capacity_movable_cache r");
    expect(MOVABLE_SELECT).toContain("join public.si_appointment_facts f on f.appointment_id = r.appointment_id");
    expect(MOVABLE_SELECT).toContain("join public.patients_master pm on pm.person_id = r.person_id");
    // A cancellation or a reschedule leaves the list the moment it lands.
    expect(MOVABLE_SELECT).toContain("not coalesce(f.is_cancelled, false)");
    expect(MOVABLE_SELECT).toContain("not coalesce(f.is_rescheduled, false)");
    expect(MOVABLE_SELECT).toContain("where r.in_reach");
    expect(MOVABLE_SELECT).toContain("f.appointment_date >= $1::date");
  });

  it("reads both dates as text, so the process's time zone cannot move them a day", () => {
    expect(MOVABLE_SELECT).toContain("to_char(pm.date_of_birth, 'YYYY-MM-DD') as date_of_birth");
    expect(MOVABLE_SELECT).toContain("to_char(f.appointment_date, 'YYYY-MM-DD') as appointment_date");
    // No bare date column is selected beside them.
    expect(MOVABLE_SELECT).not.toMatch(/\spm\.date_of_birth,/);
    expect(MOVABLE_SELECT).not.toMatch(/\sf\.appointment_date,/);
    expect(rowToMovable({ ...ROW, date_of_birth: "1950-01-02", appointment_date: "2041-03-20" })).toMatchObject({
      dateOfBirth: "1950-01-02",
      appointmentDate: "2041-03-20",
    });
  });

  it("asks for today's list, and for one appointment by its id", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const reader = movableReader(async (text, values) => {
      calls.push({ text, values });
      return { rows: [ROW] };
    });
    await reader.list("2041-03-05");
    expect(calls[0].values).toEqual(["2041-03-05"]);
    expect(await reader.current(ROW.appointment_id, "2041-03-05")).toMatchObject({ appointmentId: ROW.appointment_id });
    expect(calls[1].text).toContain("and r.appointment_id = $2::uuid");
    expect(calls[1].values).toEqual(["2041-03-05", ROW.appointment_id]);
  });

  it("counts an appointment as over when it was cancelled or moved, its date passed, or it is gone", async () => {
    const over = (rows: Record<string, unknown>[]) =>
      movableReader(async () => ({ rows })).isOver(ROW.appointment_id, "2041-03-05");
    expect(await over([{ over: true }])).toBe(true);
    expect(await over([])).toBe(true);
    expect(await over([{ over: false }])).toBe(false);
    const text = readFileSync("src/runtime/outbound/consoleMovable.ts", "utf8");
    expect(text).toContain("coalesce(is_cancelled, false) or coalesce(is_rescheduled, false)");
    expect(text).toContain("or appointment_date < $2::date as over");
  });

  it("goes over a read-only, bounded connection of its own", () => {
    const text = readFileSync("src/runtime/outbound/consoleMovable.ts", "utf8");
    expect(text).toContain('options: "-c default_transaction_read_only=on -c statement_timeout=8000"');
    expect(text).toContain("env.OBS_CONSOLE_DATABASE_URL");
  });

  it("is not available where the Console is not configured", async () => {
    const saved = process.env.OBS_CONSOLE_DATABASE_URL;
    delete process.env.OBS_CONSOLE_DATABASE_URL;
    try {
      expect(await consoleMovableContactSource()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.OBS_CONSOLE_DATABASE_URL = saved;
    }
  });
});

describe("as a campaign's contact source", () => {
  const m: MovableAppointment = rowToMovable(ROW);
  const reader = (over: Partial<MovableReader>): MovableReader => ({
    list: async () => [m],
    current: async () => m,
    isOver: async () => false,
    ...over,
  });

  it("refreshes every fifteen minutes and parks a row that left the list until the hourly rebuild", () => {
    const s = consoleMovableSource(reader({}));
    expect(s.refreshEveryMs).toBe(MOVABLE_REFRESH_MS);
    expect(s.parkMs).toBe(MOVABLE_PARK_MS);
  });

  it("lists in the practice's day, not the server's", async () => {
    let asked = "";
    const s = consoleMovableSource(reader({ list: async (today) => ((asked = today), [m]) }));
    // 05:00 UTC on 6 March is still 5 March in Pacific time.
    await s.list(new Date("2041-03-06T05:00:00Z"));
    expect(asked).toBe("2041-03-05");
    expect(pacificToday(new Date("2041-03-06T05:00:00Z"))).toBe("2041-03-05");
  });

  it("re-checks one appointment: current with today's phone, gone when it is over, off the list otherwise", async () => {
    const now = new Date("2041-03-05T18:00:00Z");
    expect(await consoleMovableSource(reader({})).recheck(m.appointmentId, now)).toMatchObject({
      state: "current",
      contact: { phone: "+15555550111" },
    });
    expect(
      await consoleMovableSource(reader({ current: async () => null, isOver: async () => true })).recheck(m.appointmentId, now),
    ).toEqual({ state: "gone" });
    expect(
      await consoleMovableSource(reader({ current: async () => null, isOver: async () => false })).recheck(m.appointmentId, now),
    ).toEqual({ state: "off_list" });
  });

  it("lets a Console that cannot answer throw, so the dialler rings nobody on it", async () => {
    const s = consoleMovableSource(reader({ current: async () => Promise.reject(new Error("console down")) }));
    await expect(s.recheck(m.appointmentId, new Date())).rejects.toThrow("console down");
  });
});
