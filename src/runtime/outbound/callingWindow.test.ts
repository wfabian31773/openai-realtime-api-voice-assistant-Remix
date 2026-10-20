import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTEMPT_CAPS,
  DEFAULT_CALLING_WINDOW,
  holidaysFor,
  isHoliday,
  mayDialNow,
  pacificParts,
} from "./callingWindow";

// 2041-03-05 is a Tuesday. 18:00 UTC is 10:00 Pacific (PST, UTC-8).
const TUE_10AM_PT = new Date("2041-03-05T18:00:00Z");

describe("the Pacific clock", () => {
  it("reads the wall clock in Pacific time, not the server's", () => {
    expect(pacificParts(TUE_10AM_PT)).toEqual({ date: "2041-03-05", hour: 10, weekday: 2 });
    // 07:30 UTC on the 6th is still the 5th in Pacific.
    expect(pacificParts(new Date("2041-03-06T07:30:00Z")).date).toBe("2041-03-05");
  });

  it("follows daylight saving", () => {
    // Mid-July: PDT, UTC-7. 16:00 UTC is 9 AM.
    expect(pacificParts(new Date("2041-07-16T16:00:00Z")).hour).toBe(9);
  });
});

describe("holidays", () => {
  it("moves a Saturday Independence Day to the Friday", () => {
    // 2026-07-04 is a Saturday.
    expect(isHoliday("2026-07-03")).toBe(true);
    expect(isHoliday("2026-07-04")).toBe(false);
  });

  it("closes Thanksgiving and the day after", () => {
    const h = holidaysFor(2026);
    expect(h).toContain("2026-11-26");
    expect(h).toContain("2026-11-27");
  });

  it("does not close an ordinary Tuesday", () => {
    expect(isHoliday("2041-03-05")).toBe(false);
  });
});

describe("mayDialNow", () => {
  it("allows a first call inside the window", () => {
    expect(mayDialNow(TUE_10AM_PT, [])).toEqual({ ok: true });
  });

  it("refuses before 9 AM and from 8 PM, Pacific", () => {
    expect(mayDialNow(new Date("2041-03-05T16:59:00Z"), [])).toEqual({ ok: false, reason: "outside_hours" });
    expect(mayDialNow(new Date("2041-03-06T04:00:00Z"), [])).toEqual({ ok: false, reason: "outside_hours" });
    expect(mayDialNow(new Date("2041-03-06T03:59:00Z"), [])).toEqual({ ok: true });
  });

  it("refuses on a holiday", () => {
    // 2026-11-26, Thanksgiving, 11 AM Pacific.
    expect(mayDialNow(new Date("2026-11-26T19:00:00Z"), [])).toEqual({ ok: false, reason: "holiday" });
  });

  it("refuses a closed day", () => {
    const weekdaysOnly = { ...DEFAULT_CALLING_WINDOW, days: [1, 2, 3, 4, 5] };
    // 2041-03-09 is a Saturday.
    expect(mayDialNow(new Date("2041-03-09T18:00:00Z"), [], weekdaysOnly)).toEqual({
      ok: false,
      reason: "closed_day",
    });
  });

  it("checks the window before the caps, so 10 PM reads as the window", () => {
    const many = Array.from({ length: 9 }, () => ({ at: new Date("2041-03-01T18:00:00Z") }));
    expect(mayDialNow(new Date("2041-03-06T06:00:00Z"), many)).toEqual({ ok: false, reason: "outside_hours" });
  });

  it("allows one call a day by default", () => {
    const earlier = [{ at: new Date("2041-03-05T17:00:00Z") }]; // 9 AM today
    const r = mayDialNow(new Date("2041-03-06T03:00:00Z"), earlier); // 7 PM today
    expect(r).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("allows three calls in any seven days by default", () => {
    const three = [
      { at: new Date("2041-03-01T18:00:00Z") },
      { at: new Date("2041-03-02T18:00:00Z") },
      { at: new Date("2041-03-03T18:00:00Z") },
    ];
    expect(mayDialNow(TUE_10AM_PT, three, DEFAULT_CALLING_WINDOW, { ...DEFAULT_ATTEMPT_CAPS, total: 9 })).toEqual({
      ok: false,
      reason: "weekly_cap",
    });
  });

  it("stops for good at the total cap", () => {
    const three = [
      { at: new Date("2041-01-01T18:00:00Z") },
      { at: new Date("2041-01-10T18:00:00Z") },
      { at: new Date("2041-01-20T18:00:00Z") },
    ];
    expect(mayDialNow(TUE_10AM_PT, three)).toEqual({ ok: false, reason: "total_cap" });
  });

  it("waits the minimum gap after the last attempt", () => {
    // Yesterday 7 PM, 15 hours ago — under the 20-hour default.
    const last = [{ at: new Date("2041-03-05T03:00:00Z") }];
    expect(mayDialNow(TUE_10AM_PT, last)).toEqual({ ok: false, reason: "too_soon" });
  });
});
