import { describe, expect, it } from "vitest";
import {
  activeOverride,
  addDays,
  onCallAt,
  onCallWindow,
  pacificMinute,
  planChain,
  regionKey,
  rotationWeekStart,
} from "./rotation";
import { FINAL_DIRECTOR, IE_DIRECTOR, LA_DIRECTOR, VALLEYS_DIRECTOR, provider, syntheticRotation } from "./testRotation";

// December 2026 is PST (UTC-8): 17:00 Pacific is 01:00Z the next day.
const at = (iso: string) => new Date(iso);

describe("the Pacific clock", () => {
  it("reads the minute, the date and the weekday in Pacific time", () => {
    expect(pacificMinute(at("2026-12-02T00:59:00Z"))).toEqual({ date: "2026-12-01", weekday: 2, minute: 16 * 60 + 59 });
    expect(pacificMinute(at("2026-12-02T01:00:00Z"))).toEqual({ date: "2026-12-01", weekday: 2, minute: 17 * 60 });
  });

  it("moves a date across a month and a year end", () => {
    expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
    expect(addDays("2027-03-01", -7)).toBe("2027-02-22");
  });
});

describe("the four boundaries the operator named", () => {
  const data = syntheticRotation();

  it("Tue 4:59 PM: still the outgoing week, and not on call (weekday daytime)", () => {
    const a = onCallAt(at("2026-12-09T00:59:00Z"), data); // Tue Dec 8, 4:59 PM PST
    expect(a.weekStartsOn).toBe("2026-12-01");
    expect(a.provider?.id).toBe(1);
    expect(a.window).toEqual({ onCall: false, reason: "weekday_daytime" });
  });

  it("Tue 5:00 PM: the incoming provider, on call", () => {
    const a = onCallAt(at("2026-12-09T01:00:00Z"), data); // Tue Dec 8, 5:00 PM PST
    expect(a.weekStartsOn).toBe("2026-12-08");
    expect(a.provider?.id).toBe(2);
    expect(a.window).toEqual({ onCall: true, reason: "off_hours" });
  });

  it("Tue 7:59 AM: the outgoing provider is still on call", () => {
    const a = onCallAt(at("2026-12-15T15:59:00Z"), data); // Tue Dec 15, 7:59 AM PST
    expect(a.weekStartsOn).toBe("2026-12-08");
    expect(a.provider?.id).toBe(2);
    expect(a.window.onCall).toBe(true);
  });

  it("Tue 8:00 AM: the outgoing week, no longer on call", () => {
    const a = onCallAt(at("2026-12-15T16:00:00Z"), data); // Tue Dec 15, 8:00 AM PST
    expect(a.weekStartsOn).toBe("2026-12-08");
    expect(a.provider?.id).toBe(2);
    expect(a.window).toEqual({ onCall: false, reason: "weekday_daytime" });
  });

  it("the first week starts at 5:00 PM on December 1, not before", () => {
    expect(rotationWeekStart(at("2026-12-02T00:59:00Z"))).toBe("2026-11-24");
    expect(rotationWeekStart(at("2026-12-02T01:00:00Z"))).toBe("2026-12-01");
  });

  it("the boundaries hold across the March daylight-saving change", () => {
    // Tue Mar 16 2027 is PDT (UTC-7): 5:00 PM is 00:00Z on the 17th.
    expect(onCallAt(at("2027-03-16T23:59:00Z"), data).provider?.id).toBe(2);
    expect(onCallAt(at("2027-03-17T00:00:00Z"), data).provider?.id).toBe(5);
    // Tue Mar 23 2027, 7:59 AM PDT is 14:59Z; 8:00 AM is 15:00Z.
    expect(onCallWindow(at("2027-03-23T14:59:00Z")).onCall).toBe(true);
    expect(onCallWindow(at("2027-03-23T15:00:00Z")).onCall).toBe(false);
  });
});

