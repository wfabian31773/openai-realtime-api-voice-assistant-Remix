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

type Row = { id: string; gradedAt: Date | null; sentiment?: string | null };
const q = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  patches: [] as Array<[string, Record<string, unknown>]>,
}));
vi.mock("../../server/storage", () => ({
  storage: {
    claimCallLogForGrading: async (id: string) => {
      const r = q.rows.get(id);
      if (!r || r.gradedAt !== null) return false;
      r.gradedAt = new Date();
      return true;
    },
    updateCallLog: async (id: string, patch: Record<string, unknown>) => {
      q.patches.push([id, patch]);
      const r = q.rows.get(id);
      if (r && "gradedAt" in patch) r.gradedAt = patch.gradedAt as Date | null;
      if (r && "sentiment" in patch) r.sentiment = patch.sentiment as string;
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
