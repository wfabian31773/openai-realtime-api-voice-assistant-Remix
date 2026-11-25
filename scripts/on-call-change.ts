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
 *
 * EVERY COMMAND IS AUDITED (operator, 2026-11-24). Each needs --reason "<why>"
 * and takes --actor "<name or email>" (the OS user when it is not given). The
 * SQL inserts an on_call_audit_log row in the same transaction, with the
 * action names the admin page writes (schedule.swap_week, override.create,
 * provider.create, schedule.extend, provider.deactivate, provider.activate,
 * director.set), so it needs migrations/add_on_call_admin.sql applied: without
 * it the SQL refuses before changing anything.
 *
 * THE ROTATION'S CALLER ID (review of #520). swap, cover, extend and
 * set-director refuse, in their SQL, a provider whose phone on file is the
 * rotation's own caller ID, or who has no dialable phone (the admin page's
 * `ringableProvider`); add-provider refuses the caller ID as the new phone up
 * front. The caller ID is read the way the admin page reads it
 * (`rotationCallerId`: ON_CALL_CALLER_ID, else TWILIO_PHONE_NUMBER), or given
 * as --caller-id <E.164>. When neither names one, the command still prints
 * its SQL and warns on stderr that the caller-ID check was skipped.
 */
import { userInfo } from "node:os";
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
import { CALLER_ID_SKIPPED, insideRepo, resolveCallerId, writePrivate, type ScriptResult } from "./on-call-seed";

/**
 * The commands that give a provider a week, a cover, a director rung or a
 * phone: each refuses a phone that is the rotation's caller ID, as the admin
 * page does. deactivate and activate give no role and need no caller ID.
 */
const NEEDS_CALLER_ID = new Set(["swap", "cover", "add-provider", "extend", "set-director"]);

const USAGE = `usage: npx tsx scripts/on-call-change.ts <command> [options] --reason "<why>" [--actor "<name or email>"] [--out file.sql]
  swap --week <Tuesday> --to "<name>" [--note "<text>"]
  cover --from "<YYYY-MM-DD HH:MM>" --to "<YYYY-MM-DD HH:MM>" --by "<name>"
  add-provider --name "<name>" --phone "<phone>" --region "<region>" [--email <email>] [--npi <npi>] [--escalation-only] [--new-region]
  extend --weeks <n>
  deactivate "<name>"
  activate "<name>"
  set-director --region "<region>" --director "<name>" [--new-region]
Every command writes an on_call_audit_log row (migrations/add_on_call_admin.sql must be applied).
--reason is required; --actor defaults to the OS user.
swap, cover, add-provider, extend and set-director refuse a provider whose phone is the rotation's caller ID,
read from ON_CALL_CALLER_ID / TWILIO_PHONE_NUMBER or given as --caller-id <E.164>; without either the check is skipped, with a warning.
`;

const OPTIONS: Record<string, { required: string[]; optional: string[]; flags?: string[]; positional?: true }> = {
  swap: { required: ["week", "to"], optional: ["note"] },
  cover: { required: ["from", "to", "by"], optional: [] },
  "add-provider": { required: ["name", "phone", "region"], optional: ["email", "npi"], flags: ["escalation-only", "new-region"] },
  extend: { required: ["weeks"], optional: [] },
  deactivate: { required: [], optional: [], positional: true },
  activate: { required: [], optional: [], positional: true },
  "set-director": { required: ["region", "director"], optional: [], flags: ["new-region"] },
};

/** Every command's audit options: --reason is required, --actor is not. */
const AUDIT_REQUIRED = ["reason"];
const AUDIT_OPTIONAL = ["actor"];

/** The OS user, the actor when --actor is not given; empty when it cannot be read. */
export function osUser(env: Record<string, string | undefined> = process.env): string {
  try {
    const u = userInfo().username;
    if (u) return u;
  } catch {
    // no passwd entry: fall through to the environment
  }
  return (env.USER ?? env.LOGNAME ?? env.USERNAME ?? "").trim();
}

function fail(message: string): ScriptResult {
  return { code: 2, stdout: "", stderr: `${message}\n${USAGE}` };
}

export function run(
  args: string[],
  deps: { osUser?: () => string; env?: Record<string, string | undefined> } = {},
): ScriptResult {
  const [command, ...rest] = args;
  const base = command ? OPTIONS[command] : undefined;
  if (!base) return fail(command ? `unknown command ${command}` : "no command");
  const spec = { ...base, required: [...base.required, ...AUDIT_REQUIRED], optional: [...base.optional, ...AUDIT_OPTIONAL] };

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
    const global = name === "out" || (name === "caller-id" && NEEDS_CALLER_ID.has(command));
    if (!global && !spec.required.includes(name) && !spec.optional.includes(name)) {
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
  if (!values.reason.trim()) return fail(`${command} needs a --reason that is not blank`);
  const actor = (values.actor ?? (deps.osUser ?? osUser)()).trim();
  if (!actor) return fail("no actor: pass --actor <name or email> (the OS user could not be read)");
  const audit = { actor, reason: values.reason };
  let callerId: string | null = null;
  let skipped = "";
  if (NEEDS_CALLER_ID.has(command)) {
    const caller = resolveCallerId(values["caller-id"], deps.env ?? process.env);
    if (caller.problem) return fail(caller.problem);
    callerId = caller.callerId;
    if (!callerId) skipped = `${CALLER_ID_SKIPPED}\n`;
  }

  let sql: string;
  try {
    switch (command) {
      case "swap":
        sql = swapWeekSql({ week: values.week, to: values.to, note: values.note, audit, callerId });
        break;
      case "cover":
        sql = coverSql({ from: values.from, to: values.to, by: values.by, reason: values.reason, audit, callerId });
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
          audit,
          callerId,
        });
        break;
      case "extend": {
        const weeks = /^\d+$/.test(values.weeks) ? Number(values.weeks) : Number.NaN;
        sql = extendScheduleSql(weeks, audit, { callerId });
        break;
      }
      case "deactivate":
        sql = deactivateSql(positional[0], audit);
        break;
      case "activate":
        sql = activateSql(positional[0], audit);
        break;
      default:
        sql = setDirectorSql({ region: values.region, director: values.director, newRegion: set.has("new-region"), audit, callerId });
    }
  } catch (e) {
    if (e instanceof SeedError) return { code: 1, stdout: "", stderr: `Nothing written:\n  - ${e.problems.join("\n  - ")}\n` };
    throw e;
  }

  if (values.out) {
    writePrivate(values.out, sql);
    return { code: 0, stdout: "", stderr: `${skipped}Wrote ${values.out}. Read it, then run it on the Hub.\n` };
  }
  return { code: 0, stdout: sql, stderr: skipped };
}

const isMain = process.argv[1] && /on-call-change\.ts$/.test(process.argv[1]);
if (isMain) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