describe("the window inside a week", () => {
  it("is on call all weekend and every weeknight", () => {
    expect(onCallWindow(at("2026-12-05T20:00:00Z")).onCall).toBe(true); // Sat noon
    expect(onCallWindow(at("2026-12-06T20:00:00Z")).onCall).toBe(true); // Sun noon
    expect(onCallWindow(at("2026-12-04T03:00:00Z")).onCall).toBe(true); // Thu 7 PM
    expect(onCallWindow(at("2026-12-03T12:00:00Z")).onCall).toBe(true); // Thu 4 AM
  });

  it("is not on call Monday to Friday 8:00 AM to 4:59 PM", () => {
    for (const iso of ["2026-12-07T16:00:00Z", "2026-12-09T20:00:00Z", "2026-12-11T00:59:00Z"]) {
      expect(onCallWindow(at(iso))).toEqual({ onCall: false, reason: "weekday_daytime" });
    }
    expect(onCallWindow(at("2026-12-11T01:00:00Z")).onCall).toBe(true); // Thu 5:00 PM
  });
});

describe("holiday weeks rotate like any other week", () => {
  const data = syntheticRotation();

  it("Christmas Day (a Friday) is on call all day, to that week's provider", () => {
    const a = onCallAt(at("2026-12-25T18:00:00Z"), data); // Fri Dec 25, 10 AM PST
    expect(a.weekStartsOn).toBe("2026-12-22");
    expect(a.provider?.id).toBe(3);
    expect(a.window).toEqual({ onCall: true, reason: "holiday_daytime" });
  });

  it("New Year's Day 2027 (a Friday) belongs to the week of December 29", () => {
    const a = onCallAt(at("2027-01-01T18:00:00Z"), data);
    expect(a.weekStartsOn).toBe("2026-12-29");
    expect(a.provider?.id).toBe(4);
    expect(a.window.reason).toBe("holiday_daytime");
  });

  it("Martin Luther King Day 2027 is on call to the week's provider", () => {
    const a = onCallAt(at("2027-01-18T18:00:00Z"), data); // Mon Jan 18, 10 AM PST
    expect(a.weekStartsOn).toBe("2027-01-12");
    expect(a.provider?.id).toBe(1);
    expect(a.window).toEqual({ onCall: true, reason: "holiday_daytime" });
  });

  it("a holiday the practice keeps open is an ordinary weekday", () => {
    // Columbus Day 2027 is Monday October 11; the offices are open.
    expect(onCallWindow(at("2027-10-11T17:00:00Z"))).toEqual({ onCall: false, reason: "weekday_daytime" });
  });

  it("the day after Thanksgiving is closed and on call", () => {
    expect(onCallWindow(at("2026-11-27T18:00:00Z"))).toEqual({ onCall: true, reason: "holiday_daytime" });
  });
});

