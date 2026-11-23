/**
 * The after-hours on-call rotation's first load.
 *
 *   npx tsx scripts/on-call-seed.ts <pool.csv> <schedule.csv> --final "<name>" \
 *       [--directors <directors.csv>] [--out <seed.sql>]
 *
 * Reads the rotation pool (one row per provider: name, phone, email, region,
 * escalation director, NPI) and the schedule (one row per week: the Tuesday it
 * starts and the provider on call), checks every row, and writes ONE SQL file
 * that Wayne runs on the Hub after `migrations/add_on_call_rotation.sql`. The
 * file refuses to run on tables that already hold anything.
 *
 * `--final` names the director rung last on every chain (Dr. Logan). A director
 * who is not in the pool goes in `--directors`, a CSV with the same columns
 * (name, phone, email, region, NPI); a director is never given a phone this
 * script did not read.
 *
 * The CSVs and the SQL hold provider phones and emails: keep them OUT of the
 * repository (the default output is stdout, and `--out` refuses a path inside
 * it). The summary on stderr names providers and regions and carries no phone
 * or email.
 *
 * Writes nothing to any database. Changes after the first load are
 * `scripts/on-call-change.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { buildSeedSql, SeedError } from "../src/runtime/onCall/seed";
import { FINAL_REGION } from "../src/runtime/onCall/rotation";

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

const REPO_ROOT = resolve(__dirname, "..");

const USAGE =
  'usage: npx tsx scripts/on-call-seed.ts <pool.csv> <schedule.csv> --final "<name>" [--directors <file.csv>] [--out <file.sql>]';

/** True when `path` is the repository or inside it. */
export function insideRepo(path: string, root = REPO_ROOT): boolean {
  const rel = relative(root, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function flags(args: string[], names: string[]): { values: Record<string, string>; rest: string[]; problem?: string } {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!names.includes(name)) return { values, rest, problem: `unknown option --${name}` };
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return { values, rest, problem: `--${name} needs a value` };
      values[name] = v;
      i++;
    } else {
      rest.push(a);
    }
  }
  return { values, rest };
}

export function run(args: string[]): ScriptResult {
  const parsed = flags(args, ["final", "directors", "out"]);
  if (parsed.problem) return { code: 2, stdout: "", stderr: `${parsed.problem}\n${USAGE}\n` };
  const [poolPath, schedulePath, extra] = parsed.rest;
  if (!poolPath || !schedulePath || extra || !parsed.values.final) {
    return { code: 2, stdout: "", stderr: `${USAGE}\n` };
  }
  const out = parsed.values.out;
  if (out && insideRepo(out)) {
    return {
      code: 2,
      stdout: "",
      stderr: `--out ${out} is inside the repository; the SQL holds provider phones. Write it outside, e.g. ~/on-call-seed.sql\n`,
    };
  }

  let result;
  try {
    result = buildSeedSql({
      poolCsv: readFileSync(poolPath, "utf8"),
      scheduleCsv: readFileSync(schedulePath, "utf8"),
      directorsCsv: parsed.values.directors ? readFileSync(parsed.values.directors, "utf8") : undefined,
      final: parsed.values.final,
    });
  } catch (e) {
    if (e instanceof SeedError) {
      return { code: 1, stdout: "", stderr: `Nothing written. Fix these and run it again:\n  - ${e.problems.join("\n  - ")}\n` };
    }
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { code: 1, stdout: "", stderr: `no such file: ${err.path}\n` };
    throw e;
  }

  const byId = new Map(result.providers.map((p) => [p.id, p]));
  const inRotation = result.providers.filter((p) => p.rotationOrder !== null);
  const lines = [
    `On-call seed: ${inRotation.length} providers in the rotation, ${result.weeks.length} weeks ` +
      `(${result.weeks[0]?.week ?? "none"} to ${result.weeks[result.weeks.length - 1]?.week ?? "none"}).`,
    `Escalation directors:`,
    ...[...result.directors].map(([region, id]) =>
      `  ${region === FINAL_REGION ? "final (after every region's director)" : region}: ${byId.get(id)?.fullName ?? "?"}`,
    ),
  ];
  if (result.warnings.length) lines.push(`Read before running it:`, ...result.warnings.map((w) => `  - ${w}`));
  lines.push(out ? `Wrote ${out}. Run it on the Hub after migrations/add_on_call_rotation.sql.` : `SQL on stdout.`);

  if (out) {
    writeFileSync(out, result.sql, { mode: 0o600 });
    return { code: 0, stdout: "", stderr: `${lines.join("\n")}\n` };
  }
  return { code: 0, stdout: result.sql, stderr: `${lines.join("\n")}\n` };
}

const isMain = process.argv[1] && /on-call-seed\.ts$/.test(process.argv[1]);
if (isMain) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
