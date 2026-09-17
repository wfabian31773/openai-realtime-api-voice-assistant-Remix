/**
 * src/tools/gateAttempts.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDING, WHICH NOTHING TESTED.
 *
 * This module carries the per-call state for every filing gate in the fleet,
 * in memory, in a process that stays up for weeks. It has a TTL, a size
 * ceiling, recency eviction and a "a sentinel is not a call" guard — and not
 * one of them had a test, in this file or any other.
 *
 * That mattered on 2026-09-04: `dobEscape` kept a per-call fact in a Set of
 * its own with none of those protections, and the review that found it
 * pointed here as the thing to reuse (Codex, PR #268 round 15). Reusing an
 * unpinned mechanism is how the next one gets written the same way, so the
 * mechanism is pinned first and the fact-store is pinned with it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gateRefusalsSoFar, noteGateRefusal, noteCallFact, callFactNoted, resetGateAttempts, settleGateAttempt, claimGateAttemptAfterSettlement, GATE_SETTLEMENT_WAIT_MS } from "./gateAttempts";

/** A real Twilio CallSid: CA + 32 hex. Anything else is a sentinel. */
const sid = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;
const CALL = sid(1);
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

beforeEach(() => {
  resetGateAttempts();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-04T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  resetGateAttempts();
});

describe("counting refusals for one call", () => {
  it("counts per call, per tool, per field — never across them", () => {
    noteGateRefusal(CALL, "file_optical_ticket", "location");
    expect(gateRefusalsSoFar(CALL, "file_optical_ticket", "location")).toBe(1);
    // A different field, tool or call is a different counter. Sharing any of
    // them would make one caller's answer count for another's.
    expect(gateRefusalsSoFar(CALL, "file_optical_ticket", "date_of_birth")).toBe(0);
    expect(gateRefusalsSoFar(CALL, "file_surgery_ticket", "location")).toBe(0);
    expect(gateRefusalsSoFar(sid(2), "file_optical_ticket", "location")).toBe(0);
  });
});

