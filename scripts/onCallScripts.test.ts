/**
 * The two on-call scripts Wayne runs: the first load and the changes after it.
 * Synthetic providers and 555 numbers only.
 */
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { insideRepo, run as seed } from "./on-call-seed";
import { run as runChange } from "./on-call-change";

/** A change as Wayne runs it: every command carries --reason and --actor. */
const change = (args: string[]) => runChange([...args, "--reason", "test change", "--actor", "ops@example.test"]);

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

describe("an --out file that already exists (review of #514)", () => {
  it("the seed narrows an existing world-readable file to its owner before writing", () => {
    const f = files();
    const out = join(f.dir, "seed.sql");
    writeFileSync(out, "old");
    chmodSync(out, 0o644);
    const r = seed([f.pool, f.schedule, "--final", "Dan Lowe", "--directors", f.directors, "--out", out]);
    expect(r.code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, "utf8")).toContain("INSERT INTO on_call_schedule");
  });

  it("a change narrows an existing world-readable file to its owner before writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "on-call-change-"));
    const out = join(dir, "change.sql");
    writeFileSync(out, "old");
    chmodSync(out, 0o644);
    const r = change(["add-provider", "--name", "Kim Ruiz", "--phone", "555-010-0012", "--region", "San Diego", "--out", out]);
    expect(r.code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, "utf8")).toContain("'+15550100012'");
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

describe("scripts/on-call-change.ts writes an audit row with every change", () => {
  const COMMANDS: Array<{ args: string[]; action: string; entityType: string }> = [
    { args: ["swap", "--week", "2026-12-08", "--to", "Ben Ortiz"], action: "schedule.swap_week", entityType: "schedule" },
    { args: ["cover", "--from", "2026-12-10 17:00", "--to", "2026-12-11 08:00", "--by", "Ada Lin"], action: "override.create", entityType: "override" },
    { args: ["add-provider", "--name", "Kim Ruiz", "--phone", "555-010-0012", "--region", "San Diego"], action: "provider.create", entityType: "provider" },
    { args: ["extend", "--weeks", "4"], action: "schedule.extend", entityType: "schedule" },
    { args: ["deactivate", "Ada Lin"], action: "provider.deactivate", entityType: "provider" },
    { args: ["activate", "Ada Lin"], action: "provider.activate", entityType: "provider" },
    { args: ["set-director", "--region", "FINAL", "--director", "Dan Lowe"], action: "director.set", entityType: "director" },
  ];

  for (const c of COMMANDS) {
    it(`${c.args[0]}: one ${c.action} row in the same transaction, with the actor and the reason`, () => {
      const r = runChange([...c.args, "--reason", "covering a family event", "--actor", "wayne@example.test"]);
      expect(r.code).toBe(0);
      const sql = r.stdout;
      const begin = sql.indexOf("BEGIN;");
      const audit = sql.indexOf("INSERT INTO on_call_audit_log");
      const commit = sql.lastIndexOf("COMMIT;");
      expect(begin).toBe(0);
      expect(audit).toBeGreaterThan(begin);
      expect(audit).toBeLessThan(commit);
      expect(sql.match(/INSERT INTO on_call_audit_log/g)).toHaveLength(1);
      expect(sql).toContain(`'${c.action}'`);
      expect(sql).toContain(`'${c.entityType}'`);
      expect(sql).toContain("'wayne@example.test (scripts/on-call-change.ts)'");
      expect(sql).toContain("'covering a family event'");
      // Refuses before anything is written when the audit table is not there.
      const guard = sql.indexOf("to_regclass('on_call_audit_log') IS NULL");
      expect(guard).toBeGreaterThan(begin);
      expect(guard).toBeLessThan(sql.search(/UPDATE on_call_|INSERT INTO on_call_(schedule|overrides|providers|escalation)|WITH last AS/));
      expect(sql).toContain("apply migrations/add_on_call_admin.sql first");
    });
  }

  it("snapshots the row before and after where the SQL can read it", () => {
    const swap = change(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz"]).stdout;
    expect(swap).toContain("SELECT to_jsonb(s) INTO prev FROM on_call_schedule s WHERE week_starts_on = '2026-12-08';");
    expect(swap.indexOf("INTO prev")).toBeLessThan(swap.indexOf("UPDATE on_call_schedule"));
    expect(swap.indexOf("INTO nxt")).toBeGreaterThan(swap.indexOf("UPDATE on_call_schedule"));
    const off = change(["deactivate", "Ada Lin"]).stdout;
    expect(off).toContain("to_jsonb(p) - 'created_at' - 'updated_at'");
    expect(off.indexOf("INTO prev")).toBeLessThan(off.indexOf("SET active = false"));
    const cover = change(["cover", "--from", "2026-12-10 17:00", "--to", "2026-12-11 08:00", "--by", "Ada Lin"]).stdout;
    expect(cover).toContain("RETURNING id INTO new_id;");
    expect(cover).toMatch(/new_id::text, NULL, nxt/);
    const extend = change(["extend", "--weeks", "4"]).stdout;
    expect(extend).toContain("jsonb_build_object('week', week_starts_on, 'providerId', provider_id)");
    expect(extend).toContain("FROM added HAVING count(*) > 0");
    const director = change(["set-director", "--region", "FINAL", "--director", "Dan Lowe"]).stdout;
    expect(director.indexOf("INTO prev")).toBeLessThan(director.indexOf("UPDATE on_call_escalation_directors"));
  });

  it("requires a --reason, and refuses a blank one", () => {
    const r = runChange(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz", "--actor", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/swap needs --reason/);
    const blank = runChange(["swap", "--week", "2026-12-08", "--to", "Ben Ortiz", "--reason", "  ", "--actor", "x"]);
    expect(blank.code).toBe(2);
    expect(blank.stderr).toMatch(/--reason that is not blank/);
    expect(blank.stdout).toBe("");
  });

  it("takes the OS user as the actor when --actor is not given, and refuses when there is none", () => {
    const r = runChange(["activate", "Ada Lin", "--reason", "back from leave"], { osUser: () => "wfabian" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("'wfabian (scripts/on-call-change.ts)'");
    const none = runChange(["activate", "Ada Lin", "--reason", "back from leave"], { osUser: () => "" });
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/no actor/);
  });

  it("uses the cover's --reason for the override and the audit row alike", () => {
    const sql = change(["cover", "--from", "2026-12-10 17:00", "--to", "2026-12-11 08:00", "--by", "Ada Lin"]).stdout;
    expect(sql.match(/'test change'/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("scripts/on-call-change.ts and on-call-seed.ts check the rotation's caller ID (review of #520)", () => {
  const CID = "+15550100002";
  const audited = (args: string[], env: Record<string, string | undefined>) =>
    runChange([...args, "--reason", "test change", "--actor", "ops@example.test"], { env });
  const ROLE_COMMANDS = [
    ["swap", "--week", "2026-12-08", "--to", "Ben Ortiz"],
    ["cover", "--from", "2026-12-10 17:00", "--to", "2026-12-11 08:00", "--by", "Ben Ortiz"],
    ["extend", "--weeks", "4"],
    ["set-director", "--region", "FINAL", "--director", "Ben Ortiz"],
  ];

  for (const args of ROLE_COMMANDS) {
    it(`${args[0]} reads the caller ID the admin page reads and refuses it in the SQL`, () => {
      const r = audited(args, { ON_CALL_CALLER_ID: "(555) 010-0002" });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`phone = '\\${CID}'`));
      expect(r.stderr).toBe("");
      // --caller-id wins over the environment.
      const flag = audited([...args, "--caller-id", "555-010-0003"], { ON_CALL_CALLER_ID: CID });
      expect(flag.code).toBe(0);
      expect(flag.stdout).toContain("phone = '+15550100003'");
      expect(flag.stdout).not.toContain(`'${CID}'`);
    });

    it(`${args[0]} warns that the caller-ID check was skipped when no caller ID is known`, () => {
      const r = audited(args, {});
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/caller ID is not known.*SKIPPED/);
      expect(r.stdout).not.toMatch(/phone = '\+/);
    });
  }

  it("add-provider refuses the caller ID as the new phone up front, from the env or --caller-id", () => {
    const add = ["add-provider", "--name", "Kim Ruiz", "--phone", "555-010-0002", "--region", "San Diego"];
    const env = audited(add, { TWILIO_PHONE_NUMBER: CID });
    expect(env.code).toBe(1);
    expect(env.stdout).toBe("");
    expect(env.stderr).toMatch(/rotation's own caller ID/);
    expect(audited([...add, "--caller-id", CID], {}).code).toBe(1);
    expect(audited(add, {}).stderr).toMatch(/SKIPPED/);
  });

  it("refuses a --caller-id that is not a phone, and takes it only on commands that give a role", () => {
    expect(audited(["extend", "--weeks", "4", "--caller-id", "nope"], {}).stderr).toMatch(/--caller-id nope is not a phone number/);
    expect(audited(["deactivate", "Ada Lin", "--caller-id", CID], {}).stderr).toMatch(/deactivate takes no --caller-id/);
    expect(audited(["activate", "Ada Lin"], {}).stderr).toBe("");
  });

  it("the seed refuses a provider whose phone is the caller ID, and warns when it is unknown", () => {
    const f = files();
    const base = [f.pool, f.schedule, "--final", "Dan Lowe", "--directors", f.directors];
    const refused = seed(base, { env: { ON_CALL_CALLER_ID: CID } });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/Ben Ortiz.*rotation's own caller ID/);
    expect(seed([...base, "--caller-id", CID], { env: {} }).code).toBe(1);
    const ok = seed(base, { env: { ON_CALL_CALLER_ID: "+15550100099" } });
    expect(ok.code).toBe(0);
    expect(ok.stderr).not.toMatch(/SKIPPED/);
    expect(seed(base, { env: {} }).stderr).toMatch(/SKIPPED/);
  });
});
