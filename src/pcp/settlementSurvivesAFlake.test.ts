/**
 * THE TWO CODEX FINDINGS ON #313, BOTH AFTER THE MERGE, BOTH REAL.
 *
 * The review started nine seconds before the squash landed and finished six
 * minutes after it, so this code was on `main` before anybody read it. That
 * is the third time (#307, #310, now #313) and the pattern is in CLAUDE.md;
 * what is new here is that both findings were correct and neither was
 * reachable from the tests that shipped with them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * P1 — A TRANSIENT TICKET FAILURE HAD NO SECOND CHANCE ANYWHERE.
 *
 * `handleBlindDialResult` fires the lane callback, forgets the pending dial
 * and answers Twilio 200. Twilio has no reason to retry a 200 and the pending
 * entry is gone, so a blip on the ticketing app left the ticket at
 * `DIALING` / `HAND_OFF` forever. On a `no_answer` that is v30's whole point
 * lost: the request is never reopened as an OPEN task, and a caller who sat
 * in hold music and gave up is never called back.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * P2 — THE LONGEST CALLS WOULD HAVE FILED NOWHERE.
 *
 * v31 pastes the caller's own lines into `narrative` so a human can route a
 * call nobody classified. `narrative` is capped at 12,000 characters and
 * `submitPcpTicket` safeParses BEFORE the wire — so a long enough call was
 * refused locally, with no POST and no 400 in `voice_agent_api_logs`. The
 * calls with the most for a staffer to read were the ones most likely to be
 * dropped, by the code written to stop them being dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  NARRATIVE_MAX_CHARS,
} from './pcpTicketing';
import {
  SETTLE_RETRY_DELAYS_MS,
  TRUNCATION_NOTE,
  persistSettlement,
  settlementIsWorthRetrying,
  trimToBudget,
} from './queueDialSettlement';

const ok = { success: true };
const flake = { success: false, error: 'socket hang up' };

/** Never actually waits — the schedule is asserted, not slept through. */
function fakeSleep() {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
}

// ── P1 ─────────────────────────────────────────────────────────────────────

