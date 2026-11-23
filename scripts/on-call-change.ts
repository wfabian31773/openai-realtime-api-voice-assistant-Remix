/**
 * Changes to the after-hours on-call rotation after its first load. Each
 * command prints SQL for Wayne to read and run on the Hub; nothing here
 * touches a database.
 *
 *   npx tsx scripts/on-call-change.ts swap --week 2026-12-08 --to "Dr. Name" [--note "..."]
 *       The whole week (Tuesday 5:00 PM to the next Tuesday 8:00 AM Pacific)
 *       goes to another provider.
 *   npx tsx scripts/on-call-change.ts cover --from "2026-12-10 17:00" --to "2026-12-11 08:00" --by "Dr. Name" [--reason "..."]
 *       Part of a week: the window, in Pacific time, goes to another provider.
 *       An override beats the schedule; the latest override wins.
 *   npx tsx scripts/on-call-change.ts add-provider --name "Dr. Name" --phone "555-010-0000" --region "Inland Empire" [--email x] [--npi 10digits] [--escalation-only] [--new-region]
 *       A new provider joins at the end of the rotation. Their first week is
 *       the first one `extend` adds; no week already scheduled changes.
 *       --escalation-only adds someone who takes escalations and no week (a
 *       new medical director). The region must already have a director unless
 *       --new-region is given, so a misspelt region is refused. A name already
 *       on file is refused; a provider who returns is `activate`.
 *   npx tsx scripts/on-call-change.ts extend --weeks 8
 *       Adds weeks after the last one, continuing the rotation order among
 *       active providers.
 *   npx tsx scripts/on-call-change.ts deactivate "Dr. Name"
 *   npx tsx scripts/on-call-change.ts activate "Dr. Name"
 *       Takes a provider out of the rotation (they are skipped by `extend`,
 *       and a swap or cover to them is refused), or puts them back. Their
 *       weeks already on the schedule are listed so they can be swapped.
 *   npx tsx scripts/on-call-change.ts set-director --region "Los Angeles" --director "Dr. Name" [--new-region]
 *       The region's escalation director. --region FINAL sets the director
 *       rung after every region's. A region not on file is refused unless
 *       --new-region is given.
 *
 * Every name must match exactly one provider (case and spacing aside), and
 * every command runs in one transaction that raises before it writes anything
 * if it does not.
 */
import {
  activateSql,
  addProviderSql,
  coverSql,
  deactivateSql,
  extendScheduleSql,
  SeedError,
  setDirectorSql,
  swapWeekSql,
} from "../src/runtime/onCall/seed";
import { insideRepo, writePrivate, type ScriptResult } from "./on-call-seed";

const USAGE = `usage: npx tsx scripts/on-call-change.ts <command> [options] [--out file.sql]
  swap --week <Tuesday> --to "<name>" [--note "<text>"]
  cover --from "<YYYY-MM-DD HH:MM>" --to "<YYYY-MM-DD HH:MM>" --by "<name>" [--reason "<text>"]
  add-provider --name "<name>" --phone "<phone>" --region "<region>" [--email <email>] [--npi <npi>] [--escalation-only] [--new-region]
  extend --weeks <n>
  deactivate "<name>"
  activate "<name>"
  set-director --region "<region>" --director "<name>" [--new-region]
`;

const OPTIONS: Record<string, { required: string[]; optional: string[]; flags?: string[]; positional?: true }> = {
  swap: { required: ["week", "to"], optional: ["note"] },
  cover: { required: ["from", "to", "by"], optional: ["reason"] },
  "add-provider": { required: ["name", "phone", "region"], optional: ["email", "npi"], flags: ["escalation-only", "new-region"] },
  extend: { required: ["weeks"], optional: [] },
  deactivate: { required: [], optional: [], positional: true },
  activate: { required: [], optional: [], positional: true },
  "set-director": { required: ["region", "director"], optional: [], flags: ["new-region"] },
};

function fail(message: string): ScriptResult {
  return { code: 2, stdout: "", stderr: `${message}\n${USAGE}` };
}

export function run(args: string[]): ScriptResult {
  const [command, ...rest] = args;
  const spec = command ? OPTIONS[command] : undefined;
  if (!spec) return fail(command ? `unknown command ${command}` : "no command");

  const values: Record<string, string> = {};
  const set = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (spec.flags?.includes(name)) {
      set.add(name);
      continue;
    }
    if (name !== "out" && !spec.required.includes(name) && !spec.optional.includes(name)) {
      return fail(`${command} takes no --${name}`);
    }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) return fail(`--${name} needs a value`);
    values[name] = v;
    i++;
  }
  const missing = spec.required.filter((r) => !values[r]);
  if (missing.length) return fail(`${command} needs ${missing.map((m) => `--${m}`).join(", ")}`);
  if (spec.positional ? positional.length !== 1 : positional.length !== 0) {
    return fail(spec.positional ? `${command} takes one provider name` : `${command} takes no bare arguments`);
  }
  if (values.out && insideRepo(values.out)) {
    return fail(`--out ${values.out} is inside the repository; write it outside`);
  }

  let sql: string;
  try {
    switch (command) {
      case "swap":
        sql = swapWeekSql({ week: values.week, to: values.to, note: values.note });
        break;
      case "cover":
        sql = coverSql({ from: values.from, to: values.to, by: values.by, reason: values.reason });
        break;
      case "add-provider":
        sql = addProviderSql({
          name: values.name,
          phone: values.phone,
          region: values.region,
          email: values.email,
          npi: values.npi,
          escalationOnly: set.has("escalation-only"),
          newRegion: set.has("new-region"),
        });
        break;
      case "extend": {
        const weeks = /^\d+$/.test(values.weeks) ? Number(values.weeks) : Number.NaN;
        sql = extendScheduleSql(weeks);
        break;
      }
      case "deactivate":
        sql = deactivateSql(positional[0]);
        break;
      case "activate":
        sql = activateSql(positional[0]);
        break;
      default:
        sql = setDirectorSql({ region: values.region, director: values.director, newRegion: set.has("new-region") });
    }
  } catch (e) {
    if (e instanceof SeedError) return { code: 1, stdout: "", stderr: `Nothing written:\n  - ${e.problems.join("\n  - ")}\n` };
    throw e;
  }

  if (values.out) {
    writePrivate(values.out, sql);
    return { code: 0, stdout: "", stderr: `Wrote ${values.out}. Read it, then run it on the Hub.\n` };
  }
  return { code: 0, stdout: sql, stderr: "" };
}

const isMain = process.argv[1] && /on-call-change\.ts$/.test(process.argv[1]);
if (isMain) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
