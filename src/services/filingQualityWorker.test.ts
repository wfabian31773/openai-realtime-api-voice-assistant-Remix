import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CANDIDATES_SQL,
  ENSURE_INDEX_SQL,
  ENSURE_TABLE_SQL,
  failureKind,
  FILING_QUALITY_BATCH,
  FILING_QUALITY_CONCURRENCY,
  FILING_QUALITY_MAX_ATTEMPTS,
  filingQualityEnabled,
  INSERT_SQL,
  runFilingQualityCycle,
  type ExpectationCandidate,
  type FilingQualityLock,
  type FilingQualityStore,
} from "./filingQualityWorker";

/** Synthetic people only. */
const SECRET_NAME = "Testa Patientson";
const SECRET_PHONE = "9095550142";
const sid = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;
const candidate = (n: number): ExpectationCandidate => ({
  callSid: sid(n),
  agentUsed: "tech",
  startedAt: new Date("2026-11-09T17:00:00Z"),
  transcript: `AGENT: How can I help?\nCALLER: This is ${SECRET_NAME}, call me at ${SECRET_PHONE}, I need a refill.`,
});
const goodAnswer = {
  should_file: true, no_file_reason: null, topic: "medication_or_refill", urgent: false, caller_role: "patient",
  requester_name: null, requester_organization: null, patient_first_name: "Testa", patient_last_name: "Patientson",
  patient_dob: null, callback_number: SECRET_PHONE, callback_is_caller_id: false, email: null, office_named: null,
  provider_named: null, medication_named: null, records_delivery: null, contact_preference: null, request_summary: "Refill",
};

function fakeStore(rows: ExpectationCandidate[]) {
  const inserted: Array<Parameters<FilingQualityStore["insert"]>[0]> = [];
  const skips: string[][] = [];
  const store: FilingQualityStore & { ensured: number } = {
    ensured: 0,
    async ensureTable() {
      store.ensured++;
    },
    async candidates(limit, skip) {
      skips.push(skip);
      return rows.filter((r) => !skip.includes(r.callSid) && !inserted.some((i) => i.callSid === r.callSid)).slice(0, limit);
    },
    async insert(row) {
      inserted.push(row);
    },
  };
  return { store, inserted, skips };
}

function fakeLock(acquires = true) {
  const lock: FilingQualityLock & { released: number } = {
    released: 0,
    acquire: vi.fn(async () => acquires),
    async release() {
      lock.released++;
    },
  };
  return lock;
}

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });

describe("one cycle", () => {
  it("does nothing when another process holds the lock", async () => {
    const { store, inserted } = fakeStore([candidate(1)]);
    const ask = vi.fn();
    const r = await runFilingQualityCycle({ store, lock: fakeLock(false), ask, attempts: new Map() });
    expect(r.ran).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("reads each call once and stores what it found", async () => {
    const { store, inserted } = fakeStore([candidate(1), candidate(2)]);
    const lock = fakeLock();
    const r = await runFilingQualityCycle({ store, lock, ask: vi.fn().mockResolvedValue(goodAnswer), log: quietLog(), attempts: new Map() });
    expect(r).toMatchObject({ ran: true, read: 2, stored: 2, skipped: 0, failed: 0 });
    expect(inserted.map((i) => i.callSid)).toEqual([sid(1), sid(2)]);
    expect(inserted[0].expectation?.topic).toBe("medication_or_refill");
    expect(inserted[0].skipped).toBeNull();
    expect(lock.released).toBe(1);
  });

  it("an unusable answer is stored as skipped, so it is not read again", async () => {
    const { store, inserted } = fakeStore([candidate(1)]);
    const r = await runFilingQualityCycle({ store, lock: fakeLock(), ask: vi.fn().mockResolvedValue({ nonsense: true }), log: quietLog(), attempts: new Map() });
    expect(r.skipped).toBe(1);
    expect(inserted[0]).toMatchObject({ callSid: sid(1), expectation: null, skipped: "no_usable_answer" });
  });

  it("a failure is retried next cycle, then left alone after three tries", async () => {
    const { store, inserted, skips } = fakeStore([candidate(1)]);
    const attempts = new Map<string, number>();
    const ask = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { status: 503 }));
    for (let i = 0; i < FILING_QUALITY_MAX_ATTEMPTS; i++) {
      const r = await runFilingQualityCycle({ store, lock: fakeLock(), ask, log: quietLog(), attempts });
      expect(r.failed).toBe(1);
    }
    expect(attempts.get(sid(1))).toBe(FILING_QUALITY_MAX_ATTEMPTS);
    const after = await runFilingQualityCycle({ store, lock: fakeLock(), ask, log: quietLog(), attempts });
    expect(after.read).toBe(0);
    expect(skips[skips.length - 1]).toEqual([sid(1)]);
    expect(inserted).toHaveLength(0);
  });

  it("logs a failure by call SID and kind only, never what the caller said", async () => {
    const { store } = fakeStore([candidate(1)]);
    const log = quietLog();
    await runFilingQualityCycle({ store, lock: fakeLock(), ask: vi.fn().mockRejectedValue(new Error(`echo: ${SECRET_NAME} ${SECRET_PHONE}`)), log, attempts: new Map() });
    const lines = [...log.warn.mock.calls, ...log.info.mock.calls].map((c) => c.join(" "));
    expect(lines.join("\n")).toContain(sid(1));
    expect(lines.join("\n")).not.toContain("Testa");
    expect(lines.join("\n")).not.toContain(SECRET_PHONE);
    expect(lines.join("\n")).not.toContain("refill");
  });

  it("releases the lock even when the store throws", async () => {
    const { store } = fakeStore([]);
    store.candidates = async () => {
      throw new Error("db down");
    };
    const lock = fakeLock();
    await expect(runFilingQualityCycle({ store, lock, ask: vi.fn(), log: quietLog(), attempts: new Map() })).rejects.toThrow("db down");
    expect(lock.released).toBe(1);
  });

  it("ensures the table once per store, not every cycle", async () => {
    const { store } = fakeStore([]);
    await runFilingQualityCycle({ store, lock: fakeLock(), ask: vi.fn(), log: quietLog(), attempts: new Map() });
    await runFilingQualityCycle({ store, lock: fakeLock(), ask: vi.fn(), log: quietLog(), attempts: new Map() });
    expect(store.ensured).toBe(1);
  });

  it("never has more than three reads in flight", async () => {
    const { store } = fakeStore(Array.from({ length: 10 }, (_, i) => candidate(i + 1)));
    let inFlight = 0;
    let peak = 0;
    const ask = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return goodAnswer;
    });
    const r = await runFilingQualityCycle({ store, lock: fakeLock(), ask, log: quietLog(), attempts: new Map() });
    expect(r.stored).toBe(10);
    expect(peak).toBe(FILING_QUALITY_CONCURRENCY);
  });
});

