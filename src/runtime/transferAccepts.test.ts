import { describe, it, expect, vi } from "vitest";
import { TransferAcceptError, TransferAcceptRegistry } from "./transferAccepts";

/** A registry with a hand-driven clock, so no test waits on a real timer. */
function registry(windowMs = 45_000) {
  const timers = new Map<number, () => void>();
  let next = 1;
  let nowMs = 1_000_000;
  const reg = new TransferAcceptRegistry({
    windowMs,
    setTimer: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h) => void timers.delete(h as unknown as number),
    log: () => undefined,
    now: () => nowMs,
  });
  return {
    reg,
    fire: () => [...timers.values()].forEach((f) => f()),
    timers,
    advance: (ms: number) => void (nowMs += ms),
  };
}

async function settled(p: Promise<void>): Promise<string> {
  return p.then(
    () => "resolved",
    (e: TransferAcceptError) => e.resolution,
  );
}

describe("a digit is the only accept", () => {
  it("resolves on a keypress", async () => {
    const { reg } = registry();
    const waiting = reg.waitFor("CAoffice");
    expect(reg.recordDigits("CAoffice", "1")).toBe(true);
    expect(await settled(waiting)).toBe("resolved");
  });

  it("treats NO digits as a decline, not a timeout", async () => {
    // actionOnEmptyResult posts with no Digits when the briefing played out to
    // someone who pressed nothing. A decline is immediate; a timeout would
    // cost the caller another 45 seconds of hold.
    const { reg } = registry();
    const waiting = reg.waitFor("CAoffice");
    reg.recordDigits("CAoffice", "");
    expect(await settled(waiting)).toBe("declined");
  });

  it("treats whitespace-only digits as a decline", async () => {
    const { reg } = registry();
    const waiting = reg.waitFor("CAoffice");
    reg.recordDigits("CAoffice", "   ");
    expect(await settled(waiting)).toBe("declined");
  });

  it("accepts any digit, not just a particular one", async () => {
    for (const d of ["0", "5", "9", "#", "*"]) {
      const { reg } = registry();
      const waiting = reg.waitFor("CAoffice");
      reg.recordDigits("CAoffice", d);
      expect(await settled(waiting), d).toBe("resolved");
    }
  });
});

describe("the window", () => {
  it("rejects as a timeout when it closes", async () => {
    const { reg, fire } = registry();
    const waiting = reg.waitFor("CAoffice");
    fire();
    expect(await settled(waiting)).toBe("timeout");
  });

  it("does not fire the timer after an accept", async () => {
    const { reg, fire, timers } = registry();
    const waiting = reg.waitFor("CAoffice");
    reg.recordDigits("CAoffice", "1");
    expect(timers.size, "timer leaked past the accept").toBe(0);
    fire();
    expect(await settled(waiting)).toBe("resolved");
  });

  it("clears the timer on every settle path, so nothing keeps the process alive", async () => {
    for (const settleIt of [
      (r: TransferAcceptRegistry) => r.recordDigits("CA", "1"),
      (r: TransferAcceptRegistry) => r.recordDigits("CA", ""),
      (r: TransferAcceptRegistry) => r.abandon("CA"),
    ]) {
      const { reg, timers } = registry();
      const waiting = reg.waitFor("CA");
      settleIt(reg);
      await settled(waiting);
      expect(timers.size).toBe(0);
      expect(reg.pendingCount()).toBe(0);
    }
  });
});

describe("legs nobody is waiting on", () => {
  it("reports a keypress on an unknown leg as not pending", () => {
    const { reg } = registry();
    expect(reg.recordDigits("CAghost", "1")).toBe(false);
  });

  it("reports a keypress after the window closed as not pending", async () => {
    const { reg, fire } = registry();
    const waiting = reg.waitFor("CAoffice");
    fire();
    await settled(waiting);
    // The office pressed a key just after the window shut. The caller has
    // already been told the transfer failed; bridging now would be worse.
    expect(reg.recordDigits("CAoffice", "1")).toBe(false);
  });

  it("does not throw when a settled leg is settled again", async () => {
    const { reg } = registry();
    const waiting = reg.waitFor("CAoffice");
    reg.recordDigits("CAoffice", "1");
    await settled(waiting);
    expect(() => reg.recordDigits("CAoffice", "1")).not.toThrow();
    expect(reg.abandon("CAoffice")).toBe(false);
  });
});

describe("the caller hanging up while the office rings", () => {
  it("abandons the wait so nothing bridges into a dead call", async () => {
    const { reg } = registry();
    const waiting = reg.waitFor("CAoffice");
    expect(reg.abandon("CAoffice")).toBe(true);
    expect(await settled(waiting)).toBe("abandoned");
  });
});

describe("a terminal status that beats the wait's registration", () => {
  it("still settles the wait, instead of holding the caller the full window", async () => {
    // Twilio can POST busy/failed for the office leg before calls.create()
    // resolves on our side — the abandon finds nothing, and unremembered
    // the wait that registers moments later has no callback left to
    // settle it early (Codex, PR #230 round 5).
    const { reg } = registry();
    expect(reg.abandon("CAoffice")).toBe(false); // nothing pending YET
    const waiting = reg.waitFor("CAoffice");
    expect(await settled(waiting)).toBe("abandoned");
    expect(reg.pendingCount()).toBe(0);
  });

  it("consumes the memory — it cannot kill an unrelated later wait", async () => {
    const { reg } = registry();
    reg.abandon("CAoffice");
    await settled(reg.waitFor("CAoffice"));
    // A fresh wait on the same sid (not a thing Twilio does, but the
    // memory must not linger) survives to a real accept.
    const second = reg.waitFor("CAoffice");
    reg.recordDigits("CAoffice", "1");
    expect(await settled(second)).toBe("resolved");
  });

  it("forgets a status older than the window — it cannot belong to a wait registering now", async () => {
    const { reg, fire, advance } = registry(45_000);
    reg.abandon("CAstale");
    advance(46_000);
    // The prune runs on the next abandon; the stale sid is dropped.
    reg.abandon("CAother");
    const waiting = reg.waitFor("CAstale");
    fire(); // only the window timer remains to settle it
    expect(await settled(waiting)).toBe("timeout");
  });
});

describe("duplicate waits", () => {
  it("abandons the first rather than orphaning it forever", async () => {
    const { reg } = registry();
    const first = reg.waitFor("CAoffice");
    const second = reg.waitFor("CAoffice");
    expect(await settled(first)).toBe("abandoned");
    reg.recordDigits("CAoffice", "1");
    expect(await settled(second)).toBe("resolved");
  });

  it("leaves exactly one pending entry", () => {
    const { reg } = registry();
    void reg.waitFor("CAoffice").catch(() => undefined);
    void reg.waitFor("CAoffice").catch(() => undefined);
    expect(reg.pendingCount()).toBe(1);
  });
});
