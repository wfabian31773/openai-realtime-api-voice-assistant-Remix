/**
 * The seed builder and the change builders: they read Wayne's two CSVs (and an
 * optional third for a director who is not in the pool) and return SQL he runs
 * himself. Every check that can be made before the SQL runs is made here, all
 * at once, and nothing a check reports carries a phone number or an email.
 *
 * Every name is invented and every phone is a 555 number.
 */
import { describe, expect, it } from "vitest";
import {
  SeedError,
  activateSql,
  addProviderSql,
  buildSeedSql,
  coverSql,
  deactivateSql,
  doBlock,
  extendScheduleSql,
  lit,
  readDate,
  readPacificTime,
  readPhone,
  setDirectorSql,
  surnameKey,
  swapWeekSql,
  type SeedInput,
} from "./seed";
import { FINAL_REGION } from "./rotation";
import { ON_CALL_ADMIN_WRITE_LOCK_SQL } from "./adminLock";

const POOL = [
  "Provider,Cell Phone,Email,Region,Escalation Director,NPI",
  "Ada Lin,555-010-0001,ada@example.test,Inland Empire,Dr. Cara Pell,1000000001",
  "Ben Ortiz,(555) 010-0002,ben@example.test,Inland Empire,Cara Pell,1000000002",
  `Cara Pell,555.010.0003,cara@example.test,Inland Empire,Dr. Pell,1000000003`,
  "Eve Shah,+1 555 010 0004,eve@example.test,San Diego,Dr. Dan K. Lowe,1000000004",
  "Finn O'Neil,5550100005,,San  Diego,Dan Lowe,",
].join("\n");

const DIRECTORS = ["Name,Phone,Email,Region,NPI", "Dr. Dan K. Lowe,555-010-0009,dan@example.test,San Diego,1000000009"].join(
  "\n",
);

const SCHEDULE = [
  "Week Start,On-Call Provider",
  "12/1/2026,Ada Lin",
  "12/8/2026,Dr. Shah",
  "Tuesday December 15 2026,Ben Ortiz",
  "2026-12-22,Ada Lin",
  "12/29/26,Cara Pell",
].join("\n");

const AT = new Date("2026-11-23T08:00:00Z");

function seed(over: Partial<SeedInput> = {}) {
  return buildSeedSql({ poolCsv: POOL, scheduleCsv: SCHEDULE, directorsCsv: DIRECTORS, final: "Dan Lowe", generatedAt: AT, ...over });
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof SeedError) return e.problems;
    throw e;
  }
  throw new Error("expected a SeedError");
}

