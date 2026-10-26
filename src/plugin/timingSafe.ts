import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time compare for secrets. Length is checked first because
 * timingSafeEqual throws on a length mismatch — a throw is itself a timing
 * signal, so a misshaped value is rejected without calling it.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Compare two hex digests. Rejects empty or odd-length input. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length === 0 || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Compare a provided webhook/API key to the configured secret.
 * Missing config and a missing header are both a miss — never a throw.
 */
export function timingSafeEqualSecret(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== "string" || !expected) return false;
  return timingSafeEqualString(provided, expected);
}