describe("overrides decide who, never whether", () => {
  it("a swap for one night replaces the week's provider inside its window only", () => {
    const data = syntheticRotation({
      overrides: [{ id: 1, startsAt: at("2026-12-10T01:00:00Z"), endsAt: at("2026-12-10T16:00:00Z"), providerId: 5 }],
    });
    expect(onCallAt(at("2026-12-10T05:00:00Z"), data)).toMatchObject({ source: "override", provider: { id: 5 } });
    expect(onCallAt(at("2026-12-10T16:00:00Z"), data)).toMatchObject({ source: "schedule", provider: { id: 2 } });
    // The override covers daytime too; it still does not make daytime on call.
    expect(onCallAt(at("2026-12-10T15:00:00Z"), data).window.onCall).toBe(true);
  });

  it("the override with the latest start wins when two overlap", () => {
    const o = activeOverride(at("2026-12-10T05:00:00Z"), [
      { id: 1, startsAt: at("2026-12-09T01:00:00Z"), endsAt: at("2026-12-12T01:00:00Z"), providerId: 5 },
      { id: 2, startsAt: at("2026-12-10T01:00:00Z"), endsAt: at("2026-12-10T09:00:00Z"), providerId: 6 },
    ]);
    expect(o?.providerId).toBe(6);
  });

  it("a cover to a provider since deactivated falls back to the week's provider, and says so", () => {
    const data = syntheticRotation({
      overrides: [{ id: 1, startsAt: at("2026-12-10T01:00:00Z"), endsAt: at("2026-12-10T16:00:00Z"), providerId: 5 }],
    });
    (data.providers as ReturnType<typeof provider>[])[4] = provider(5, "Orange County", { active: false });
    const a = onCallAt(at("2026-12-10T05:00:00Z"), data);
    expect(a).toMatchObject({ source: "schedule", provider: { id: 2 }, note: "override_provider_inactive" });
    expect(a.director).not.toBeNull();
  });

  it("a cover to a provider no longer on file falls back to the week's provider, and says so", () => {
    const data = syntheticRotation({
      overrides: [{ id: 1, startsAt: at("2026-12-10T01:00:00Z"), endsAt: at("2026-12-10T16:00:00Z"), providerId: 999 }],
    });
    expect(onCallAt(at("2026-12-10T05:00:00Z"), data)).toMatchObject({
      source: "schedule",
      provider: { id: 2 },
      note: "override_provider_missing",
    });
  });

  it("a stale cover over a week whose provider is also inactive returns nobody, naming the cover", () => {
    const data = syntheticRotation({
      overrides: [{ id: 1, startsAt: at("2026-12-10T01:00:00Z"), endsAt: at("2026-12-10T16:00:00Z"), providerId: 999 }],
    });
    (data.providers as ReturnType<typeof provider>[])[1] = provider(2, "Los Angeles", { active: false });
    const a = onCallAt(at("2026-12-10T05:00:00Z"), data);
    expect(a.provider).toBeNull();
    expect(a.note).toBe("override_provider_missing");
    expect(a.final?.id).toBe(FINAL_DIRECTOR);
  });

  it("a stale cover on a week nobody is entered for returns nobody, naming the cover", () => {
    const data = syntheticRotation({
      overrides: [{ id: 1, startsAt: at("2028-01-05T01:00:00Z"), endsAt: at("2028-01-05T16:00:00Z"), providerId: 999 }],
    });
    const a = onCallAt(at("2028-01-05T05:00:00Z"), data);
    expect(a.provider).toBeNull();
    expect(a).toMatchObject({ source: "override", note: "override_provider_missing" });
  });

  it("an active cover still covers a week whose scheduled provider was deactivated", () => {
    const data = syntheticRotation({
      overrides: [{ id: 1, startsAt: at("2026-12-10T01:00:00Z"), endsAt: at("2026-12-10T16:00:00Z"), providerId: 5 }],
    });
    (data.providers as ReturnType<typeof provider>[])[1] = provider(2, "Los Angeles", { active: false });
    const a = onCallAt(at("2026-12-10T05:00:00Z"), data);
    expect(a).toMatchObject({ source: "override", provider: { id: 5 } });
    expect(a.note).toBeUndefined();
  });

  it("a whole-week swap is the schedule row itself", () => {
    const data = syntheticRotation();
    (data.schedule as Map<string, number>).set("2026-12-08", 6);
    expect(onCallAt(at("2026-12-09T05:00:00Z"), data).provider?.id).toBe(6);
  });
});

describe("a week nobody is entered for", () => {
  it("says so instead of guessing", () => {
    const a = onCallAt(at("2028-01-05T05:00:00Z"), syntheticRotation());
    expect(a.provider).toBeNull();
    expect(a.note).toBe("no_schedule_for_week");
    expect(a.final?.id).toBe(FINAL_DIRECTOR);
  });

  it("an inactive provider is not returned", () => {
    const data = syntheticRotation();
    (data.providers as ReturnType<typeof provider>[])[1] = provider(2, "Los Angeles", { active: false });
    const a = onCallAt(at("2026-12-09T05:00:00Z"), data);
    expect(a.provider).toBeNull();
    expect(a.note).toBe("provider_inactive");
  });
});

