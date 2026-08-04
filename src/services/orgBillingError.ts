interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
  message?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null;
}

function describeError(value: unknown): string {
  if (!isErrorLike(value)) {
    return String(value);
  }

  const message = typeof value.message === 'string' ? value.message : String(value);
  const metadata = [
    typeof value.code === 'string' ? `code=${value.code}` : null,
    typeof value.constraint === 'string' ? `constraint=${value.constraint}` : null,
    typeof value.detail === 'string' ? `detail=${value.detail}` : null,
  ].filter((item): item is string => item !== null);

  return metadata.length > 0 ? `${message} (${metadata.join(', ')})` : message;
}

/**
 * Drizzle wraps PostgreSQL errors and puts the actionable database exception
 * in `cause`. Return the deepest cause so production logs show the real error
 * instead of only the generated SQL statement.
 */
export function formatOrgBillingError(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 8 && isErrorLike(current) && current.cause; depth++) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    current = current.cause;
  }

  return describeError(current);
}
