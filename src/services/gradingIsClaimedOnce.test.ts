/**
 * ONE GRADE PER CALL — Codex P2 on #321, round 7.
 *
 * `gradedAt` was the lock that said a call had been graded, and it was
 * stamped only after the LLM answered. Between a completed row landing and
 * that stamp, the teardown grader (old core, and the runtime since v49) and
 * the five-minute backfill could both select the row and both pay for a
 * grade, the last answer overwriting the first. The claim is now the stamp,
 * taken atomically before the LLM is asked, inside gradeCall itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.OPENAI_API_KEY ||= "test-unused";

type Row = { id: string; gradedAt: Date | null; sentiment?: string | null; qualityAnalysis?: unknown };
const LEASE_MS = 10 * 60 * 1000;
const q = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  patches: [] as Array<[string, Record<string, unknown>]>,
  now: 1_000_000_000,
}));
/** The store's lease semantics, as server/storage.ts implements them in SQL:
 * a row is claimable when ungraded, or when it still reads `claimed` from
 * longer ago than the lease. */
const claimable = (r: Row, leaseMs: number) =>
  r.gradedAt === null ||
  (r.gradedAt.getTime() < q.now - leaseMs && (r.qualityAnalysis as { grading?: string } | undefined)?.grading === "claimed");
vi.mock("../../server/storage", () => ({
  storage: {
    claimCallLogForGrading: async (id: string, leaseMs = LEASE_MS) => {
      const r = q.rows.get(id);
      if (!r || !claimable(r, leaseMs)) return false;
      r.gradedAt = new Date(q.now);
      r.qualityAnalysis = { grading: "claimed" };
      return true;
    },
    updateCallLog: async (id: string, patch: Record<string, unknown>) => {
      q.patches.push([id, patch]);
      const r = q.rows.get(id);
      if (r && "gradedAt" in patch) r.gradedAt = patch.gradedAt as Date | null;
      if (r && "sentiment" in patch) r.sentiment = patch.sentiment as string;
      if (r && "qualityAnalysis" in patch) r.qualityAnalysis = patch.qualityAnalysis;
    },
  },
}));
vi.mock("../../server/db", () => ({ db: {} }));

const { CallGradingService } = await import("./callGradingService");

const TRANSCRIPT = "CALLER: " + "words ".repeat(40);
const ANSWER = {
  sentiment: "neutral",
  agentOutcome: "follow_up_needed",
  qualityScore: 4,
  summary: "s",
  strengths: [],
  improvements: [],
  keyMoments: [],
  patientConcerns: [],
};

function service(llm: () => Promise<unknown>) {
  const svc = new CallGradingService();
  const create = vi.fn(llm);
  (svc as unknown as { openaiClient: unknown }).openaiClient = { chat: { completions: { create } } };
  (svc as unknown as { runAndPersistDeterministicGraders: unknown }).runAndPersistDeterministicGraders = async () => undefined;
  return { svc, create };
}
const answers = async () => ({ choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: undefined });