describe("the lookup returns the provider, phone, region and director", () => {
  it("for an Inland Empire week", () => {
    const a = onCallAt(at("2026-12-02T05:00:00Z"), syntheticRotation());
    expect(a.provider).toMatchObject({ id: 1, phone: "+15555551001", region: "Inland Empire" });
    expect(a.director?.id).toBe(IE_DIRECTOR);
    expect(a.final?.id).toBe(FINAL_DIRECTOR);
  });
});

describe("the escalation chain", () => {
  const data = syntheticRotation();
  const p = (id: number) => data.providers.find((x) => x.id === id)!;

  it("on-call, then the region director, then FINAL", () => {
    const plan = planChain({ role: "on_call", provider: p(2) }, data);
    expect(plan.levels.map((l) => [l.role, l.providerId])).toEqual([
      ["on_call", 2],
      ["region_director", LA_DIRECTOR],
      ["final", FINAL_DIRECTOR],
    ]);
  });

  it("San Diego goes straight to the final director", () => {
    expect(planChain({ role: "on_call", provider: p(3) }, data).levels.map((l) => [l.role, l.providerId])).toEqual([
      ["on_call", 3],
      ["final", FINAL_DIRECTOR],
    ]);
  });

  it("Coachella Valley goes straight to the final director", () => {
    expect(planChain({ role: "on_call", provider: p(4) }, data).levels.map((l) => l.providerId)).toEqual([4, FINAL_DIRECTOR]);
  });

  it("both valleys share one director", () => {
    expect(planChain({ role: "on_call", provider: p(6) }, data).levels.map((l) => l.providerId)).toEqual([
      6,
      VALLEYS_DIRECTOR,
      FINAL_DIRECTOR,
    ]);
  });

  it("a director who is on call is not rung twice", () => {
    expect(planChain({ role: "on_call", provider: p(IE_DIRECTOR) }, data).levels.map((l) => l.providerId)).toEqual([
      IE_DIRECTOR,
      FINAL_DIRECTOR,
    ]);
    expect(planChain({ role: "on_call", provider: p(FINAL_DIRECTOR) }, data).levels.map((l) => l.providerId)).toEqual([
      FINAL_DIRECTOR,
    ]);
  });

  it("a post-op surgeon is followed by the surgeon's own region director", () => {
    expect(planChain({ role: "surgeon", provider: p(5) }, data).levels.map((l) => [l.role, l.providerId])).toEqual([
      ["surgeon", 5],
      ["region_director", 93],
      ["final", FINAL_DIRECTOR],
    ]);
  });

  it("a region with no director goes to FINAL and says so", () => {
    const plan = planChain({ role: "on_call", provider: provider(7, "Ventura") }, data);
    expect(plan.levels.map((l) => l.providerId)).toEqual([7, FINAL_DIRECTOR]);
    expect(plan.notes).toContain("no_director_for_region");
  });

  it("an inactive final director is never rung, and the plan says so", () => {
    const off = syntheticRotation();
    off.providers = off.providers.map((x) => (x.id === FINAL_DIRECTOR ? { ...x, active: false } : x));
    const find = (id: number) => off.providers.find((x) => x.id === id)!;
    const la = planChain({ role: "on_call", provider: find(2) }, off);
    expect(la.levels.map((l) => [l.role, l.providerId])).toEqual([
      ["on_call", 2],
      ["region_director", LA_DIRECTOR],
    ]);
    expect(la.notes).toContain("final_director_inactive");
    const sd = planChain({ role: "on_call", provider: find(3) }, off);
    expect(sd.levels.map((l) => l.providerId)).toEqual([3]);
    expect(sd.notes).toEqual(expect.arrayContaining(["region_director_inactive", "final_director_inactive"]));
  });

  it("region names are compared loosely", () => {
    expect(regionKey("  inland   EMPIRE ")).toBe(regionKey("Inland Empire"));
    expect(planChain({ role: "on_call", provider: provider(8, "inland empire") }, data).levels[1].providerId).toBe(IE_DIRECTOR);
  });
});
