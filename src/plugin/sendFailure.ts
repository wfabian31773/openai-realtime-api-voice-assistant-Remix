/**
 * Whether a failed send may already have gone out. `unknown` is only for
 * that case — a token fetch, a Graph 4xx, or a Twilio 4xx before accept
 * never left the building, so those stay `failed`.
 */
export class SendOutcomeError extends Error {
  readonly reason: string;
  readonly mayHaveSent: boolean;

  constructor(reason: string, mayHaveSent: boolean) {
    super(reason);
    this.name = "SendOutcomeError";
    this.reason = reason;
    this.mayHaveSent = mayHaveSent;
  }
}

export type SendFailure = { ok: false; reason: string; mayHaveSent: boolean };

export function sendFailure(reason: string, mayHaveSent: boolean): SendFailure {
  return { ok: false, reason, mayHaveSent };
}

export function failureFromUnknown(err: unknown): SendFailure {
  if (err instanceof SendOutcomeError) {
    return sendFailure(err.reason, err.mayHaveSent);
  }
  if (err instanceof Error && err.name === "AbortError") {
    return sendFailure("timeout", true);
  }
  const status = httpStatusOf(err);
  if (status !== null && status >= 400 && status < 500) {
    return sendFailure("rejected", false);
  }
  return sendFailure("error", true);
}

function httpStatusOf(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const rec = err as { status?: unknown; statusCode?: unknown };
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return null;
}

export function isKnownNotSent(err: unknown): boolean {
  return !failureFromUnknown(err).mayHaveSent;
}
