/**
 * The join key that went missing at the cutover.
 *
 * Measured 2026-09-04: 239 of 239 runtime calls had call_logs.agent_id NULL
 * while 100% of old-core rows carried it, and five separate reports join on
 * that column. These tests pin the resolution, the caching, and — the part
 * that matters most — that a lane with no agents row still gets logged.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { resolveAgentId, resetAgentIdCache, agentIdMarker } from "./agentIdentity";

const OPTICAL_ID = "5c01c386-621e-41c1-a501-82b3cc36c09c";

beforeEach(() => {
  resetAgentIdCache();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("resolving a lane slug to its agents-table id", () => {
  it("returns the id the reports join on", async () => {
    expect(await resolveAgentId("optical", async () => OPTICAL_ID)).toBe(OPTICAL_ID);
  });

  it("asks the database ONCE per lane, not once per call", async () => {
    const lookup = vi.fn(async () => OPTICAL_ID);
    await resolveAgentId("optical", lookup);
    await resolveAgentId("optical", lookup);
    await resolveAgentId("optical", lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not let two simultaneous calls both query", async () => {
    const lookup = vi.fn(async () => OPTICAL_ID);
    const [a, b] = await Promise.all([
      resolveAgentId("optical", lookup),
      resolveAgentId("optical", lookup),
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("keeps lanes apart", async () => {
    const lookup = vi.fn(async (slug: string) => `id-${slug}`);
    expect(await resolveAgentId("optical", lookup)).toBe("id-optical");
    expect(await resolveAgentId("surgery", lookup)).toBe("id-surgery");
  });

  /**
   * A miss is NOT remembered. If the agents row is missing because nobody has
   * added it yet, the next call must find it the moment they do — without a
   * redeploy, and without the lane staying invisible for the rest of the day.
   */
  it("retries a slug that had no row, rather than writing it off", async () => {
    let row: string | undefined = undefined;
    const lookup = vi.fn(async () => row);
    expect(await resolveAgentId("brand-new", lookup)).toBeUndefined();
    row = "later-id";
    expect(await resolveAgentId("brand-new", lookup)).toBe("later-id");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  /**
   * THE HANG (Codex, PR #268). A lookup that never settles was cached as a
   * pending promise forever, so every later call on the lane awaited it and
   * never reached the call-row insert — and an absent row loses the call's
   * whole timeline, because flushAzulTimeline marks its events flushed
   * whether or not a row was there to update.
   */
  it("gives up on a lookup that never settles, instead of hanging every later call", async () => {
    const never = () => new Promise<string | undefined>(() => {});
    const started = Date.now();
    await expect(resolveAgentId("wedged", never, 20)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("EVICTS the timed-out lookup so the next call retries rather than inheriting it", async () => {
    const settle: { fn: ((v: string | undefined) => void) | null } = { fn: null };
    const hangs = () => new Promise<string | undefined>((r) => { settle.fn = r; });
    expect(await resolveAgentId("wedged", hangs, 20)).toBeUndefined();
    // The pool recovers; the very next call must succeed, with no redeploy.
    expect(await resolveAgentId("wedged", async () => OPTICAL_ID, 20)).toBe(OPTICAL_ID);
    settle.fn?.(undefined);
  });

  it("does not let the abandoned lookup's later rejection crash the process", async () => {
    const reject: { fn: ((e: Error) => void) | null } = { fn: null };
    const hangs = () => new Promise<string | undefined>((_r, rj) => { reject.fn = rj; });
    await resolveAgentId("wedged", hangs, 20);
    reject.fn?.(new Error("pool died after we stopped waiting"));
    // If the orphan were unhandled this turns into an unhandledRejection.
    await new Promise((r) => setTimeout(r, 20));
    expect(true).toBe(true);
  });

  it("survives a database that is down — the call still gets logged", async () => {
    const boom = async () => {
      throw new Error("connection refused");
    };
    await expect(resolveAgentId("optical", boom)).resolves.toBeUndefined();
  });
});

describe("the marker", () => {
  it("prints once per lane on success, so four lines prove the deploy took", async () => {
    const lookup = async () => OPTICAL_ID;
    const info = vi.mocked(console.info);
    await resolveAgentId("optical", lookup);
    await resolveAgentId("optical", lookup);
    const opticalLines = info.mock.calls.filter((c) => String(c[0]).includes("[AGENT ID] optical"));
    expect(opticalLines).toHaveLength(1);
  });

  /**
   * The opposite: a missing row is a live problem, so its line must keep
   * printing. A marker that goes quiet while the damage continues is how the
   * damage stays unnoticed — which is the whole reason this module exists.
   */
  it("keeps printing while a lane has no row", async () => {
    const info = vi.mocked(console.info);
    await resolveAgentId("nowhere", async () => undefined);
    await resolveAgentId("nowhere", async () => undefined);
    const lines = info.mock.calls.filter((c) => String(c[0]).includes('"nowhere"'));
    expect(lines).toHaveLength(2);
  });

  /**
   * The moment worth seeing. A lane that was missing its agents row and then
   * gets one must announce it — that line is how you know the gap closed.
   * Remembering a lane you only ever FAILED to resolve would swallow it.
   */
  it("announces the success after an earlier failure on the same lane", async () => {
    const info = vi.mocked(console.info);
    let row: string | undefined = undefined;
    const lookup = async () => row;
    await resolveAgentId("late", lookup);
    row = OPTICAL_ID;
    await resolveAgentId("late", lookup);
    const success = info.mock.calls.filter((c) => String(c[0]).includes(`late -> ${OPTICAL_ID}`));
    expect(success).toHaveLength(1);
  });

  it("names the damage, not just the fact", () => {
    const line = agentIdMarker("optical", undefined);
    expect(line).toContain("Observatory");
    expect(line).toContain("cost");
    expect(line).toContain("NULL");
  });

  it("carries a slug and a uuid and nothing else — no PHI passes through here", () => {
    const line = agentIdMarker("optical", OPTICAL_ID);
    expect(line).toContain("optical");
    expect(line).toContain(OPTICAL_ID);
    expect(line).not.toMatch(/\+?1?\d{10}/);
  });
});
