import { describe, expect, it } from 'vitest';
import { validateEmail } from './contactValidation';

describe('email validation preserves the full caller-supplied address', () => {
  it('keeps the complete 254-character address and its casing', () => {
    const email = `${'A'.repeat(64)}@${'B'.repeat(63)}.${'C'.repeat(63)}.${'D'.repeat(61)}`;
    const result = validateEmail(email);

    expect(email).toHaveLength(254);
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBe(email);
  });

  it('rejects an overlong address instead of truncating it into another address', () => {
    const email = `${'A'.repeat(64)}@${'B'.repeat(63)}.${'C'.repeat(63)}.${'D'.repeat(62)}`;
    const result = validateEmail(email);

    expect(email).toHaveLength(255);
    expect(result.valid).toBe(false);
    expect(result.sanitized).toBeUndefined();
  });
});