beforeEach(() => {
  q.rows = new Map([["c1", { id: "c1", gradedAt: null }]]);
  q.patches.length = 0;
  q.now = 1_000_000_000;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a call is graded once", () => {
  it("two graders racing on the same row pay for ONE grade", async () => {
    const { svc, create } = service(answers);
    const [a, b] = await Promise.all([svc.gradeCall("c1", TRANSCRIPT), svc.gradeCall("c1", TRANSCRIPT)]);
    expect(create).toHaveBeenCalledTimes(1);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("the backfill arriving after the teardown's claim does not grade again", async () => {
    const { svc, create } = service(answers);
    expect(await svc.gradeCall("c1", TRANSCRIPT)).toBeTruthy();
    expect(await svc.gradeCall("c1", TRANSCRIPT)).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a grade whose LLM call fails RELEASES the claim, so the backfill can retry it", async () => {
    const { svc } = service(async () => {
      throw new Error("llm down");
    });
    expect(await svc.gradeCall("c1", TRANSCRIPT)).toBeNull();
    expect(q.rows.get("c1")!.gradedAt).toBeNull();
    // ... and the retry then grades it.
    const { svc: again, create } = service(answers);
    expect(await again.gradeCall("c1", TRANSCRIPT)).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("an empty answer releases the claim too", async () => {
    const { svc } = service(async () => ({ choices: [{ message: { content: null } }] }));
    expect(await svc.gradeCall("c1", TRANSCRIPT)).toBeNull();
    expect(q.rows.get("c1")!.gradedAt).toBeNull();
  });

  it("a manual regrade (claim: false) grades a row that is already graded", async () => {
    q.rows.set("c1", { id: "c1", gradedAt: new Date(1) });
    const { svc, create } = service(answers);
    expect(await svc.gradeCall("c1", TRANSCRIPT, undefined, { claim: false })).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("the admin regrade route is the one caller that says claim: false", () => {
    const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
    const site = routes.slice(routes.indexOf("app.post('/api/call-logs/:id/grade'"));
    expect(site.slice(0, site.indexOf("res.json("))).toMatch(/gradeCall\(callLog\.id, callLog\.transcript, undefined, \{ claim: false \}\)/);
    // And no automatic caller does.
    for (const f of ["../runtime/runtimeGrading.ts", "./callGradingService.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, `${f} bypasses the claim`).not.toMatch(/claim:\s*false/);
    }
  });
});

describe("an abandoned claim is recoverable — Codex P2 on #321, round 8", () => {
  it("a completed grade overwrites the claim marker, so it is never reclaimed", async () => {
    const { svc } = service(answers);
    expect(await svc.gradeCall("c1", TRANSCRIPT)).toBeTruthy();
    const r = q.rows.get("c1")!;
    expect(r.gradedAt).not.toBeNull();
    expect((r.qualityAnalysis as { grading?: string }).grading).toBeUndefined();
    // Even a lease later, nobody can take it again.
    q.now += LEASE_MS + 1;
    const { svc: later, create } = service(answers);
    expect(await later.gradeCall("c1", TRANSCRIPT)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("a claim the process died on — no grade, no release — is taken again once the lease has passed, and not before", async () => {
    // The crash: the store holds the claim and nothing else ever happens to it.
    await (await import("../../server/storage")).storage.claimCallLogForGrading("c1");
    expect(q.rows.get("c1")!.qualityAnalysis).toEqual({ grading: "claimed" });
    const { svc: early, create: earlyCreate } = service(answers);
    q.now += LEASE_MS - 1;
    expect(await early.gradeCall("c1", TRANSCRIPT)).toBeNull();
    expect(earlyCreate).not.toHaveBeenCalled();
    q.now += 2;
    const { svc: late, create: lateCreate } = service(answers);
    expect(await late.gradeCall("c1", TRANSCRIPT)).toBeTruthy();
    expect(lateCreate).toHaveBeenCalledTimes(1);
  });

  it("a release clears the marker as well as the stamp", async () => {
    const { svc } = service(async () => {
      throw new Error("llm down");
    });
    await svc.gradeCall("c1", TRANSCRIPT);
    const release = q.patches.find(([, p]) => "gradedAt" in p && p.gradedAt === null)!;
    expect(release[1]).toEqual({ gradedAt: null, qualityAnalysis: null });
  });
});

describe("the store's own SQL carries the lease — read from the source", () => {
  const src = readFileSync(new URL("../../server/storage.ts", import.meta.url), "utf8");

  it("the selector and the claim both read gradingClaimable, which is ungraded OR claimed-and-stale", () => {
    const pred = src.slice(src.indexOf("export function gradingClaimable"), src.indexOf("export class DatabaseStorage"));
    expect(pred).toMatch(/isNull\(callLogs\.gradedAt\)/);
    expect(pred).toMatch(/lt\(callLogs\.gradedAt, staleBefore\)/);
    expect(pred).toMatch(/->>'grading' = 'claimed'/);
    const selector = src.slice(src.indexOf("async getCallLogsWithoutGrades("), src.indexOf("async getCallLogsWithStaleGraderVersion("));
    expect(selector).toMatch(/gradingClaimable\(new Date\(Date\.now\(\) - leaseMs\)\)/);
    const claim = src.slice(src.indexOf("async claimCallLogForGrading("), src.indexOf("async getCallLogsWithStaleGraderVersion("));
    expect(claim).toMatch(/gradingClaimable\(new Date\(Date\.now\(\) - leaseMs\)\)/);
    expect(claim).toMatch(/qualityAnalysis: GRADING_CLAIM_MARKER/);
  });

  it("the dead-letter and short-transcript stamps never write the marker, so they are never reclaimed", () => {
    const svc = readFileSync(new URL("./callGradingService.ts", import.meta.url), "utf8");
    const backfill = svc.slice(svc.indexOf("async gradeCallsWithoutGrades("));
    for (const m of backfill.matchAll(/updateCallLog\(call\.id, \{ gradedAt: new Date\(\)( \})/g)) expect(m[1]).toBe(" }");
    expect(backfill).not.toMatch(/grading: ['"]claimed['"]/);
  });
});