describe("failure kinds", () => {
  it("names the kind and never the message", () => {
    expect(failureKind(new SyntaxError("Unexpected token in JSON at position 3: Testa"))).toBe("unreadable_answer");
    expect(failureKind(Object.assign(new Error("Testa"), { status: 429 }))).toBe("http_429");
    expect(failureKind(Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" }))).toBe("timeout");
    expect(failureKind(new Error("no_api_key"))).toBe("no_api_key");
    expect(failureKind(new Error("anything with Testa in it"))).toBe("error");
  });
});

describe("the switch", () => {
  it("is off without a key, and off when disabled", () => {
    expect(filingQualityEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(filingQualityEnabled({ OPENAI_API_KEY: "k", FILING_QUALITY_DISABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(filingQualityEnabled({ OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("the SQL, pinned", () => {
  it("selects substantive, finished, real calls with no expectation yet, newest first", () => {
    expect(CANDIDATES_SQL).toContain("c.duration >= 30");
    expect(CANDIDATES_SQL).toContain("c.transcript LIKE '%CALLER:%'");
    expect(CANDIDATES_SQL).toContain("c.call_sid ~* '^CA[0-9a-f]{32}$'");
    expect(CANDIDATES_SQL).toContain("<> 'wayne-operator'");
    expect(CANDIDATES_SQL).toMatch(/"from", ''\) NOT LIKE \('%' \|\| \$3::text\)/);
    expect(CANDIDATES_SQL).toMatch(/"to", ''\) NOT LIKE \('%' \|\| \$3::text\)/);
    expect(CANDIDATES_SQL).toMatch(/dialed_number, ''\) NOT LIKE \('%' \|\| \$3::text\)/);
    expect(CANDIDATES_SQL).toContain("NOT EXISTS (SELECT 1 FROM filing_expectations f WHERE f.call_sid = c.call_sid)");
    expect(CANDIDATES_SQL).toContain("NOT (c.call_sid = ANY($4::text[]))");
    expect(CANDIDATES_SQL).toContain("- INTERVAL '2 minutes'");
    expect(CANDIDATES_SQL).toMatch(/ORDER BY c\.created_at DESC\s+LIMIT \$1::int/);
  });

  it("inserts once per call and never overwrites", () => {
    expect(INSERT_SQL).toContain("ON CONFLICT (call_sid) DO NOTHING");
    expect(INSERT_SQL).toContain("$6::jsonb");
    expect(ENSURE_TABLE_SQL).toContain("CREATE TABLE IF NOT EXISTS filing_expectations");
    expect(ENSURE_TABLE_SQL).toContain("call_sid TEXT PRIMARY KEY");
    expect(ENSURE_INDEX_SQL).toContain("CREATE INDEX IF NOT EXISTS idx_filing_expectations_started ON filing_expectations (call_started_at)");
  });

  it("reads a batch of 25", () => {
    expect(FILING_QUALITY_BATCH).toBe(25);
  });

  it("is started at boot beside the ticket outbox worker", () => {
    const server = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
    expect(server).toMatch(/import\('\.\/services\/filingQualityWorker'\)\.then\(\(\{ startFilingQualityWorker \}\) => \{\s*startFilingQualityWorker\(\);/);
  });
});
