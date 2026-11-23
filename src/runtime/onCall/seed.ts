/**
 * The rotation's first load and its later changes, as SQL Wayne runs himself.
 *
 * Operator, 2026-11-22: "Seed from On_Call_Schedule_Run1.csv (49 weeks, Dec 1
 * 2026 to Nov 9 2027) and On_Call_Rotation_Pool_2026.csv (49 providers with
 * phone, email, region, escalation director)", "Store the rotation in a table
 * (not hard-coded) so Wayne can enter swaps and new providers. New onboarding
 * providers get added to the end of the rotation", and "No production DB
 * writes or migrations applied by you. Write the migration and Wayne applies
 * it."
 *
 * So nothing here touches a database. `buildSeedSql` reads the two CSVs (and an
 * optional third for a director who is not in the pool) and returns the SQL
 * for an empty rotation; the `*Sql` builders below return the SQL for one
 * change each. `scripts/on-call-seed.ts` and `scripts/on-call-change.ts` print
 * it. The CSVs hold staff phone numbers and emails, so they and the SQL stay
 * on Wayne's machine and never in git.
 *
 * Everything that can be checked before the SQL runs is checked here and
 * reported all at once: a week that is not a Tuesday, a provider on the
 * schedule who is not in the pool, a region with two directors, a phone that
 * is not a phone. The SQL then checks what only the database knows (the
 * tables are empty, a name resolves to one row).
 */
import { parse } from "csv-parse/sync";
import { toE164 } from "../../services/handoffPolicy";
import { nameKeyForMatch } from "./postOp";
import { FINAL_REGION, regionKey } from "./rotation";

// ── CSV reading ─────────────────────────────────────────────────────────────

type Row = Record<string, string>;

/** "Escalation Director" -> "escalationdirector". */
function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COLUMNS = {
  name: ["name", "provider", "providername", "fullname", "doctor", "physician", "oncallprovider", "oncall"],
  phone: ["phone", "cell", "mobile", "cellphone", "mobilephone", "phonenumber", "cellnumber", "mobilenumber"],
  email: ["email", "emailaddress"],
  region: ["region"],
  director: [
    "escalationdirector",
    "director",
    "regionaldirector",
    "regionalmedicaldirector",
    "medicaldirector",
    "rmd",
    "escalation",
  ],
  npi: ["npi"],
  week: ["weekstart", "weekstarting", "weekstartson", "weekof", "week", "startdate", "start", "date", "from"],
} as const;

type Column = keyof typeof COLUMNS;

export class SeedError extends Error {
  constructor(readonly problems: string[]) {
    super(`${problems.length} problem(s) in the on-call data:\n  - ${problems.join("\n  - ")}`);
    this.name = "SeedError";
  }
}

interface Table {
  rows: Row[];
  /** column -> the header it was read from. */
  found: Partial<Record<Column, string>>;
  headers: string[];
}

function readTable(text: string, file: string): Table {
  let records: Row[];
  try {
    // A hand-edited export can drop the empty cells at the end of a row; a
    // missing cell reads as empty, as it would in the spreadsheet.
    records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Row[];
  } catch (e) {
    // The parser's message can quote a cell, which may be a phone or an
    // email, so only its code and line are reported.
    const err = e as { code?: string; lines?: number };
    throw new SeedError([`${file}: not a readable CSV (${err.code ?? "parse error"}${err.lines ? ` near line ${err.lines}` : ""})`]);
  }
  const headers = records.length ? Object.keys(records[0]) : [];
  const found: Partial<Record<Column, string>> = {};
  for (const col of Object.keys(COLUMNS) as Column[]) {
    for (const alias of COLUMNS[col]) {
      const h = headers.find((x) => headerKey(x) === alias);
      if (h) {
        found[col] = h;
        break;
      }
    }
  }
  return { rows: records, found, headers };
}

