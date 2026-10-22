/**
 * WHICH SOFTWARE HANDLED THE CALL — v111, Stage C (A6). The stamp, the column
 * check that lets the migration and the publish happen in either order, the
 * build-time SHA writer, and the wiring that puts each where it runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  COLUMNS_SQL,
  OLD_CORE_MARKER,
  STAMP_SQL,
  _resetBuildIdentityForTests,
  createColumnCheck,
  deployedBuildSha,
  oldCoreBuildIdentity,
  runtimeBuildIdentity,
  stampBuildIdentity,
  type Query,
} from "./buildIdentity";
import { VOICE_RUNTIME_DEPLOY_MARKER } from "./readiness";
import { getBuildInfo } from "../../server/buildInfo";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SID = "CA0000000000000000000000000000b111";

function recordingQuery(columns: number | Error) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const query: Query = async (text, params) => {
    calls.push({ text, params });
    if (text === COLUMNS_SQL) {
      if (columns instanceof Error) throw columns;
      return { rows: [{ n: columns }] };
    }
    return { rows: [] };
  };
  return { calls, query };
}

beforeEach(() => {
  _resetBuildIdentityForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the stamp never overwrites and never guesses", () => {
  it("fills each column only where it is NULL", () => {
    expect(STAMP_SQL).toContain("runtime_marker = COALESCE(runtime_marker, $2::text)");
    expect(STAMP_SQL).toContain("build_sha = COALESCE(build_sha, $3::text)");
    expect(STAMP_SQL).toContain("voice_model = COALESCE(voice_model, $4::text)");
    expect(STAMP_SQL).toMatch(/WHERE call_sid = \$1::text$/);
  });

  it("a runtime call carries the deploy marker, the build SHA and the lane's model", () => {
    expect(runtimeBuildIdentity("grok-voice-3.0")).toEqual({
      runtimeMarker: VOICE_RUNTIME_DEPLOY_MARKER,
      buildSha: deployedBuildSha(),
      voiceModel: "grok-voice-3.0",
    });
    expect(runtimeBuildIdentity("  ").voiceModel).toBeNull();
    expect(runtimeBuildIdentity(undefined).voiceModel).toBeNull();
  });

  it("an old-core call reads 'old-core' and names no model", () => {
    expect(OLD_CORE_MARKER).toBe("old-core");
    expect(oldCoreBuildIdentity()).toEqual({ runtimeMarker: "old-core", buildSha: deployedBuildSha(), voiceModel: null });
  });

  it("a SHA that is missing or not a SHA is null, never a guess", () => {
    expect(deployedBuildSha(() => ({ gitSha: null }))).toBeNull();
    _resetBuildIdentityForTests();
    expect(deployedBuildSha(() => ({ gitSha: "pre-stamp build" }))).toBeNull();
    _resetBuildIdentityForTests();
    expect(deployedBuildSha(() => ({ gitSha: "3f4ec74" }))).toBe("3f4ec74");
  });
});

describe("the migration and the publish may come in either order", () => {
  it("with the columns absent nothing is written, it says so once, and it never throws", async () => {
    const { calls, query } = recordingQuery(0);
    const check = createColumnCheck(query);
    expect(await stampBuildIdentity(SID, oldCoreBuildIdentity(), { query, check })).toBe(false);
    expect(await stampBuildIdentity(SID, oldCoreBuildIdentity(), { query, check })).toBe(false);
    expect(calls.filter((c) => c.text === STAMP_SQL)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[build-identity] columns absent; not stamping");
  });

  it("with all three columns present the one statement runs with the call's values", async () => {
    const { calls, query } = recordingQuery(3);
    const check = createColumnCheck(query);
    const ok = await stampBuildIdentity(SID, { runtimeMarker: "m", buildSha: "abc1234", voiceModel: null }, { query, check });
    expect(ok).toBe(true);
    expect(calls[calls.length - 1]).toEqual({ text: STAMP_SQL, params: [SID, "m", "abc1234", null] });
  });

  it("two of three columns is absent, not present", async () => {
    const { query } = recordingQuery(2);
    expect(await createColumnCheck(query).present()).toBe(false);
  });

  it("absent is re-checked after ten minutes, so a migration applied after the publish starts the stamping", async () => {
    let n = 0;
    let t = 0;
    const query: Query = async () => ({ rows: [{ n }] });
    const check = createColumnCheck(query, () => t);
    expect(await check.present()).toBe(false);
    n = 3;
    t = 9 * 60_000;
    expect(await check.present()).toBe(false);
    t = 10 * 60_000;
    expect(await check.present()).toBe(true);
  });

  it("present is remembered: the check is not re-run on every call", async () => {
    const { calls, query } = recordingQuery(3);
    const check = createColumnCheck(query);
    await check.present();
    await check.present();
    expect(calls.filter((c) => c.text === COLUMNS_SQL)).toHaveLength(1);
  });

  it("an unreadable check is absent, and a failed stamp returns false instead of throwing", async () => {
    const { query } = recordingQuery(new Error("db down"));
    expect(await createColumnCheck(query).present()).toBe(false);
    const failing: Query = async (text) => {
      if (text === COLUMNS_SQL) return { rows: [{ n: 3 }] };
      throw new Error("write failed");
    };
    await expect(
      stampBuildIdentity(SID, oldCoreBuildIdentity(), { query: failing, check: createColumnCheck(failing) }),
    ).resolves.toBe(false);
  });

  it("the columns are NOT declared to Drizzle, which lists every declared column in every insert and select", () => {
    const schema = read("shared/schema.ts");
    for (const col of ["runtime_marker", "build_sha", "voice_model"]) {
      expect(schema).not.toContain(`"${col}"`);
    }
  });

  it("the migration adds exactly the three nullable columns and the two learning tables", () => {
    const sql = read("migrations/add_call_build_identity.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS runtime_marker text;");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS build_sha      text;");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS voice_model    text;");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.learning_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.learning_metric_values");
    expect(sql).not.toMatch(/NOT NULL[^\n]*runtime_marker text|DROP (?!TABLE IF EXISTS|COLUMN IF EXISTS)/);
  });
});

describe("the build SHA is written at build time, never committed", () => {
  const script = path.join(ROOT, "scripts/write-build-info.cjs");

  function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "build-info-"));
  }

  it("inside a git checkout it writes the commit the bundle is built from", () => {
    const dir = tmp();
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    execFileSync("node", [script], { cwd: dir, stdio: "pipe" });
    const info = getBuildInfo(path.join(dir, "build-info.json"));
    const head = git("rev-parse", "HEAD");
    expect(info.gitShaFull).toBe(head);
    expect(info.gitSha).toBe(head.slice(0, 7));
    // No origin/main to compare with: unknown, not false.
    expect(info.traceable).toBeNull();
  });

  it("outside a checkout a stale file is REMOVED and the SHA reads null, never the old value", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ builtAt: "2026-08-12", gitSha: "3f4ec74" }));
    execFileSync("node", [script], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_DIR: path.join(dir, "no-such-git") } });
    expect(getBuildInfo(path.join(dir, "build-info.json")).gitSha).toBeNull();
  });

  it("a write that FAILS still leaves no stale file behind — the old one is removed first", () => {
    const dir = tmp();
    const out = path.join(dir, "build-info.json");
    fs.writeFileSync(out, JSON.stringify({ builtAt: "2026-08-12", gitSha: "3f4ec74" }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const writer = require(script) as { main: (out: string) => void };
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      writer.main(out);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(out)).toBe(false);
    expect(getBuildInfo(out).gitSha).toBeNull();
  });

  it("a missing file reads as null on every field", () => {
    expect(getBuildInfo(path.join(tmp(), "build-info.json"))).toEqual({
      builtAt: null, gitSha: null, gitShaFull: null, traceable: null,
    });
  });

  it("the deployment build runs the writer, and the file is ignored rather than committed", () => {
    expect(read(".replit")).toMatch(/build = \["bash", "-c", "node scripts\/write-build-info\.cjs && /);
    expect(read("package.json")).toContain('"build": "node scripts/write-build-info.cjs && ');
    expect(read(".gitignore").split("\n")).toContain("build-info.json");
    expect(execFileSync("git", ["ls-files", "build-info.json"], { cwd: ROOT }).toString().trim()).toBe("");
  });
});

describe("the wiring — a helper proven alone proves the helper (failure mode 10)", () => {
  it("every old-core row is stamped where it is opened", () => {
    const storage = read("server/storage.ts");
    const create = storage.slice(storage.indexOf("async createCallLog("), storage.indexOf("async updateCallLog("));
    expect(create).toContain("stampBuildIdentity(callLog.callSid, oldCoreBuildIdentity())");
  });

  it("the runtime stamps after the row opens and after the teardown write lands", () => {
    const rt = read("src/runtime/voiceRuntime.ts");
    expect(rt).toMatch(/if \(id\) callLogId = id;\s*stampCall\(entry\.callSid, entry\.slug\);/);
    expect(rt).toMatch(/if \(written\) stampCall\(record\.callSid, record\.slug\);/);
    expect(rt).toContain("runtimeBuildIdentity(loadGrokRuntimeVoiceConfig(env, slug).model)");
  });
});
