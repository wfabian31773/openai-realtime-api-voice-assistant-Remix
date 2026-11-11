/**
 * v210: the NPX outreach campaign calls on the federal holidays the
 * practice keeps open. Operator, 2026-11-11, on Veterans Day: "we should be
 * heavily outreaching today, all possible candidates are liable to be home
 * today."
 *
 * Before: the dialler held every NPX call all of 2026-11-11 with reason
 * `holiday` (0 dialled from 9 AM Pacific; 50 contacts due) while the queue
 * lanes took 772 calls, against 685 the Wednesday before. Which holidays the
 * practice keeps open is read from the queue lanes' own calls: Columbus Day
 * 2026-10-12, 136 against 126 the week before; Veterans Day, 772 against
 * 685; Labor Day 2026-09-07, 0 against 104.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALLING_WINDOW,
  holidaysFor,
  isHoliday,
  mayDialNow,
  practiceOpenHolidaysFor,
} from "./callingWindow";
import { NPX_OUTREACH_WINDOW, npxOutreachPolicy } from "../../agents/npxOutreachAgent";

// 11 AM Pacific (PST, UTC-8) on each day.
const VETERANS_DAY_2026 = new Date("2026-11-11T19:00:00Z");
const COLUMBUS_DAY_2026 = new Date("2026-10-12T18:00:00Z"); // PDT, UTC-7
const LABOR_DAY_2026 = new Date("2026-09-07T18:00:00Z");
const THANKSGIVING_2026 = new Date("2026-11-26T19:00:00Z");
const DAY_AFTER_THANKSGIVING_2026 = new Date("2026-11-27T19:00:00Z");
const CHRISTMAS_2026 = new Date("2026-12-25T19:00:00Z");

describe("the holidays the practice keeps open", () => {
  it("are Columbus Day and Veterans Day, and both are federal holidays", () => {
    expect(practiceOpenHolidaysFor(2026)).toEqual(["2026-10-12", "2026-11-11"]);
    for (const d of practiceOpenHolidaysFor(2026)) expect(isHoliday(d)).toBe(true);
  });

  it("follow Veterans Day to the Friday when it falls on a Saturday", () => {
    // 2028-11-11 is a Saturday; the federal holiday is observed on Friday the 10th.
    expect(holidaysFor(2028)).toContain("2028-11-10");
    expect(practiceOpenHolidaysFor(2028)).toContain("2028-11-10");
  });
});

describe("the NPX outreach window", () => {
  it("is the NPX policy's window", () => {
    expect(npxOutreachPolicy.window).toBe(NPX_OUTREACH_WINDOW);
    expect(NPX_OUTREACH_WINDOW.dialOnOpenHolidays).toBe(true);
  });

  it("calls on Veterans Day (the 2026-11-11 case)", () => {
    expect(mayDialNow(VETERANS_DAY_2026, [], NPX_OUTREACH_WINDOW)).toEqual({ ok: true });
  });

  it("calls on Columbus Day", () => {
    expect(mayDialNow(COLUMBUS_DAY_2026, [], NPX_OUTREACH_WINDOW)).toEqual({ ok: true });
  });

  it("still holds on the days the practice is closed", () => {
    for (const day of [LABOR_DAY_2026, THANKSGIVING_2026, DAY_AFTER_THANKSGIVING_2026, CHRISTMAS_2026]) {
      expect(mayDialNow(day, [], NPX_OUTREACH_WINDOW)).toEqual({ ok: false, reason: "holiday" });
    }
  });

  it("keeps the hours and the caps on an open holiday", () => {
    // 8 AM Pacific on Veterans Day is still before the window.
    expect(mayDialNow(new Date("2026-11-11T16:00:00Z"), [], NPX_OUTREACH_WINDOW)).toEqual({
      ok: false,
      reason: "outside_hours",
    });
    // A person already called once today is still held by the daily cap.
    const earlier = { at: new Date("2026-11-11T17:30:00Z") };
    expect(mayDialNow(VETERANS_DAY_2026, [earlier], NPX_OUTREACH_WINDOW)).toEqual({
      ok: false,
      reason: "daily_cap",
    });
  });
});

describe("every other outbound lane", () => {
  it("keeps holding on Veterans Day (the default window does not call on any holiday)", () => {
    expect(DEFAULT_CALLING_WINDOW.dialOnOpenHolidays).toBeFalsy();
    expect(mayDialNow(VETERANS_DAY_2026, [], DEFAULT_CALLING_WINDOW)).toEqual({ ok: false, reason: "holiday" });
    expect(mayDialNow(COLUMBUS_DAY_2026, [], DEFAULT_CALLING_WINDOW)).toEqual({ ok: false, reason: "holiday" });
  });

  it("a window that skips no holidays is unchanged", () => {
    const noHolidays = { ...DEFAULT_CALLING_WINDOW, skipHolidays: false };
    expect(mayDialNow(LABOR_DAY_2026, [], noHolidays)).toEqual({ ok: true });
  });
});
