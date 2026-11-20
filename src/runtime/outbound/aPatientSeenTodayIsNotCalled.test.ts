/**
 * A PATIENT SEEN TODAY IS NOT CALLED (v252).
 *
 * The NPX outreach campaign calls New and Lapsed patients only (v246; operator,
 * 2026-11-16: "we should never have called this set of patients" — the
 * Existing ones, seen in the last 15 months). The class comes from the
 * Console's hourly build (`capacity_movable_rows_part`), which counts kept
 * visits BEFORE the day it is built for (`last_visit < p_today`). So a Lapsed
 * patient seen today is still Lapsed on today's list until tomorrow's build.
 *
 * RULE THREE, the corpus (every npx-outreach contact dialled or texted from
 * v246's first call, 2026-11-16 22:55 UTC, to 2026-11-20 02:30 UTC: 14):
 *
 *   CAf256c21807735a19e196154c7064ff5a  2026-11-19 13:20 Pacific. A kept visit
 *     on the day the cache was built for, so the row still read Lapsed; the
 *     contact was dialled and then texted. Read-only on the Console,
 *     2026-11-20: on main's list for 11-19, off the guarded one.
 *
 * The other 13 had no kept visit since the build and stay on the list. On the
 * list built for 2026-11-19, 2 of the 320 New and Lapsed rows were this shape.
 *
 * The rule is in SQL, and this suite has no Console, so what it can hold is the
 * statement itself, the same way the v246 class filter is held in
 * consoleMovable.test.ts, and that the dial's re-check runs the same statement
 * the list does. The behaviour on real rows is the read-only Console check
 * above and in the PR.
 */
import { describe, expect, it } from "vitest";
import { MOVABLE_SELECT, movableReader } from "./consoleMovable";

const GUARD = `
     and not exists (
       select 1 from public.si_appointment_facts k
        where k.person_id = r.person_id
          and coalesce(k.is_kept, false)
          and k.appointment_date >= r.built_for
          and k.appointment_date <= $1::date)`;

describe("the movable list leaves out a patient seen since the cache was built", () => {
  it("the guard is in the list's one statement, whole", () => {
    expect(MOVABLE_SELECT).toContain(GUARD);
  });

  it("it reads the same person's kept visits, not anyone's", () => {
    expect(MOVABLE_SELECT).toContain("where k.person_id = r.person_id");
  });

  it("only a kept visit counts: a booked or missed one is not a visit", () => {
    expect(MOVABLE_SELECT).toContain("and coalesce(k.is_kept, false)");
  });

  it("from the day the cache was built for, which its own count leaves out, through today", () => {
    expect(MOVABLE_SELECT).toContain("and k.appointment_date >= r.built_for");
    expect(MOVABLE_SELECT).toContain("and k.appointment_date <= $1::date)");
  });

  it("sits beside the class filter, so New and Lapsed are still the only classes read", () => {
    const cls = MOVABLE_SELECT.indexOf("and r.patient_class in ('new', 'lapsed')");
    const guard = MOVABLE_SELECT.indexOf("and not exists (");
    expect(cls).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(cls);
  });
});

describe("the dial re-checks with the same statement", () => {
  it("list() and current() both carry the guard, with today bound as $1", async () => {
    const seen: Array<{ text: string; values: unknown[] }> = [];
    const reader = movableReader(async (text, values) => {
      seen.push({ text, values });
      return { rows: [] };
    });
    await reader.list("2026-11-19");
    // A synthetic appointment id, read at its dial.
    expect(await reader.current("00000000-0000-4000-8000-000000000252", "2026-11-19")).toBeNull();
    expect(seen).toHaveLength(2);
    for (const q of seen) {
      expect(q.text).toContain(GUARD);
      expect(q.values[0]).toBe("2026-11-19");
    }
  });
});