function need(table: Table, file: string, cols: Column[], problems: string[]): boolean {
  const missing = cols.filter((c) => !table.found[c]);
  for (const c of missing) {
    problems.push(`${file}: no ${c} column (headers are: ${table.headers.join(", ") || "none"})`);
  }
  return missing.length === 0;
}

// ── Values ──────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A calendar date as YYYY-MM-DD from the shapes a spreadsheet exports:
 * 2026-12-01, 12/1/2026, 12/1/26, Dec 1, 2026, Tuesday, December 1, 2026, with
 * or without a time after it. Null for anything else.
 */
export function readDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (hit) {
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else if ((hit = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(s))) {
    [m, d, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    if (y < 100) y += 2000;
  } else if ((hit = /(?:^|\s)([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s))) {
    const month = MONTHS[hit[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    [m, d, y] = [month, Number(hit[2]), Number(hit[3])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function plusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * E.164 for a US number (10 digits, or 11 starting with 1) or one written with
 * a + ("+1 (555) 000-1111" included). Null otherwise.
 */
export function readPhone(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  const v = t.startsWith("+") ? `+${t.slice(1).replace(/[\s().-]/g, "")}` : toE164(t);
  return v && /^\+\d{10,15}$/.test(v) ? v : null;
}

/** A region as typed, with runs of spaces collapsed. */
function cleanRegion(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * The SQL test that a stored region is `region`, keyed the way the runtime
 * keys it (`regionKey`: trimmed, spaces collapsed, case ignored), so a region
 * entered by hand with a stray space is the same region to the change scripts
 * as it is to a call (review of #514, round 7).
 */
function regionIs(region: string): string {
  return `lower(regexp_replace(btrim(region), '\\s+', ' ', 'g')) = lower(${lit(cleanRegion(region))})`;
}

/** The last word of a name with its title and degree dropped: "Dr. Pabalan" -> "pabalan". */
export function surnameKey(name: string): string | null {
  const words = name
    .split(",")[0]
    .replace(/^(dr|doctor)\.?(\s+|$)/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(md|do|od|mmd)$/.test(w));
  return words.length ? words[words.length - 1] : null;
}

/** SQL string literal. */
export function lit(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? "NULL" : `'${v.replace(/'/g, "''")}'`;
}

// ── The seed ────────────────────────────────────────────────────────────────

export interface SeedProvider {
  id: number;
  fullName: string;
  npi: string | null;
  phone: string;
  email: string | null;
  region: string;
  rotationOrder: number | null;
}

export interface SeedResult {
  sql: string;
  providers: SeedProvider[];
  /** region (as typed) -> provider id; includes FINAL. */
  directors: Map<string, number>;
  /** week_starts_on -> provider id, in date order. */
  weeks: Array<{ week: string; providerId: number }>;
  /** Things that are allowed but worth reading before the SQL is run. */
  warnings: string[];
}

export interface SeedInput {
  poolCsv: string;
  scheduleCsv: string;
  /** Rows for a director who is not in the pool: name, phone, email, region, npi. */
  directorsCsv?: string;
  /** The final escalation director's name, as in the pool or the directors file. */
  final: string;
  /** Stamped into the SQL header. */
  generatedAt?: Date;
}

interface Candidate {
  fullName: string;
  npi: string | null;
  phone: string;
  email: string | null;
  region: string;
  /** The director named on this pool row, as typed. */
  director: string | null;
  inPool: boolean;
}

/**
 * The one candidate a typed name refers to: the same first and last name, or,
 * when the typed name is a surname alone ("Dr. Pabalan"), the one candidate
 * with that surname.
 */
function resolveName(typed: string, people: readonly Candidate[]): { hit: number } | { problem: string } {
  const key = nameKeyForMatch(typed);
  if (key) {
    const byFull = people.map((p, i) => [p, i] as const).filter(([p]) => nameKeyForMatch(p.fullName) === key);
    if (byFull.length === 1) return { hit: byFull[0][1] };
    if (byFull.length > 1) return { problem: `"${typed}" matches ${byFull.length} people` };
  }
  const surname = surnameKey(typed);
  if (!surname) return { problem: `"${typed}" is not a name` };
  const bySurname = people.map((p, i) => [p, i] as const).filter(([p]) => surnameKey(p.fullName) === surname);
  if (bySurname.length === 1) return { hit: bySurname[0][1] };
  if (bySurname.length > 1) {
    return { problem: `"${typed}" matches ${bySurname.length} people by surname; write the first name too` };
  }
  return { problem: `"${typed}" is not in the pool or the directors file` };
}

function readCandidates(table: Table, file: string, inPool: boolean, problems: string[]): Candidate[] {
  const out: Candidate[] = [];
  table.rows.forEach((row, i) => {
    const line = i + 2;
    const fullName = (row[table.found.name!] ?? "").trim();
    if (!fullName) {
      problems.push(`${file} line ${line}: no name`);
      return;
    }
    const phone = readPhone(row[table.found.phone!]);
    if (!phone) problems.push(`${file} line ${line} (${fullName}): the phone is not a phone number`);
    const npiRaw = table.found.npi ? (row[table.found.npi] ?? "").replace(/\D/g, "") : "";
    if (npiRaw && npiRaw.length !== 10) problems.push(`${file} line ${line} (${fullName}): the NPI is not 10 digits`);
    const region = cleanRegion(table.found.region ? (row[table.found.region] ?? "") : "");
    if (inPool && !region) problems.push(`${file} line ${line} (${fullName}): no region`);
    const director = table.found.director ? (row[table.found.director] ?? "").trim() || null : null;
    out.push({
      fullName,
      npi: npiRaw.length === 10 ? npiRaw : null,
      phone: phone ?? "",
      email: table.found.email ? (row[table.found.email] ?? "").trim() || null : null,
      region,
      director,
      inPool,
    });
  });
  return out;
}

export function buildSeedSql(input: SeedInput): SeedResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  const pool = readTable(input.poolCsv, "pool");
  const schedule = readTable(input.scheduleCsv, "schedule");
  const poolOk = need(pool, "pool", ["name", "phone", "region", "director"], problems);
  const scheduleOk = need(schedule, "schedule", ["week", "name"], problems);
  const extra = input.directorsCsv ? readTable(input.directorsCsv, "directors") : null;
  const extraOk = extra ? need(extra, "directors", ["name", "phone"], problems) : true;
  if (!poolOk || !scheduleOk || !extraOk) throw new SeedError(problems);

  const people = [
    ...readCandidates(pool, "pool", true, problems),
    ...(extra ? readCandidates(extra, "directors", false, problems) : []),
  ];

  // The same person twice (by name or NPI) cannot be told apart later.
  const seenName = new Map<string, number>();
  const seenNpi = new Map<string, number>();
  people.forEach((p, i) => {
    const key = nameKeyForMatch(p.fullName) ?? p.fullName.toLowerCase();
    if (seenName.has(key)) {
      if (p.inPool) problems.push(`"${p.fullName}" is in the pool twice`);
      // A director listed in both files: the pool row stands.
    } else seenName.set(key, i);
    if (p.npi) {
      if (seenNpi.has(p.npi) && seenNpi.get(p.npi) !== seenName.get(key)) {
        problems.push(`the NPI of "${p.fullName}" is also on "${people[seenNpi.get(p.npi)!].fullName}"`);
      } else seenNpi.set(p.npi, i);
    }
  });
  // One entry per person: drop a directors-file row for someone in the pool.
  const unique = people.filter((p, i) => seenName.get(nameKeyForMatch(p.fullName) ?? p.fullName.toLowerCase()) === i);

  // Region -> director, from what the pool rows say, plus FINAL.
  const directorOf = new Map<string, { region: string; idx: Set<number> }>();
  for (const p of unique.filter((x) => x.inPool)) {
    const k = regionKey(p.region);
    if (!k) continue;
    if (!directorOf.has(k)) directorOf.set(k, { region: p.region, idx: new Set() });
    if (!p.director) {
      problems.push(`pool (${p.fullName}): no escalation director`);
      continue;
    }
    const r = resolveName(p.director, unique);
    if ("problem" in r) problems.push(`pool (${p.fullName}), escalation director: ${r.problem}`);
    else directorOf.get(k)!.idx.add(r.hit);
  }
  for (const [, v] of directorOf) {
    if (v.idx.size > 1) {
      const names = [...v.idx].map((i) => unique[i].fullName).join(", ");
      problems.push(`region "${v.region}" has more than one escalation director in the pool: ${names}`);
    }
  }
  const finalHit = resolveName(input.final, unique);
  if ("problem" in finalHit) problems.push(`final director: ${finalHit.problem}`);

  // A director from the directors file needs a region of their own.
  unique.forEach((p, i) => {
    if (p.inPool || p.region) return;
    const directs = [...directorOf.values()].find((v) => v.idx.has(i));
    if (directs) p.region = directs.region;
    else if (!("problem" in finalHit) && finalHit.hit === i) {
      problems.push(`directors (${p.fullName}): no region; add one (the region they belong to)`);
    } else {
      warnings.push(`directors file: "${p.fullName}" directs no region and is not the final director; left out`);
    }
  });

  // The schedule.
  const weeks: Array<{ week: string; idx: number }> = [];
  const seenWeek = new Set<string>();
  schedule.rows.forEach((row, i) => {
    const line = i + 2;
    const rawWeek = row[schedule.found.week!] ?? "";
    const week = readDate(rawWeek);
    const who = (row[schedule.found.name!] ?? "").trim();
    if (!week) {
      problems.push(`schedule line ${line}: "${rawWeek}" is not a date`);
      return;
    }
    if (weekday(week) !== 2) {
      problems.push(`schedule line ${line}: ${week} is not a Tuesday (a week starts on Tuesday at 5:00 PM)`);
      return;
    }
    if (seenWeek.has(week)) {
      problems.push(`schedule line ${line}: the week of ${week} is listed twice`);
      return;
    }
    seenWeek.add(week);
    if (!who) {
      problems.push(`schedule line ${line}: no provider for the week of ${week}`);
      return;
    }
    const r = resolveName(who, unique.filter((p) => p.inPool));
    if ("problem" in r) {
      problems.push(`schedule line ${line} (${week}): ${r.problem}`);
      return;
    }
    // resolveName ran over the pool slice; map back to the unique index.
    const poolOnly = unique.filter((p) => p.inPool);
    weeks.push({ week, idx: unique.indexOf(poolOnly[r.hit]) });
  });
  weeks.sort((a, b) => a.week.localeCompare(b.week));
  for (let i = 1; i < weeks.length; i++) {
    if (plusDays(weeks[i - 1].week, 7) !== weeks[i].week) {
      warnings.push(
        `the schedule skips from ${weeks[i - 1].week} to ${weeks[i].week}: nobody is on call in between, so only the final director is rung`,
      );
    }
  }

  if (problems.length) throw new SeedError(problems);

  // Rotation order: the order providers first appear on the schedule, then
  // pool providers the schedule never names, in file order. A directors-file
  // row is not in the rotation.
  const order = new Map<number, number>();
  for (const w of weeks) if (!order.has(w.idx)) order.set(w.idx, order.size + 1);
  unique.forEach((p, i) => {
    if (p.inPool && !order.has(i)) {
      order.set(i, order.size + 1);
      warnings.push(`"${p.fullName}" is in the pool but on no week of the schedule; placed at the end of the rotation`);
    }
  });

  const needed = new Set<number>([...order.keys()]);
  for (const v of directorOf.values()) for (const i of v.idx) needed.add(i);
  needed.add((finalHit as { hit: number }).hit);

  const providers: SeedProvider[] = [];
  const idOf = new Map<number, number>();
  unique.forEach((p, i) => {
    if (!needed.has(i)) return;
    const id = providers.length + 1;
    idOf.set(i, id);
    providers.push({
      id,
      fullName: p.fullName,
      npi: p.npi,
      phone: p.phone,
      email: p.email,
      region: p.region,
      rotationOrder: order.get(i) ?? null,
    });
  });
  for (const p of providers) if (!p.npi) warnings.push(`"${p.fullName}" has no NPI; a post-op surgeon match falls back to the name`);

  const directors = new Map<string, number>();
  for (const v of directorOf.values()) {
    const [only] = [...v.idx];
    if (only !== undefined) directors.set(v.region, idOf.get(only)!);
  }
  directors.set(FINAL_REGION, idOf.get((finalHit as { hit: number }).hit)!);

  const weekRows = weeks.map((w) => ({ week: w.week, providerId: idOf.get(w.idx)! }));

  const at = (input.generatedAt ?? new Date()).toISOString();
  const sql = [
    `-- On-call rotation seed, generated by scripts/on-call-seed.ts at ${at}.`,
    `-- It holds staff phone numbers and emails: run it, then delete it. Never commit it.`,
    `-- Run after migrations/add_on_call_rotation.sql, on an empty rotation.`,
    `-- ${providers.length} providers, ${directors.size - 1} regions + FINAL, ${weekRows.length} weeks ` +
      `(${weekRows[0]?.week ?? "none"} to ${weekRows[weekRows.length - 1]?.week ?? "none"}).`,
    ``,
    `BEGIN;`,
    ``,
    `DO $oncall$ BEGIN`,
    `  IF EXISTS (SELECT 1 FROM on_call_providers) OR EXISTS (SELECT 1 FROM on_call_schedule)`,
    `     OR EXISTS (SELECT 1 FROM on_call_escalation_directors) THEN`,
    `    RAISE EXCEPTION 'the on-call tables are not empty: this seed is for the first load; use scripts/on-call-change.ts for changes';`,
    `  END IF;`,
    `END $oncall$;`,
    ``,
    `INSERT INTO on_call_providers (id, full_name, npi, phone, email, region, rotation_order, active) VALUES`,
    providers
      .map(
        (p) =>
          `  (${p.id}, ${lit(p.fullName)}, ${lit(p.npi)}, ${lit(p.phone)}, ${lit(p.email)}, ${lit(p.region)}, ` +
          `${p.rotationOrder ?? "NULL"}, true)`,
      )
      .join(",\n") + ";",
    `SELECT setval(pg_get_serial_sequence('on_call_providers', 'id'), (SELECT MAX(id) FROM on_call_providers));`,
    ``,
    `INSERT INTO on_call_escalation_directors (region, provider_id) VALUES`,
    [...directors].map(([region, id]) => `  (${lit(region)}, ${id})`).join(",\n") + ";",
    ``,
    `INSERT INTO on_call_schedule (week_starts_on, provider_id) VALUES`,
    weekRows.map((w) => `  ('${w.week}', ${w.providerId})`).join(",\n") + ";",
    ``,
    `COMMIT;`,
    ``,
  ].join("\n");

  return { sql, providers, directors, weeks: weekRows, warnings };
}

// ── Changes after the seed ──────────────────────────────────────────────────
//
// Each builder returns one transaction that checks what it depends on and
// raises, changing nothing, when it does not hold. A name is matched against
// full_name exactly (case and spacing ignored) and must name one active row.

/**
 * The PL/pgSQL that puts the id of the one provider named `name` into `var`.
 * Only active rows count unless `anyRow`: a week or a cover given to someone
 * taken off the rotation would ring nobody (`provider_inactive`).
 */
function lookupProvider(name: string, variable: string, anyRow = false): string {
  const n = lit(name.trim().replace(/\s+/g, " "));
  const where = `lower(regexp_replace(full_name, '\\s+', ' ', 'g')) = lower(${n})${anyRow ? "" : " AND active"}`;
  const kind = anyRow ? "provider" : "active provider";
  return [
    `  SELECT count(*) INTO n FROM on_call_providers WHERE ${where};`,
    `  IF n <> 1 THEN RAISE EXCEPTION 'expected one ${kind} named %, found %', ${n}, n; END IF;`,
    `  SELECT id INTO ${variable} FROM on_call_providers WHERE ${where};`,
  ].join("\n");
}

function requireDate(raw: string, what: string): string {
  const d = readDate(raw);
  if (!d) throw new SeedError([`${what}: "${raw}" is not a date`]);
  return d;
}

/**
 * A new provider at the END of the rotation (operator: "New onboarding
 * providers get added to the end of the rotation"). Their first week is the
 * first week `extendScheduleSql` adds after they are added; no week already on
 * the schedule changes.
 *
 * `escalationOnly` adds someone who takes escalations and no weekly turn (a
 * new medical director): no rotation place. `newRegion` allows a region no
 * director covers yet, for the first provider of a new region; without it a
 * region that is not on file is refused, so a typo cannot start one. A name
 * already on file, active or not, is refused: two rows under one name would
 * make every later change by that name refuse, and a returning provider is
 * `activateSql`.
 */
export function addProviderSql(input: {
  name: string;
  phone: string;
  email?: string;
  region: string;
  npi?: string;
  escalationOnly?: boolean;
  newRegion?: boolean;
}): string {
  const problems: string[] = [];
  const phone = readPhone(input.phone);
  if (!input.name.trim()) problems.push("no name");
  if (!phone) problems.push("the phone is not a phone number");
  const npi = (input.npi ?? "").replace(/\D/g, "");
  if (npi && npi.length !== 10) problems.push("the NPI is not 10 digits");
  const region = cleanRegion(input.region);
  if (!region) problems.push("no region");
  if (region && regionKey(region) === regionKey(FINAL_REGION)) {
    problems.push(`${FINAL_REGION} is the final escalation rung, not a region a provider works in`);
  }
  if (problems.length) throw new SeedError(problems);
  const name = lit(input.name.trim().replace(/\s+/g, " "));
  const known = `(SELECT region FROM on_call_escalation_directors WHERE ${regionIs(region)})`;
  return [
    `BEGIN;`,
    `DO $oncall$ BEGIN`,
    `  IF EXISTS (SELECT 1 FROM on_call_providers WHERE lower(regexp_replace(full_name, '\\s+', ' ', 'g')) = lower(${name})) THEN`,
    `    RAISE EXCEPTION 'a provider named % is already on file; to bring them back use activate', ${name};`,
    `  END IF;`,
    ...(input.newRegion
      ? []
      : [
          `  IF NOT EXISTS (SELECT 1 FROM on_call_escalation_directors WHERE ${regionIs(region)}) THEN`,
          `    RAISE EXCEPTION 'region % has no escalation director; check the spelling, or pass --new-region for a new region', ${lit(region)};`,
          `  END IF;`,
        ]),
    `END $oncall$;`,
    // VALUES, not INSERT ... SELECT FROM on_call_providers: without an
    // aggregate that SELECT yields one row per provider already on file.
    `INSERT INTO on_call_providers (full_name, npi, phone, email, region, rotation_order, active)`,
    `VALUES (${name}, ${lit(npi || null)}, ${lit(phone)}, ${lit(input.email?.trim() || null)},`,
    `        COALESCE(${known}, ${lit(region)}),`,
    `        ${input.escalationOnly ? "NULL" : "(SELECT COALESCE(MAX(rotation_order), 0) + 1 FROM on_call_providers)"}, true)`,
    `RETURNING id, full_name, region, rotation_order;`,
    `COMMIT;`,
    ``,
  ].join("\n");
}

/**
 * `weeks` more weeks after the last one on the schedule, continuing the
 * rotation in rotation_order among active providers, starting with the one
 * after the last week's provider (or the first, when that provider is not in
 * the rotation). RETURNING shows what was added; ROLLBACK instead of COMMIT
 * undoes it.
 */
export function extendScheduleSql(weeks: number): string {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) {
    throw new SeedError([`weeks must be a whole number from 1 to 104, not ${weeks}`]);
  }
  return [
    `BEGIN;`,
    `WITH last AS (`,
    `  SELECT s.week_starts_on, p.rotation_order`,
    `    FROM on_call_schedule s JOIN on_call_providers p ON p.id = s.provider_id`,
    `   ORDER BY s.week_starts_on DESC LIMIT 1`,
    `), pool AS (`,
    `  SELECT id, rotation_order, (row_number() OVER (ORDER BY rotation_order) - 1)::int AS pos,`,
    `         count(*) OVER ()::int AS n`,
    `    FROM on_call_providers WHERE active AND rotation_order IS NOT NULL`,
    `), start AS (`,
    `  SELECT CASE WHEN last.rotation_order IS NULL THEN 0`,
    `              ELSE (SELECT count(*) FROM pool WHERE pool.rotation_order <= last.rotation_order)::int END AS pos`,
    `    FROM last`,
    `), added AS (`,
    `  INSERT INTO on_call_schedule (week_starts_on, provider_id, note)`,
    `  SELECT (last.week_starts_on + 7 * k)::date, pool.id, 'added by scripts/on-call-change.ts extend'`,
    `    FROM last, start, generate_series(1, ${weeks}) AS k, pool`,
    `   WHERE pool.pos = (start.pos + k - 1) % pool.n`,
    `  RETURNING week_starts_on, provider_id`,
    `)`,
    `SELECT a.week_starts_on, p.full_name, p.region FROM added a JOIN on_call_providers p ON p.id = a.provider_id`,
    ` ORDER BY a.week_starts_on;`,
    `-- Read the weeks above. COMMIT keeps them; ROLLBACK drops them.`,
    `COMMIT;`,
    ``,
  ].join("\n");
}

/** A whole week given to someone else. */
export function swapWeekSql(input: { week: string; to: string; note?: string }): string {
  const week = requireDate(input.week, "week");
  if (weekday(week) !== 2) throw new SeedError([`${week} is not a Tuesday (a week starts on Tuesday at 5:00 PM)`]);
  const note = input.note?.trim() || `swapped to ${input.to.trim()}`;
  return [
    `BEGIN;`,
    `DO $oncall$ DECLARE n int; who int; BEGIN`,
    lookupProvider(input.to, "who"),
    `  UPDATE on_call_schedule SET provider_id = who, note = ${lit(note)}, updated_at = now() WHERE week_starts_on = '${week}';`,
    `  IF NOT FOUND THEN RAISE EXCEPTION 'the week of % is not on the schedule', '${week}'; END IF;`,
    `END $oncall$;`,
    `COMMIT;`,
    ``,
  ].join("\n");
}

/** Pacific wall-clock "YYYY-MM-DD HH:MM" (or a date and 12-hour time) -> "YYYY-MM-DD HH:MM". */
export function readPacificTime(raw: string): string | null {
  const date = readDate(raw);
  if (!date) return null;
  const t = /(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?\s*$/i.exec(raw.trim());
  if (!t) return null;
  let h = Number(t[1]);
  const min = Number(t[2]);
  const ampm = t[3]?.toLowerCase().replace(/\./g, "");
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return `${date} ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Someone covers part of a week (an evening, a weekend). It decides WHO for
 * the window and never WHETHER: daytime inside it is still not on call. Times
 * are Pacific wall-clock.
 */
export function coverSql(input: { from: string; to: string; by: string; reason?: string }): string {
  const from = readPacificTime(input.from);
  const to = readPacificTime(input.to);
  const problems: string[] = [];
  if (!from) problems.push(`from: "${input.from}" is not a date and time (2026-12-10 17:00)`);
  if (!to) problems.push(`to: "${input.to}" is not a date and time (2026-12-11 08:00)`);
  if (from && to && to <= from) problems.push("to must be after from");
  if (problems.length) throw new SeedError(problems);
  const reason = input.reason?.trim() || `cover by ${input.by.trim()}`;
  return [
    `BEGIN;`,
    `DO $oncall$ DECLARE n int; who int; BEGIN`,
    lookupProvider(input.by, "who"),
    `  INSERT INTO on_call_overrides (starts_at, ends_at, provider_id, reason)`,
    `  VALUES (('${from}'::timestamp AT TIME ZONE 'America/Los_Angeles'),`,
    `          ('${to}'::timestamp AT TIME ZONE 'America/Los_Angeles'), who, ${lit(reason)});`,
    `END $oncall$;`,
    `COMMIT;`,
    ``,
  ].join("\n");
}

/** Takes a provider off the rotation and the chain; their weeks ring only the final director until swapped. */
export function deactivateSql(name: string): string {
  return [
    `BEGIN;`,
    `DO $oncall$ DECLARE n int; who int; BEGIN`,
    lookupProvider(name, "who", true),
    `  UPDATE on_call_providers SET active = false, updated_at = now() WHERE id = who;`,
    `END $oncall$;`,
    `-- Their scheduled weeks from today on (swap each with on-call-change.ts swap):`,
    `SELECT s.week_starts_on FROM on_call_schedule s JOIN on_call_providers p ON p.id = s.provider_id`,
    ` WHERE lower(regexp_replace(p.full_name, '\\s+', ' ', 'g')) = lower(${lit(name.trim().replace(/\s+/g, " "))})`,
    `   AND s.week_starts_on >= (now() AT TIME ZONE 'America/Los_Angeles')::date - 7 ORDER BY 1;`,
    `COMMIT;`,
    ``,
  ].join("\n");
}

/** Puts a provider taken off with `deactivateSql` back, at the place in the rotation they had. */
export function activateSql(name: string): string {
  return [
    `BEGIN;`,
    `DO $oncall$ DECLARE n int; who int; BEGIN`,
    lookupProvider(name, "who", true),
    `  UPDATE on_call_providers SET active = true, updated_at = now() WHERE id = who;`,
    `END $oncall$;`,
    `COMMIT;`,
    ``,
  ].join("\n");
}

/**
 * A region's director changes (or the final director, with region FINAL). A
 * region that is not on file is refused unless `newRegion`, so a misspelt
 * region cannot quietly start a second one beside the real one.
 */
export function setDirectorSql(input: { region: string; director: string; newRegion?: boolean }): string {
  const region = cleanRegion(input.region);
  if (!region) throw new SeedError(["no region"]);
  return [
    `BEGIN;`,
    `DO $oncall$ DECLARE n int; who int; BEGIN`,
    lookupProvider(input.director, "who"),
    `  UPDATE on_call_escalation_directors SET provider_id = who, updated_at = now() WHERE ${regionIs(region)};`,
    `  IF NOT FOUND THEN`,
    ...(input.newRegion
      ? [`    INSERT INTO on_call_escalation_directors (region, provider_id) VALUES (${lit(region)}, who);`]
      : [`    RAISE EXCEPTION 'region % is not on file; check the spelling, or pass --new-region for a new region', ${lit(region)};`]),
    `  END IF;`,
    `END $oncall$;`,
    `COMMIT;`,
    ``,
  ].join("\n");
}