describe("a sentinel is not a call", () => {
  /**
   * `call_sid` is a declared property, so a model with no injected value
   * supplies "unknown" or "latest". A truthiness check made every such call
   * share one counter, and one caller refused for a missing office made the
   * NEXT sentinel-bearing call look already-asked — so it skipped the
   * question and filed unassigned without ever asking (Codex, PR #244).
   */
  it.each(["unknown", "latest", "none", "N/A", "", undefined])(
    "%s never becomes a key",
    (bogus) => {
      noteGateRefusal(bogus as string | undefined, "file_optical_ticket", "location");
      expect(gateRefusalsSoFar(bogus as string | undefined, "file_optical_ticket", "location")).toBe(0);
    },
  );

  it("and cannot record a per-call fact either", () => {
    noteCallFact("unknown", "spoke_a_date");
    expect(callFactNoted("unknown", "spoke_a_date")).toBe(false);
  });

  /**
   * THE READ IS GUARDED TOO, WHICH IS WHY THE CASES ABOVE ARE NOT ENOUGH.
   *
   * Both `noteGateRefusal` and `gateRefusalsSoFar` validate the key, so
   * removing the guard from the WRITE alone is invisible through a read — I
   * mutated exactly that and every case above still passed. The damage a
   * write-side guard does is not a wrong answer, it is unbounded growth: a
   * model free-forming an id per call fills the map with keys no read will
   * ever ask for, and the eviction they cause is the only observable.
   *
   * So this measures the growth, by its effect on the ceiling.
   */
  it("arbitrary model-invented ids never consume the map's ceiling", () => {
    const REAL = sid(200000);
    noteGateRefusal(REAL, "file_optical_ticket", "location");

    // A whole ceiling's worth of plausible-looking rubbish: uuids, "unknown",
    // a phone number — the shapes actually seen in live payloads.
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      noteGateRefusal(`00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
        "file_optical_ticket", "location");
    }

    // Nothing was stored, so the real call is still there and unevicted.
    expect(gateRefusalsSoFar(REAL, "file_optical_ticket", "location")).toBe(1);
  });
});

describe("the TTL — this is what stops the map being a leak", () => {
  it("a count is gone once the call is long over", () => {
    noteGateRefusal(CALL, "file_optical_ticket", "location");
    expect(gateRefusalsSoFar(CALL, "file_optical_ticket", "location")).toBe(1);
    vi.advanceTimersByTime(TTL_MS + 1);
    expect(gateRefusalsSoFar(CALL, "file_optical_ticket", "location")).toBe(0);
  });

  it("but survives comfortably longer than any real call", () => {
    noteGateRefusal(CALL, "file_optical_ticket", "location");
    vi.advanceTimersByTime(10 * 60_000); // ten minutes; the cap on a call is ten
    expect(gateRefusalsSoFar(CALL, "file_optical_ticket", "location")).toBe(1);
  });

  it("a per-call FACT expires on the same clock", () => {
    // The whole point of moving it here rather than into a Set of its own.
    noteCallFact(CALL, "spoke_a_date");
    expect(callFactNoted(CALL, "spoke_a_date")).toBe(true);
    vi.advanceTimersByTime(TTL_MS + 1);
    expect(callFactNoted(CALL, "spoke_a_date")).toBe(false);
  });

  it("expired entries are actually swept, not merely hidden from reads", () => {
    // The read path checks the timestamp, so a leak would be invisible to it.
    // A later write sweeps, and the proof is that a re-read after the sweep
    // still says 0 rather than resurrecting a stale count.
    noteGateRefusal(CALL, "file_optical_ticket", "location");
    vi.advanceTimersByTime(TTL_MS + 1);
    noteGateRefusal(sid(999), "file_tech_ticket", "location"); // triggers sweep
    expect(gateRefusalsSoFar(CALL, "file_optical_ticket", "location")).toBe(0);
    // ...and re-noting starts from one, not from the stale count.
    expect(noteGateRefusal(CALL, "file_optical_ticket", "location")).toBe(1);
  });
});

describe("the size ceiling — for the day the TTL is not enough", () => {
  it("drops the least recently touched once past the cap", () => {
    const FIRST = sid(100000);
    noteGateRefusal(FIRST, "file_optical_ticket", "location");
    expect(gateRefusalsSoFar(FIRST, "file_optical_ticket", "location")).toBe(1);

    // Fill past the ceiling without letting the TTL do the work — every one
    // of these is fresh, so only the cap can evict.
    //
    // MAX_ENTRIES + 1 writes, not MAX_ENTRIES: the sweep runs BEFORE the
    // insert, so the map reaches the ceiling on one write and is trimmed on
    // the next. Off by one on a safety ceiling is immaterial, but a test that
    // assumed otherwise would fail and look like a missing cap.
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      noteGateRefusal(sid(i), "file_optical_ticket", "location");
    }

    expect(gateRefusalsSoFar(FIRST, "file_optical_ticket", "location")).toBe(0);
    // The most recent survives — eviction is oldest-first, not indiscriminate.
    expect(gateRefusalsSoFar(sid(MAX_ENTRIES), "file_optical_ticket", "location")).toBe(1);
  });

  it("re-noting a call refreshes its recency, so an active call is not evicted", () => {
    const ACTIVE = sid(100001);
    noteGateRefusal(ACTIVE, "file_optical_ticket", "location");
    for (let i = 0; i < MAX_ENTRIES / 2; i++) {
      noteGateRefusal(sid(i), "file_optical_ticket", "location");
    }
    // Touched again mid-flood: it goes to the back of the insertion order.
    noteGateRefusal(ACTIVE, "file_optical_ticket", "location");
    for (let i = MAX_ENTRIES / 2; i < MAX_ENTRIES; i++) {
      noteGateRefusal(sid(i), "file_optical_ticket", "location");
    }
    expect(gateRefusalsSoFar(ACTIVE, "file_optical_ticket", "location")).toBe(2);
  });
});

describe("facts and counts share the map without colliding", () => {
  it("a fact does not read as a refusal of the same name", () => {
    noteCallFact(CALL, "location");
    // The fact is namespaced under its own pseudo-tool, so a gate asking
    // "how many times have I refused this call for location" is unaffected.
    expect(gateRefusalsSoFar(CALL, "file_optical_ticket", "location")).toBe(0);
    expect(callFactNoted(CALL, "location")).toBe(true);
  });

  it("noting a fact twice still reads as noted, not as a count", () => {
    noteCallFact(CALL, "spoke_a_date");
    noteCallFact(CALL, "spoke_a_date");
    expect(callFactNoted(CALL, "spoke_a_date")).toBe(true);
  });
});

describe('claim after the attempts ahead have settled (2026-09-17, #321 round 16)', () => {
  const SID = 'CA0123456789abcdef0123456789abcdef';
  beforeEach(() => resetGateAttempts());

  it('the first claim answers at once with 0; the next waits for it to settle and then reads what it drew', async () => {
    expect(await claimGateAttemptAfterSettlement(SID, 't', 'f')).toBe(0);
    let second: number | undefined;
    const p = claimGateAttemptAfterSettlement(SID, 't', 'f').then((v) => { second = v; });
    await Promise.resolve();
    expect(second).toBeUndefined(); // still parked: the first attempt has not answered
    settleGateAttempt(SID, 't', 'f', true);
    await p;
    expect(second).toBe(1);
  });

  it('three concurrent claims serialise: each reads only CONFIRMED refusals, so 0, 1, 2 when all three refuse', async () => {
    const seen: number[] = [];
    const claims = [1, 2, 3].map(() =>
      claimGateAttemptAfterSettlement(SID, 't', 'f').then((v) => {
        seen.push(v);
        settleGateAttempt(SID, 't', 'f', true);
      }),
    );
    await Promise.all(claims);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('an attempt that settled without a refusal is not counted by the ones behind it', async () => {
    const seen: number[] = [];
    const answers = [false, false, true];
    const claims = answers.map((refused) =>
      claimGateAttemptAfterSettlement(SID, 't', 'f').then((v) => {
        seen.push(v);
        settleGateAttempt(SID, 't', 'f', refused);
      }),
    );
    await Promise.all(claims);
    expect(seen).toEqual([0, 0, 0]);
    expect(gateRefusalsSoFar(SID, 't', 'f')).toBe(1);
  });

  it('a sentinel call_sid claims nothing, waits for nothing and settles nothing', async () => {
    expect(await claimGateAttemptAfterSettlement('unknown', 't', 'f')).toBe(0);
    expect(await claimGateAttemptAfterSettlement('unknown', 't', 'f')).toBe(0);
    settleGateAttempt('unknown', 't', 'f', true);
    expect(gateRefusalsSoFar('unknown', 't', 'f')).toBe(0);
  });

  it('keys on the call, the tool and the field — an attempt in flight on one field parks nobody on another', async () => {
    await claimGateAttemptAfterSettlement(SID, 't', 'f');
    expect(await claimGateAttemptAfterSettlement(SID, 't', 'g')).toBe(0);
    expect(await claimGateAttemptAfterSettlement('CAfedcba9876543210fedcba9876543210', 't', 'f')).toBe(0);
  });

  it('a settle that never comes releases the waiter at the bound rather than wedging the call', async () => {
    vi.useFakeTimers();
    try {
      await claimGateAttemptAfterSettlement(SID, 't', 'f');
      let released = false;
      const p = claimGateAttemptAfterSettlement(SID, 't', 'f').then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(GATE_SETTLEMENT_WAIT_MS - 1);
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await p;
      expect(released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
