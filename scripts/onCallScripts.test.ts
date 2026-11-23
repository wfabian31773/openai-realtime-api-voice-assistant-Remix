/**
 * The two on-call scripts Wayne runs: the first load and the changes after it.
 * Synthetic providers and 555 numbers only.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { insideRepo, run as seed } from "./on-call-seed";
import { run as change } from "./on-call-change";

const POOL = [
  "Name,Phone,Email,Region,Escalation Director,NPI",
  "Ada Lin,555-010-0001,ada@example.test,Inland Empire,Cara Pell,1000000001",
  "Ben Ortiz,555-010-0002,ben@example.test,Inland Empire,Cara Pell,1000000002",
  "Cara Pell,555-010-0003,cara@example.test,Inland Empire,Cara Pell,1000000003",
  "Eve Shah,555-010-0004,eve@example.test,San Diego,Dan Lowe,1000000004",
].join("\n");
const DIRECTORS = "Name,Phone,Email,Region\nDan Lowe,555-010-0009,dan@example.test,San Diego";
const SCHEDULE = ["Week,Provider", "12/1/2026,Ada Lin", "12/8/2026,Eve Shah", "12/15/2026,Ben Ortiz"].join("\n");

function files() {
  const dir = mkdtempSync(join(tmpdir(), "oncall-"));
  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  return { dir, pool: write("pool.csv", POOL), schedule: write("schedule.csv", SCHEDULE), directors: write("dirs.csv", DIRECTORS) };
}

describe("scripts/on-call-seed.ts", () => {
  it("writes the seed SQL outside the repository, readable only by its owner, and summarises with no phone or email", () => {
    const f = files();
    const out = join(f.dir, "seed.sql");
    const r = seed([f.pool, f.schedule, "--final", "Dan Lowe", "--directors", f.directors, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(out, "utf8")).toContain("INSERT INTO on_call_schedule");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    // Cara Pell is on no week, so she is placed at the end of the rotation: four in it.
    expect(r.stderr).toContain("4 providers in the rotation, 3 weeks (2026-12-01 to 2026-12-15)");
    expect(r.stderr).toContain("Inland Empire: Cara Pell");
    expect(r.stderr).toContain("San Diego: Dan Lowe");
    expect(r.stderr).toContain("final (after every region's director): Dan Lowe");
    // Cara Pell is a director in the pool and on no week: the warning says so.
    expect(r.stderr).toMatch(/Cara Pell.*end of the rotation/);
    expect(r.stderr).not.toMatch(/555|@/);
  });

  it("prints the SQL on stdout when no --out is given", () => {
    const f = files();
    const r = seed([f.pool, f.schedule, "--final", "Dan Lowe", "--directors", f.directors]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("COMMIT;");
    expect(r.stderr).toContain("SQL on stdout.");
  });

  it("refuses an --out inside the repository", () => {
    const f = files();
    const r = seed([f.pool, f.schedule, "--final", "Dan Lowe", "--directors", f.directors, "--out", "on-call-seed.sql"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/inside the repository/);
  });

  it("writes nothing and lists every problem when the files do not check out", () => {
    const f = files();
    const out = join(f.dir, "seed.sql");
    const r = seed([f.pool, f.schedule, "--final", "Dan Lowe", "--out", out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Nothing written/);
    expect(r.stderr).toContain('"Dan Lowe" is not in the pool or the directors file');
    expect(() => statSync(out)).toThrow();
  });

  it("answers a usage line for missing arguments, an unknown option and a missing file", () => {
    const f = files();
    expect(seed([f.pool, f.schedule]).code).toBe(2);
    expect(seed([f.pool, "--final", "Dan Lowe"]).code).toBe(2);
    expect(seed([f.pool, f.schedule, "--final"]).stderr).toMatch(/--final needs a value/);
    expect(seed([f.pool, f.schedule, "--final", "Dan Lowe", "--force", "x"]).stderr).toMatch(/unknown option --force/);
    const gone = seed([join(f.dir, "nope.csv"), f.schedule, "--final", "Dan Lowe"]);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toMatch(/no such file/);
  });

  it("knows the repository from a path inside it", () => {
    const root = resolve(__dirname, "..");
    expect(insideRepo(root)).toBe(true);
    expect(insideRepo(join(root, "scripts", "x.sql"))).toBe(true);
    expect(insideRepo(join(tmpdir(), "x.sql"))).toBe(false);
    expect(insideRepo(`${root}-sibling/x.sql`)).toBe(false);
  });
});

describe("scripts/on-call-change.ts", () => {
  it("prints the SQL for each command", () => {
    expect(change(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz"]).stdout).toContain("'2026-12-08'");
    expect(change(["cover", "--from", "2026-12-10 17:00", "--to", "2026-12-11 08:00", "--by", "Ada Lin"]).stdout).toContain(
      "INSERT INTO on_call_overrides",
    );
    const added = change(["add-provider", "--name", "Kim Ruiz", "--phone", "555-010-0012", "--region", "San Diego"]);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("'+15550100012'");
    expect(change(["extend", "--weeks", "12"]).stdout).toContain("generate_series(1, 12)");
    expect(change(["deactivate", "Ada Lin"]).stdout).toContain("SET active = false");
    expect(change(["activate", "Ada Lin"]).stdout).toContain("SET active = true");
    expect(change(["set-director", "--region", "FINAL", "--director", "Dan Lowe"]).stdout).toContain("lower('FINAL')");
  });

  it("takes --escalation-only and --new-region as flags with no value", () => {
    const director = change(["add-provider", "--name", "Lee Tan", "--phone", "555-010-0013", "--region", "San Diego", "--escalation-only"]);
    expect(director.code).toBe(0);
    expect(director.stdout).toContain("NULL, true");
    const fresh = change(["add-provider", "--new-region", "--name", "Lee Tan", "--phone", "555-010-0013", "--region", "High Desert"]);
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).not.toMatch(/has no escalation director/);
    const region = change(["set-director", "--region", "High Desert", "--director", "Lee Tan", "--new-region"]);
    expect(region.stdout).toContain("INSERT INTO on_call_escalation_directors");
    expect(change(["set-director", "--region", "High Desert", "--director", "Lee Tan"]).stdout).toMatch(/is not on file/);
    expect(change(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz", "--new-region"]).stderr).toMatch(/swap takes no --new-region/);
  });

  it("refuses an unknown command, a missing or unknown option, and a stray argument", () => {
    expect(change([]).code).toBe(2);
    expect(change(["rename"]).stderr).toMatch(/unknown command rename/);
    expect(change(["swap", "--week", "2026-12-08"]).stderr).toMatch(/swap needs --to/);
    expect(change(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz", "--by", "x"]).stderr).toMatch(/swap takes no --by/);
    expect(change(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz", "extra"]).stderr).toMatch(/takes no bare arguments/);
    expect(change(["deactivate"]).stderr).toMatch(/takes one provider name/);
    expect(change(["deactivate", "Ada", "Lin"]).stderr).toMatch(/takes one provider name/);
    expect(change(["extend", "--weeks", "ten"]).code).toBe(1);
    expect(change(["extend", "--weeks", "1.5"]).code).toBe(1);
  });

  it("refuses a change that does not check out, writing nothing", () => {
    const r = change(["swap", "--week", "2026-12-09", "--to", "Ben Ortiz"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/not a Tuesday/);
  });

  it("writes to --out only outside the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-"));
    const out = join(dir, "swap.sql");
    expect(change(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz", "--out", out]).code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("UPDATE on_call_schedule");
    expect(change(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz", "--out", "swap.sql"]).stderr).toMatch(
      /inside the repository/,
    );
  });
});