describe("the seed, on good files", () => {
  it("numbers the rotation in the order providers first appear on the schedule, then the unscheduled pool rows", () => {
    const r = seed();
    const byName = new Map(r.providers.map((p) => [p.fullName, p]));
    expect(byName.get("Ada Lin")!.rotationOrder).toBe(1);
    expect(byName.get("Eve Shah")!.rotationOrder).toBe(2);
    expect(byName.get("Ben Ortiz")!.rotationOrder).toBe(3);
    expect(byName.get("Cara Pell")!.rotationOrder).toBe(4);
    // In the pool, on no week: placed at the end, and said so.
    expect(byName.get("Finn O'Neil")!.rotationOrder).toBe(5);
    expect(r.warnings.some((w) => /Finn O'Neil.*end of the rotation/.test(w))).toBe(true);
    // A director from the directors file is not in the rotation.
    expect(byName.get("Dr. Dan K. Lowe")!.rotationOrder).toBeNull();
  });

  it("gives every provider an id from 1 with the phone in E.164 and the region as typed, spaces collapsed", () => {
    const r = seed();
    expect(r.providers.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.providers.map((p) => p.phone)).toEqual([
      "+15550100001",
      "+15550100002",
      "+15550100003",
      "+15550100004",
      "+15550100005",
      "+15550100009",
    ]);
    expect(r.providers.find((p) => p.fullName === "Finn O'Neil")!.region).toBe("San Diego");
    expect(r.providers.find((p) => p.fullName === "Finn O'Neil")!.email).toBeNull();
  });

  it("maps each region to the director its pool rows name, and FINAL to the final director", () => {
    const r = seed();
    const id = (n: string) => r.providers.find((p) => p.fullName === n)!.id;
    expect([...r.directors]).toEqual([
      ["Inland Empire", id("Cara Pell")],
      ["San Diego", id("Dr. Dan K. Lowe")],
      [FINAL_REGION, id("Dr. Dan K. Lowe")],
    ]);
    // The directors-file row takes the region it directs.
    expect(r.providers.find((p) => p.fullName === "Dr. Dan K. Lowe")!.region).toBe("San Diego");
  });

  it("reads each week's date in any of the spreadsheet's shapes and keeps them in order", () => {
    const r = seed();
    const id = (n: string) => r.providers.find((p) => p.fullName === n)!.id;
    expect(r.weeks).toEqual([
      { week: "2026-12-01", providerId: id("Ada Lin") },
      { week: "2026-12-08", providerId: id("Eve Shah") },
      { week: "2026-12-15", providerId: id("Ben Ortiz") },
      { week: "2026-12-22", providerId: id("Ada Lin") },
      { week: "2026-12-29", providerId: id("Cara Pell") },
    ]);
  });

  it("writes one transaction that refuses to run on tables that are not empty", () => {
    const { sql } = seed();
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("BEGIN;");
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM on_call_providers\) OR EXISTS \(SELECT 1 FROM on_call_schedule\)/);
    expect(sql).toContain("OR EXISTS (SELECT 1 FROM on_call_escalation_directors)");
    expect(sql).toMatch(/RAISE EXCEPTION 'the on-call tables are not empty/);
    // The guard comes before any insert.
    expect(sql.indexOf("RAISE EXCEPTION")).toBeLessThan(sql.indexOf("INSERT INTO"));
    expect(sql).toContain("SELECT setval(pg_get_serial_sequence('on_call_providers', 'id')");
    expect(sql).toContain("('2026-12-01', 1)");
    expect(sql).toContain(`(${FINAL_REGION === "FINAL" ? "'FINAL'" : ""}, 6)`);
  });

  it("quotes a name with an apostrophe and writes an empty field as NULL", () => {
    const { sql } = seed();
    expect(sql).toContain("'Finn O''Neil', NULL, '+15550100005', NULL, 'San Diego', 5, true");
  });

  it("says nothing about a phone or an email in a warning", () => {
    const r = seed();
    for (const w of r.warnings) {
      expect(w).not.toMatch(/555|@/);
    }
  });

  it("warns about a provider with no NPI and about a gap in the schedule", () => {
    const r = seed({
      scheduleCsv: ["Week,Provider", "2026-12-01,Ada Lin", "2026-12-15,Ben Ortiz"].join("\n"),
    });
    expect(r.warnings.some((w) => /Finn O'Neil.*no NPI/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /skips from 2026-12-01 to 2026-12-15.*only the final director/.test(w))).toBe(true);
  });

  it("works with no directors file when every director is in the pool", () => {
    const pool = [
      "Name,Phone,Region,Director",
      "Ada Lin,555-010-0001,Inland Empire,Cara Pell",
      "Cara Pell,555-010-0003,Inland Empire,Cara Pell",
    ].join("\n");
    const r = buildSeedSql({ poolCsv: pool, scheduleCsv: "Date,Name\n2026-12-01,Ada Lin", final: "Cara Pell", generatedAt: AT });
    expect(r.providers).toHaveLength(2);
    expect(r.directors.get(FINAL_REGION)).toBe(r.directors.get("Inland Empire"));
  });

  it("keeps the pool row when a director is listed in both files", () => {
    const directors = ["Name,Phone,Region", "Cara Pell,555-010-0099,Inland Empire", DIRECTORS.split("\n")[1]].join("\n");
    const r = seed({ directorsCsv: directors });
    const cara = r.providers.filter((p) => p.fullName === "Cara Pell");
    expect(cara).toHaveLength(1);
    expect(cara[0].phone).toBe("+15550100003");
  });

  it("leaves out, with a warning, a directors-file row who directs nothing", () => {
    const directors = [DIRECTORS, "Gil Park,555-010-0010,,"].join("\n");
    const r = seed({ directorsCsv: directors });
    expect(r.providers.some((p) => p.fullName === "Gil Park")).toBe(false);
    expect(r.warnings.some((w) => /Gil Park.*left out/.test(w))).toBe(true);
  });
});

describe("the seed, on bad files", () => {
  it("names a missing column and lists the headers it did find", () => {
    const problems = problemsOf(() => seed({ poolCsv: "Name,Phone,Region\nAda Lin,555-010-0001,Inland Empire" }));
    expect(problems).toEqual(["pool: no director column (headers are: Name, Phone, Region)"]);
    const sched = problemsOf(() => seed({ scheduleCsv: "Provider\nAda Lin" }));
    expect(sched).toEqual(["schedule: no week column (headers are: Provider)"]);
    const dirs = problemsOf(() => seed({ directorsCsv: "Name,Region\nDan Lowe,San Diego" }));
    expect(dirs).toEqual(["directors: no phone column (headers are: Name, Region)"]);
  });

  it("reports every problem at once, by line and name, with no phone or email in any of them", () => {
    const pool = [
      "Name,Phone,Email,Region,Director,NPI",
      "Ada Lin,555-010-0001,ada@example.test,Inland Empire,Cara Pell,123",
      "Ben Ortiz,not a phone,ben@example.test,,Cara Pell,1000000002",
      "Ada Lin,555-010-0007,ada2@example.test,Inland Empire,Cara Pell,",
      "Cara Pell,555-010-0003,,Inland Empire,,1000000002",
      ",555-010-0008,,Inland Empire,Cara Pell,",
    ].join("\n");
    const problems = problemsOf(() =>
      buildSeedSql({ poolCsv: pool, scheduleCsv: "Week,Name\n2026-12-01,Ada Lin", final: "Cara Pell", generatedAt: AT }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "pool line 2 (Ada Lin): the NPI is not 10 digits",
        "pool line 3 (Ben Ortiz): the phone is not a phone number",
        "pool line 3 (Ben Ortiz): no region",
        '"Ada Lin" is in the pool twice',
        'the NPI of "Cara Pell" is also on "Ben Ortiz"',
        "pool line 6: no name",
        "pool (Cara Pell): no escalation director",
      ]),
    );
    for (const p of problems) expect(p).not.toMatch(/555|@/);
  });

  it("refuses a region whose pool rows name two directors", () => {
    const pool = [
      "Name,Phone,Region,Director",
      "Ada Lin,555-010-0001,Inland Empire,Cara Pell",
      "Ben Ortiz,555-010-0002,inland  empire,Ben Ortiz",
      "Cara Pell,555-010-0003,Inland Empire,Cara Pell",
    ].join("\n");
    const problems = problemsOf(() =>
      buildSeedSql({ poolCsv: pool, scheduleCsv: "Week,Name\n2026-12-01,Ada Lin", final: "Cara Pell", generatedAt: AT }),
    );
    expect(problems).toEqual([
      'region "Inland Empire" has more than one escalation director in the pool: Cara Pell, Ben Ortiz',
    ]);
  });

  it("refuses a director who is in neither file, and a final director who is in neither", () => {
    const problems = problemsOf(() => seed({ directorsCsv: undefined, final: "Hal Moss" }));
    expect(problems).toEqual(
      expect.arrayContaining([
        'pool (Eve Shah), escalation director: "Dr. Dan K. Lowe" is not in the pool or the directors file',
        'final director: "Hal Moss" is not in the pool or the directors file',
      ]),
    );
  });

  it("refuses a final director from the directors file with no region", () => {
    const directors = [DIRECTORS, "Hal Moss,555-010-0011,,"].join("\n");
    const problems = problemsOf(() => seed({ directorsCsv: directors, final: "Hal Moss" }));
    expect(problems).toEqual(["directors (Hal Moss): no region; add one (the region they belong to)"]);
  });

  it("refuses a week that is not a date, not a Tuesday, listed twice, or has nobody on it", () => {
    const schedule = [
      "Week,Name",
      "sometime,Ada Lin",
      "2026-12-02,Ada Lin",
      "2026-12-01,Ada Lin",
      "12/1/2026,Ben Ortiz",
      "2026-12-08,",
      "2026-02-30,Ada Lin",
    ].join("\n");
    const problems = problemsOf(() => seed({ scheduleCsv: schedule }));
    expect(problems).toEqual([
      'schedule line 2: "sometime" is not a date',
      "schedule line 3: 2026-12-02 is not a Tuesday (a week starts on Tuesday at 5:00 PM)",
      "schedule line 5: the week of 2026-12-01 is listed twice",
      "schedule line 6: no provider for the week of 2026-12-08",
      'schedule line 7: "2026-02-30" is not a date',
    ]);
  });

  it("refuses a schedule name that is unknown, or a surname two pool providers share", () => {
    const pool = POOL + "\nIda Lin,555-010-0006,,Inland Empire,Cara Pell,1000000006";
    const schedule = ["Week,Name", "2026-12-01,Dr. Lin", "2026-12-08,Jo Vance", "2026-12-15,Ida Lin"].join("\n");
    const problems = problemsOf(() => seed({ poolCsv: pool, scheduleCsv: schedule }));
    expect(problems).toEqual([
      'schedule line 2 (2026-12-01): "Dr. Lin" matches 2 people by surname; write the first name too',
      'schedule line 3 (2026-12-08): "Jo Vance" is not in the pool or the directors file',
    ]);
  });

  it("does not put a directors-file person on the schedule", () => {
    const problems = problemsOf(() => seed({ scheduleCsv: "Week,Name\n2026-12-01,Dan Lowe" }));
    expect(problems).toEqual(['schedule line 2 (2026-12-01): "Dan Lowe" is not in the pool or the directors file']);
  });
});

describe("values", () => {
  it("reads a date in the shapes a spreadsheet exports, and nothing else", () => {
    expect(readDate("2026-12-01")).toBe("2026-12-01");
    expect(readDate("2026-12-01 00:00:00")).toBe("2026-12-01");
    expect(readDate("12/1/2026")).toBe("2026-12-01");
    expect(readDate("12/01/26")).toBe("2026-12-01");
    expect(readDate("Dec 1, 2026")).toBe("2026-12-01");
    expect(readDate("Tuesday, December 1st, 2026")).toBe("2026-12-01");
    expect(readDate("Sept. 7 2027")).toBe("2027-09-07");
    expect(readDate("2/29/2027")).toBeNull();
    expect(readDate("13/1/2026")).toBeNull();
    expect(readDate("Smarch 1, 2026")).toBeNull();
    expect(readDate("next Tuesday")).toBeNull();
    expect(readDate("")).toBeNull();
  });

  it("reads a phone as E.164, or not at all", () => {
    expect(readPhone("555-010-0001")).toBe("+15550100001");
    expect(readPhone("1 (555) 010-0001")).toBe("+15550100001");
    expect(readPhone("+1 (555) 010-0001")).toBe("+15550100001");
    expect(readPhone("+44 20 7946 0000")).toBe("+442079460000");
    expect(readPhone("010-0001")).toBeNull();
    expect(readPhone("call the office")).toBeNull();
    expect(readPhone("+1 555 010 0001 x12")).toBeNull();
    expect(readPhone("")).toBeNull();
    expect(readPhone(undefined)).toBeNull();
  });

  it("reads a surname with the title and degree dropped", () => {
    expect(surnameKey("Dr. Dwayne K. Logan")).toBe("logan");
    expect(surnameKey("David M. Choi, MD")).toBe("choi");
    expect(surnameKey("Dr. José Peña")).toBe("pena");
    expect(surnameKey("Dr.")).toBeNull();
  });

  it("writes an SQL literal, and NULL for nothing", () => {
    expect(lit("O'Neil")).toBe("'O''Neil'");
    expect(lit("")).toBe("NULL");
    expect(lit(null)).toBe("NULL");
    expect(lit(undefined)).toBe("NULL");
  });

  it("reads a Pacific time in 24- or 12-hour form", () => {
    expect(readPacificTime("2026-12-10 17:00")).toBe("2026-12-10 17:00");
    expect(readPacificTime("12/10/2026 5:00 PM")).toBe("2026-12-10 17:00");
    expect(readPacificTime("12/10/2026 12:15 a.m.")).toBe("2026-12-10 00:15");
    expect(readPacificTime("12/10/2026 12:15pm")).toBe("2026-12-10 12:15");
    expect(readPacificTime("2026-12-10")).toBeNull();
    expect(readPacificTime("2026-12-10 24:00")).toBeNull();
    expect(readPacificTime("2026-12-10 13:00 pm")).toBeNull();
    expect(readPacificTime("2026-12-10 9:60")).toBeNull();
  });
});

describe("changes after the seed", () => {
  it("adds a new provider at the end of the rotation, in a region that has a director", () => {
    const sql = addProviderSql({ name: " Kim Ruiz ", phone: "555-010-0012", region: "Orange  County", npi: "1000000012" });
    expect(sql).toContain("(SELECT COALESCE(MAX(rotation_order), 0) + 1 FROM on_call_providers), true)");
    expect(sql).toContain("VALUES ('Kim Ruiz', '1000000012', '+15550100012', NULL,");
    // One row, whatever is already on file: no INSERT ... SELECT ... FROM the table.
    expect(sql).not.toMatch(/^\s*FROM on_call_providers$/m);
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM on_call_escalation_directors WHERE lower(regexp_replace(btrim(region), '\\s+', ' ', 'g')) = lower('Orange County')) THEN",
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'region % has no escalation director/);
    expect(sql).toContain("RETURNING id, full_name, region, rotation_order;");
  });

  it("refuses a new provider whose name is already on file, active or not, and points at activate", () => {
    const sql = addProviderSql({ name: "Kim  Ruiz", phone: "555-010-0012", region: "Orange County" });
    expect(sql).toContain(
      "IF EXISTS (SELECT 1 FROM on_call_providers WHERE lower(regexp_replace(full_name, '\\s+', ' ', 'g')) = lower('Kim Ruiz')) THEN",
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'a provider named % is already on file; to bring them back use activate'/);
    expect(sql).not.toMatch(/= lower\('Kim Ruiz'\) AND active/);
  });

  it("adds a director who takes no week, and a provider in a new region only when asked", () => {
    const director = addProviderSql({ name: "Lee Tan", phone: "555-010-0013", region: "Orange County", escalationOnly: true });
    expect(director).toContain("NULL, true)");
    expect(director).not.toContain("MAX(rotation_order)");
    expect(director).not.toMatch(/^\s*FROM on_call_providers$/m);
    expect(director).toMatch(/has no escalation director/);
    const fresh = addProviderSql({ name: "Lee Tan", phone: "555-010-0013", region: "High Desert", newRegion: true });
    expect(fresh).not.toMatch(/has no escalation director/);
    expect(fresh).toContain(
      "COALESCE((SELECT region FROM on_call_escalation_directors WHERE lower(regexp_replace(btrim(region), '\\s+', ' ', 'g')) = lower('High Desert')), 'High Desert')",
    );
    expect(fresh).toContain("COALESCE(MAX(rotation_order), 0) + 1");
  });

  it("refuses FINAL as the region a provider works in", () => {
    expect(problemsOf(() => addProviderSql({ name: "Lee Tan", phone: "555-010-0013", region: "final" }))).toEqual([
      "FINAL is the final escalation rung, not a region a provider works in",
    ]);
  });

  it("refuses a new provider with no name, no region, a bad phone or a bad NPI, all at once", () => {
    const problems = problemsOf(() => addProviderSql({ name: " ", phone: "12", region: "", npi: "99" }));
    expect(problems).toEqual(["no name", "the phone is not a phone number", "the NPI is not 10 digits", "no region"]);
  });

  it("extends the schedule from the provider after the last week's, among active rotation providers", () => {
    const sql = extendScheduleSql(8);
    expect(sql).toContain("generate_series(1, 8)");
    expect(sql).toContain("WHERE active AND rotation_order IS NOT NULL");
    expect(sql).toContain("pool.pos = (start.pos + k - 1) % pool.n");
    expect(sql).toContain("COMMIT keeps them; ROLLBACK drops them.");
    for (const bad of [0, -1, 105, 2.5, Number.NaN]) {
      expect(() => extendScheduleSql(bad)).toThrow(SeedError);
    }
    expect(() => extendScheduleSql(104)).not.toThrow();
  });

  it("writes an audit row only when told who and why, and refuses a blank actor or reason", () => {
    expect(swapWeekSql({ week: "2026-12-08", to: "Ben Ortiz" })).not.toContain("on_call_audit_log");
    expect(extendScheduleSql(2)).not.toContain("on_call_audit_log");
    const audited = swapWeekSql({ week: "2026-12-08", to: "Ben Ortiz", audit: { actor: "ops", reason: "it's a trade" } });
    expect(audited).toContain("'it''s a trade'");
    expect(problemsOf(() => swapWeekSql({ week: "2026-12-08", to: "Ben Ortiz", audit: { actor: " ", reason: "" } }))).toEqual([
      "no actor: pass --actor <name or email>",
      'no reason: pass --reason "<why>"',
    ]);
  });

  it("refuses, naming them, an extension that gives a week to a provider with no dialable phone", () => {
    const sql = extendScheduleSql(4);
    const check = sql.indexOf("RAISE EXCEPTION 'extend refused:");
    const insert = sql.indexOf("INSERT INTO on_call_schedule");
    // The check runs first, in the same transaction, over the same planned weeks.
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(insert);
    expect(sql).toContain("string_agg(DISTINCT p.full_name");
    expect(sql).toContain("p.phone IS NULL OR p.phone !~ '^\\+[0-9]{10,15}$'");
    expect(sql).toContain("SELECT week, provider_id, 'added by scripts/on-call-change.ts extend' FROM planned");
    expect(sql.match(/generate_series\(1, 4\)/g)).toHaveLength(2);
  });

  it("swaps a whole week to one active provider, and refuses a week that is not a Tuesday", () => {
    const sql = swapWeekSql({ week: "12/8/2026", to: "Ben  Ortiz" });
    expect(sql).toContain("WHERE week_starts_on = '2026-12-08'");
    expect(sql).toContain("lower('Ben Ortiz') AND active");
    expect(sql).toContain("'swapped to Ben  Ortiz'");
    expect(sql).toMatch(/IF NOT FOUND THEN RAISE EXCEPTION 'the week of % is not on the schedule'/);
    expect(problemsOf(() => swapWeekSql({ week: "2026-12-09", to: "Ben Ortiz" }))).toEqual([
      "2026-12-09 is not a Tuesday (a week starts on Tuesday at 5:00 PM)",
    ]);
    expect(problemsOf(() => swapWeekSql({ week: "soon", to: "Ben Ortiz" }))).toEqual(['week: "soon" is not a date']);
  });

  it("covers a window in Pacific time with one active provider", () => {
    const sql = coverSql({ from: "12/10/2026 5:00 PM", to: "2026-12-11 08:00", by: "Ada Lin", reason: "family event" });
    expect(sql).toContain("('2026-12-10 17:00'::timestamp AT TIME ZONE 'America/Los_Angeles')");
    expect(sql).toContain("('2026-12-11 08:00'::timestamp AT TIME ZONE 'America/Los_Angeles')");
    expect(sql).toContain("lower('Ada Lin') AND active");
    expect(sql).toContain("'family event'");
    expect(problemsOf(() => coverSql({ from: "2026-12-11 08:00", to: "2026-12-10 17:00", by: "Ada Lin" }))).toEqual([
      "to must be after from",
    ]);
    expect(problemsOf(() => coverSql({ from: "tonight", to: "2026-12-10", by: "Ada Lin" }))).toEqual([
      'from: "tonight" is not a date and time (2026-12-10 17:00)',
      'to: "2026-12-10" is not a date and time (2026-12-11 08:00)',
    ]);
  });

  it("deactivates and reactivates by name whether or not the row is active, and lists the weeks left to swap", () => {
    const off = deactivateSql("Ada Lin");
    expect(off).toContain("SET active = false");
    expect(off).not.toContain("AND active");
    expect(off).toContain("SELECT s.week_starts_on FROM on_call_schedule s");
    const on = activateSql("Ada Lin");
    expect(on).toContain("SET active = true");
    expect(on).not.toContain("AND active");
  });

  it("sets a region's director to one active provider, and refuses a region not on file", () => {
    const sql = setDirectorSql({ region: " Orange  County ", director: "Dr. Kim Ruiz" });
    expect(sql).toContain("lower('Dr. Kim Ruiz') AND active");
    expect(sql).toContain("WHERE lower(regexp_replace(btrim(region), '\\s+', ' ', 'g')) = lower('Orange County');");
    expect(sql).not.toContain("INSERT INTO on_call_escalation_directors");
    expect(sql).toMatch(/RAISE EXCEPTION 'region % is not on file; check the spelling, or pass --new-region/);
    expect(problemsOf(() => setDirectorSql({ region: "  ", director: "Dr. Kim Ruiz" }))).toEqual(["no region"]);
  });

  it("adds a region's first director only when asked", () => {
    const sql = setDirectorSql({ region: "High Desert", director: "Dr. Kim Ruiz", newRegion: true });
    expect(sql).toContain("INSERT INTO on_call_escalation_directors (region, provider_id) VALUES ('High Desert', who)");
    expect(sql).not.toMatch(/is not on file/);
  });

  it("raises unless the name names exactly one row", () => {
    for (const sql of [swapWeekSql({ week: "2026-12-08", to: "Ada Lin" }), deactivateSql("Ada Lin")]) {
      expect(sql).toMatch(/IF n <> 1 THEN RAISE EXCEPTION 'expected one (active )?provider named %, found %'/);
    }
  });
});

describe("every CLI transaction takes the admin page's write lock first", () => {
  const audit = { actor: "ops", reason: "test" };
  const cases: Array<[string, string]> = [
    ["seed", seed().sql],
    ["add-provider", addProviderSql({ name: "Kim Ruiz", phone: "555-010-0012", region: "Orange County", audit })],
    ["extend", extendScheduleSql(4, audit)],
    ["swap", swapWeekSql({ week: "2026-12-08", to: "Ben Ortiz", audit })],
    ["cover", coverSql({ from: "2026-12-10 17:00", to: "2026-12-11 08:00", by: "Ada Lin", audit })],
    ["deactivate", deactivateSql("Ada Lin", audit)],
    ["activate", activateSql("Ada Lin", audit)],
    ["set-director", setDirectorSql({ region: "Orange County", director: "Dr. Kim Ruiz", audit })],
    ["swap, unaudited", swapWeekSql({ week: "2026-12-08", to: "Ben Ortiz" })],
  ];

  it("is the one shared constant, the admin page's advisory xact lock", () => {
    expect(ON_CALL_ADMIN_WRITE_LOCK_SQL).toBe(`select pg_advisory_xact_lock(hashtext('on_call_admin_write'))`);
  });

  it.each(cases)("%s: the statement after BEGIN is the lock, before any check, read or write", (_name, sql) => {
    const lines = sql.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
    const begin = lines.indexOf("BEGIN;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("BEGIN;", begin + 1)).toBe(-1);
    expect(lines[begin + 1]).toBe(`${ON_CALL_ADMIN_WRITE_LOCK_SQL};`);
    expect(sql.split(ON_CALL_ADMIN_WRITE_LOCK_SQL).length).toBe(2);
  });
});

describe("a file that is not a CSV", () => {
  it("is a problem named by file and line, quoting no cell", () => {
    const problems = problemsOf(() => seed({ poolCsv: 'Name,Phone,Region,Director\nAda Lin,"555-010-0001,Inland Empire,Cara Pell\nBen "Ortiz,555-010-0002,x,y' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^pool: not a readable CSV \(CSV_[A-Z_]+/);
    expect(problems[0]).not.toMatch(/555|Ada|Ortiz/);
  });

  it("reads a row whose trailing empty cells were dropped", () => {
    const pool = ["Name,Phone,Region,Director,Email,NPI", "Ada Lin,555-010-0001,Inland Empire,Ada Lin"].join("\n");
    const r = buildSeedSql({ poolCsv: pool, scheduleCsv: "Week,Name\n2026-12-01,Ada Lin", final: "Ada Lin", generatedAt: AT });
    expect(r.providers[0].email).toBeNull();
  });
});

describe("a value that holds a dollar-quote tag cannot end a DO block", () => {
  // Every user-supplied value carries the fixed tag, a bare $$, the next tag the
  // helper would try, and a single quote.
  const evil = "x$oncall$; DROP TABLE on_call_providers; -- $$ $oncall_1$ O'Brien";
  const audit = { actor: `ops ${evil}`, reason: `reason ${evil}` };

  /** Each DO block's body (between its opening and its END) never contains its tag. */
  function doBlocksAreClosedOnlyByTheirEnd(sql: string) {
    const opens = [...sql.matchAll(/^DO (\$[a-z0-9_]*\$) /gm)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) {
      const tag = m[1];
      const start = m.index! + m[0].length;
      const end = sql.indexOf(`\nEND ${tag};`, start);
      expect(end).toBeGreaterThan(start);
      expect(sql.slice(start, end).includes(tag)).toBe(false);
    }
  }

  const cases: Array<[string, () => string]> = [
    ["swap", () => swapWeekSql({ week: "2026-12-08", to: `Ben ${evil}`, note: `note ${evil}`, audit })],
    ["cover", () => coverSql({ from: "2026-12-10 17:00", to: "2026-12-11 08:00", by: `Ben ${evil}`, reason: `cover ${evil}`, audit })],
    ["deactivate", () => deactivateSql(`Ben ${evil}`, audit)],
    ["activate", () => activateSql(`Ben ${evil}`, audit)],
    ["set-director, new region", () => setDirectorSql({ region: `Inland ${evil}`, director: `Ben ${evil}`, newRegion: true, audit })],
    ["set-director", () => setDirectorSql({ region: `Inland ${evil}`, director: `Ben ${evil}`, audit })],
    ["add-provider", () => addProviderSql({ name: `Ben ${evil}`, phone: "555-010-0009", email: `b${evil}@x`, region: `Inland ${evil}`, audit })],
    ["extend", () => extendScheduleSql(2, audit)],
  ];

  for (const [name, build] of cases) {
    it(`${name}: picks a tag absent from the body and keeps the values in quoted literals`, () => {
      const sql = build();
      // A block that carries no value (the audit-table check) keeps $oncall$;
      // one that carries a value gets a tag the value does not contain.
      doBlocksAreClosedOnlyByTheirEnd(sql);
      expect(sql).toContain(lit(`reason ${evil}`));
      expect(sql).toContain(lit(`ops ${evil} (scripts/on-call-change.ts)`));
      // The single quote is always doubled, so no value leaves its literal.
      expect(sql).toContain("O''Brien");
      expect(sql).not.toMatch(/[^']O'Brien/);
    });
  }

  it("keeps the fixed $oncall$ tag when nothing in the body holds it", () => {
    const sql = swapWeekSql({ week: "2026-12-08", to: "Ben Ortiz", audit: { actor: "ops", reason: "it's a trade" } });
    expect(sql).toMatch(/^DO \$oncall\$ DECLARE n int; who int; prev jsonb; nxt jsonb; BEGIN$/m);
    expect(sql).toMatch(/^END \$oncall\$;$/m);
  });

  it("doBlock skips every tag the body contains", () => {
    const lines = doBlock("", ["  -- $oncall$ $oncall_1$ $oncall_2$"]);
    expect(lines[0]).toBe("DO $oncall_3$ BEGIN");
    expect(lines[lines.length - 1]).toBe("END $oncall_3$;");
  });
});
