/**
 * WHICH REFUSALS ARE FINAL, AND WHY THE LIST IS ENUMERATED.
 *
 * "Any 4xx except 408 and 429" was my generalisation and it was wrong in a way
 * that only shows up during maintenance: it swept in **401 and 403**, which
 * are not payload refusals at all. The credential is wrong; the identical
 * bytes succeed the moment it is right.
 *
 * Rotating the ticketing API key is an OPEN task on this project (#40, the
 * operator's own note of 2026-08-13). Under the sweep, rotating it would have
 * made `createTicketDurable` decline to persist every new request and the
 * outbox dead-letter every held one — the precise loss the outbox exists to
 * prevent, caused by routine maintenance.
 *
 * The asymmetry that decides the list: retrying a hopeless request costs
 * twelve attempts and a dead letter. Dead-lettering a recoverable one costs a
 * patient their request until somebody replays it by hand.
 */
import { describe, it, expect } from 'vitest';
import { isTerminalRefusal } from './terminalRefusal';

describe('a payload the server read and refused', () => {
  it('treats 400 as final — all 664 measured refusals were 400s', () => {
    expect(isTerminalRefusal(400)).toBe(true);
  });

  it('treats 422 as final, the other validation status the API can answer', () => {
    expect(isTerminalRefusal(422)).toBe(true);
  });
});

describe('everything else is held and retried', () => {
  it.each([401, 403])('retries %i — that is the credential, not the payload', (status) => {
    // The key-rotation case. This is the assertion that would have failed
    // before, and the one that matters most, because #40 is still open.
    expect(isTerminalRefusal(status)).toBe(false);
  });

  it.each([408, 429])('retries %i — the server is saying "not now"', (status) => {
    expect(isTerminalRefusal(status)).toBe(false);
  });

  it.each([404, 409, 500, 502, 503])('retries %i', (status) => {
    expect(isTerminalRefusal(status)).toBe(false);
  });

  it('retries when there is no status at all — the 08-31 shape', () => {
    // HTTP 200 with a body that is not JSON: nothing is known about whether
    // the far side ever read the payload, so it must be kept.
    expect(isTerminalRefusal(undefined)).toBe(false);
    expect(isTerminalRefusal(200)).toBe(false);
  });

  it('is enumerated, not a range — a new 4xx defaults to retryable', () => {
    // The safe default for a status nobody has considered yet is to KEEP the
    // request, not to throw it away.
    for (const status of [402, 405, 410, 415, 418, 423, 451]) {
      expect(isTerminalRefusal(status)).toBe(false);
    }
  });
});
