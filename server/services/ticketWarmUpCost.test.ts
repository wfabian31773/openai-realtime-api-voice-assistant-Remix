/**
 * THE WARM-UP PROBE WAS THE SLOWEST PART OF FILING A TICKET.
 *
 * Operator, 2026-08-17: *"let's track down why it's taking 27 seconds to file a
 * ticket, this is something that should happen in seconds, not half a minute."*
 *
 * The 27 seconds turned out to be my own bad phrasing about WHEN a PCP records
 * ticket files, not how long it takes. But the underlying instinct was right,
 * and pulling the fleet's numbers found a real one:
 *
 *     no-ivr             create_ticket   p50 8.3s  p90 19.2s  max 91.2s
 *     answering-service  create_ticket   p50 5.0s  p90 11.1s  max 67.9s
 *     optical / surgery  file_*_ticket   p50 ~4.0s p90 ~5.0s
 *     check_open_tickets (SAME API)      p50 0.17s
 *
 * The ticketing API answers reads in 170ms, so the API is not the problem. What
 * every create pays for first is `warmUpWithRetry(2, 500)` — a liveness probe
 * bounded at 3s, plus a 500ms sleep and a second probe when the first fails.
 * Worst case 6.5 seconds before the POST is attempted.
 *
 * The cruelty of it is which line pays. The probe exists to wake a sleeping
 * Replit deployment; the deployment sleeps at night; **no-ivr is the
 * after-hours line**. Its p50 sits 3.3s above answering-service for exactly
 * that reason — the line that carries the night is the one billed for the
 * night.
 *
 * The fix caches liveness for 60s and skips the probe inside that window. It
 * changes no failure handling: warm-up was already "ADVISORY, not a gate" and
 * its failure never blocked a ticket.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./ticketingApiClient.ts', import.meta.url), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the probe is skipped when we already know the app is awake', () => {
  it('every warm-up call site goes through the cache', () => {
    /**
     * Three sites: createTicket, the simplified submit, and submitTicket.
     * A new one added later must use warmUpIfStale too — a direct
     * warmUpWithRetry call would silently reintroduce the cost.
     */
    const direct = code.match(/this\.warmUpWithRetry\(/g) ?? [];
    // Exactly one: the call INSIDE warmUpIfStale itself.
    expect(direct.length, 'a call site still probes unconditionally').toBe(1);
    const cached = code.match(/warmUpIfStale\(/g) ?? [];
    // One definition + three call sites.
    expect(cached.length).toBeGreaterThanOrEqual(4);
  });

  it('the cached call inside warmUpIfStale is the only unconditional one', () => {
    const fn = code.slice(code.indexOf('private async warmUpIfStale'), code.indexOf('private ensureInitialized'));
    expect(fn).toMatch(/this\.warmUpWithRetry\(maxRetries, delayMs\)/);
  });

  it('liveness is recorded from a real response, not only from the probe', () => {
    // A successful create is better proof of life than any health check, and
    // it is the one that happens on every busy call.
    expect(code).toMatch(/this\.markAlive\([^;]*\);\s*\n\s*return data as T;/);
  });

  it('the health check records liveness too', () => {
    const hc = code.slice(code.indexOf('async healthCheck'), code.indexOf('private async makeRequest'));
    expect(hc).toMatch(/markAlive\(/);
  });
});

