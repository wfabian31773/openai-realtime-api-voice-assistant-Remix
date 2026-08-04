import { describe, expect, it } from 'vitest';
import { formatOrgBillingError } from './orgBillingError';

describe('formatOrgBillingError', () => {
  it('reports the deepest PostgreSQL cause and metadata', () => {
    const postgresError = Object.assign(
      new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'),
      { code: '42P10' }
    );
    const drizzleError = new Error('Failed query: insert into daily_reconciliation') as Error & {
      cause?: unknown;
    };
    drizzleError.cause = postgresError;

    expect(formatOrgBillingError(drizzleError)).toBe(
      'there is no unique or exclusion constraint matching the ON CONFLICT specification (code=42P10)'
    );
  });

  it('handles non-Error values', () => {
    expect(formatOrgBillingError('billing failed')).toBe('billing failed');
  });

  it('does not loop forever on a circular cause chain', () => {
    const error = new Error('circular') as Error & { cause?: unknown };
    error.cause = error;

    expect(formatOrgBillingError(error)).toBe('circular');
  });
});