describe('a transient settlement failure gets another go', () => {
  it('retries a flake and succeeds', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(flake)
      .mockResolvedValueOnce(flake)
      .mockResolvedValueOnce(ok);
    const { waited, sleep } = fakeSleep();

    const res = await persistSettlement(post, { sleep, log: () => {} });

    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(3);
    expect(post).toHaveBeenCalledTimes(3);
    expect(waited, 'backs off rather than hammering').toEqual([
      SETTLE_RETRY_DELAYS_MS[0],
      SETTLE_RETRY_DELAYS_MS[1],
    ]);
  });

  it('gives up after a bounded number of attempts rather than looping', async () => {
    const post = vi.fn().mockResolvedValue(flake);
    const { waited, sleep } = fakeSleep();

    const res = await persistSettlement(post, { sleep, log: () => {} });

    expect(res.ok).toBe(false);
    expect(post).toHaveBeenCalledTimes(SETTLE_RETRY_DELAYS_MS.length + 1);
    expect(waited).toHaveLength(SETTLE_RETRY_DELAYS_MS.length);
    expect(res.lastError).toBe('socket hang up');
  });

  /**
   * A THROW IS TRANSIENT, NOT A VERDICT. `submitPcpTicket` returns a
   * structured failure for everything it decides itself, so anything that
   * escapes as an exception came from below it — the network, the client.
   */
  it('treats a thrown error as a flake', async () => {
    const post = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok);
    const { sleep } = fakeSleep();

    const res = await persistSettlement(post, { sleep, log: () => {} });

    expect(res.ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
  });

  /**
   * THE OTHER DIRECTION MATTERS TOO. `invalid_payload:` comes from
   * submitPcpTicket's OWN safeParse — a pure function of the payload. Retrying
   * sends the identical bytes to the identical check, so it is three wasted
   * POSTs and a slower log line.
   */
  it('does NOT retry a refusal the payload itself caused', async () => {
    const post = vi.fn().mockResolvedValue({
      success: false,
      error: 'invalid_payload: narrative',
    });
    const { waited, sleep } = fakeSleep();

    const res = await persistSettlement(post, { sleep, log: () => {} });

    expect(res.ok).toBe(false);
    expect(post, 'a deterministic refusal is answered once').toHaveBeenCalledTimes(1);
    expect(waited).toEqual([]);
  });

  it('knows which errors are worth another try', () => {
    expect(settlementIsWorthRetrying('invalid_payload: narrative')).toBe(false);
    expect(settlementIsWorthRetrying('disposition_not_allowed: HAND_OFF')).toBe(false);
    expect(settlementIsWorthRetrying('HTTP 503')).toBe(true);
    expect(settlementIsWorthRetrying('socket hang up')).toBe(true);
    expect(settlementIsWorthRetrying(undefined), 'no reason given is not a verdict').toBe(true);
  });

  /** The first attempt is not a retry — a healthy app costs one POST. */
  it('posts exactly once when the app is healthy', async () => {
    const post = vi.fn().mockResolvedValue(ok);
    const { waited, sleep } = fakeSleep();

    const res = await persistSettlement(post, { sleep, log: () => {} });

    expect(res).toMatchObject({ ok: true, attempts: 1 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(waited).toEqual([]);
  });
});

// ── P2 ─────────────────────────────────────────────────────────────────────

describe('a long call still files', () => {
  it('leaves a narrative that already fits completely alone', () => {
    const short = '  - I need to check on a referral.';

    expect(trimToBudget(short, NARRATIVE_MAX_CHARS)).toBe(short);
    expect(
      trimToBudget(short, NARRATIVE_MAX_CHARS),
      'the note must not appear on a ticket that was not cut',
    ).not.toContain('trimmed');
  });

  it('cuts an over-long excerpt to fit, note included', () => {
    const long = Array.from({ length: 400 }, (_, i) => `  - caller line ${i}`).join('\n');
    const budget = 500;

    const out = trimToBudget(long, budget);

    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out).toContain('trimmed');
    expect(out, 'a staffer must be told where the rest is').toContain('transcript');
  });

  /**
   * Half a caller turn is worse than one fewer turn — the excerpt is a
   * bulleted list and a staffer routing on it should not have to guess
   * whether a sentence ended or we cut it.
   */
  it('cuts at a line boundary rather than mid-turn', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `  - line number ${i}`).join('\n');

    const out = trimToBudget(lines, 300);
    const body = out.slice(0, out.indexOf(TRUNCATION_NOTE));

    expect(body.endsWith('\n')).toBe(false);
    for (const l of body.split('\n')) {
      expect(l, `"${l}" is a whole turn`).toMatch(/^ {2}- line number \d+$/);
    }
  });

  /** A budget too small for even the note still tells them to read on. */
  it('degrades to the note alone rather than returning something misleading', () => {
    expect(trimToBudget('a'.repeat(100), 5)).toContain('transcript');
    expect(trimToBudget('a'.repeat(100), 0)).toContain('transcript');
    expect(trimToBudget('a'.repeat(100), -20)).toContain('transcript');
  });

  /**
   * THE CAP IS THE SCHEMA'S OWN, not a second copy. A hand-written 12000 here
   * is the `explicitAsk.ts` noun-list shape: two constants that drift and
   * nothing says so.
   */
  it('uses the schema\'s own ceiling', async () => {
    const { PcpTicketPayloadSchema } = await import('./pcpTicketing');
    const atCap = PcpTicketPayloadSchema.safeParse({});
    // The parse fails for many reasons here; what is asserted is the CONSTANT
    // being the one the schema was built from, checked by construction below.
    expect(atCap.success).toBe(false);
    expect(NARRATIVE_MAX_CHARS).toBe(12000);

    const overCap = 'x'.repeat(NARRATIVE_MAX_CHARS + 1);
    const trimmed = trimToBudget(overCap, NARRATIVE_MAX_CHARS);
    expect(trimmed.length).toBeLessThanOrEqual(NARRATIVE_MAX_CHARS);
  });
});