describe('liveness belongs to the host the probe would wake', () => {
  /**
   * Found in review, 2026-08-17, and it arms itself on a config change I had
   * just recommended.
   *
   * `healthCheck` probes the DIRECT app when TICKETING_ENRICHMENT_URL is set,
   * and the n8n gateway otherwise. The first version of the cache marked alive
   * on ANY successful request — so with the enrichment URL configured, a call
   * through the gateway would suppress the probe of the sleeping app for 60
   * seconds. The create then pays the cold start anyway and the cache has
   * bought nothing while hiding the reason.
   *
   * Not a live bug today (the URL is unset, so both are one host). It becomes
   * one the moment the operator sets it.
   */
  /**
   * SECOND REVIEW PASS, 2026-08-17. The first version of this fix compared
   * INTENT flags — "was this request meant for the direct app?" against "does
   * the probe use the direct app?". With TICKETING_ENRICHMENT_URL unset those
   * are the same host, but the flags disagree, so `createPcpTicket` and
   * `updateTicketCallData` (both pass useEnrichmentBase=true) had their proof
   * of life discarded and the next create paid the full probe anyway — the
   * cache silently doing nothing on the paths that use it most.
   *
   * Comparing the RESOLVED BASE is correct in both configurations and needs no
   * reasoning about which flag means what.
   */
  it('markAlive takes the host that answered, not a flag', () => {
    expect(code).toMatch(/private markAlive\(answeredBase: string \| null \| undefined\)/);
  });

  it('and compares it against the base the probe actually contacts', () => {
    const fn = code.slice(code.indexOf('private markAlive('), code.indexOf('private async warmUpIfStale'));
    expect(fn).toMatch(/if \(!answeredBase \|\| answeredBase !== this\.probeBase\(\)\) return;/);
    // Never a flag comparison again — that is the bug this replaced.
    expect(fn).not.toMatch(/fromDirectApp/);
  });

  it('probeBase mirrors the health check\'s own choice', () => {
    const probe = code.slice(code.indexOf('private probesDirectApp'), code.indexOf('private markAlive('));
    expect(probe).toMatch(/!!this\.enrichmentBaseUrl && this\.enrichmentBaseUrl !== this\.baseUrl/);
    expect(probe).toMatch(/this\.probesDirectApp\(\) \? this\.enrichmentBaseUrl : this\.baseUrl/);
  });

  it('each call site passes the base it actually used', () => {
    expect(code).toMatch(/this\.markAlive\(\(useEnrichmentBase && this\.enrichmentBaseUrl\) \|\| this\.baseUrl\)/);
    expect(code).toMatch(/this\.markAlive\(useDirectApp \? this\.enrichmentBaseUrl : this\.baseUrl\)/);
  });

  it('the same host answering always counts, whatever the flag said', () => {
    // The regression in one line: with one configured host, both call sites
    // resolve to baseUrl and probeBase() is baseUrl, so liveness is recorded.
    const fn = code.slice(code.indexOf('private markAlive('), code.indexOf('private async warmUpIfStale'));
    expect(fn).toMatch(/answeredBase !== this\.probeBase\(\)/);
  });

  it('warmUpIfStale does not re-stamp liveness with the wrong default', () => {
    // It used to call markAlive() bare after a successful probe, which would
    // stamp fromDirectApp=false even when the probe hit the direct app.
    const fn = code.slice(code.indexOf('private async warmUpIfStale'), code.indexOf('private ensureInitialized'));
    expect(fn).not.toMatch(/this\.markAlive\(\)/);
  });
});

describe('the window is conservative and cannot fire before first contact', () => {
  it('is sixty seconds', () => {
    expect(code).toMatch(/LIVENESS_TTL_MS = 60_000/);
  });

  it('a cold process always probes', () => {
    /**
     * `lastAliveAt` starts at 0, so without the explicit `> 0` guard the first
     * call of a boot would compute a huge elapsed time and probe correctly by
     * accident — but a clock at the epoch would not. Pinned so the intent is
     * not left to arithmetic.
     */
    const fn = code.slice(code.indexOf('private async warmUpIfStale'), code.indexOf('private ensureInitialized'));
    expect(fn).toMatch(/this\.lastAliveAt > 0 &&/);
  });

  it('the skip is announced, so a slow ticket can still be explained', () => {
    const fn = code.slice(code.indexOf('private async warmUpIfStale'), code.indexOf('private ensureInitialized'));
    expect(fn).toMatch(/Warm-up skipped/);
  });
});

describe('nothing about failure handling changed', () => {
  it('warm-up is still advisory in createTicket', () => {
    // The existing ruling: "a probe that cannot answer must not stop a ticket
    // that would otherwise be filed."
    expect(code).toMatch(/if \(!\(await this\.warmUpIfStale\(2, 500\)\)\) \{/);
    expect(src).toMatch(/Warm-up is ADVISORY, not a gate/);
    expect(code).toMatch(/sending anyway/);
  });

  it('the probe keeps its own 3s bound', () => {
    // Unbounded here once stopped tickets being created at all (2026-08-12,
    // file_surgery_ticket producing no timeline event on three live calls).
    expect(code).toMatch(/probe\.abort\(\), 3000/);
  });

  it('the POST keeps its own timeout', () => {
    expect(code).toMatch(/timeoutMs: number = 15000/);
  });
});
