import { describe, it, expect, beforeEach } from 'vitest';
import { seedLedger, updateLedger, renderKnownFacts, releaseLedger, clearAllLedgers, getLedger } from './callFactsLedger';

describe('callFactsLedger', () => {
  beforeEach(() => clearAllLedgers());

  it('seeds callback number from caller-ID at second zero', () => {
    const f = seedLedger('c1', { callerPhone: '+15629043906' });
    expect(f.callbackNumber).toBe('+15629043906');
    expect(renderKnownFacts('c1')).toContain('ending in 3906');
  });

  it('locks identity on verification — later writes cannot change it', () => {
    seedLedger('c1', {});
    updateLedger('c1', { firstName: 'Wayne', lastName: 'Fabian', identityVerified: true });
    updateLedger('c1', { firstName: 'Impostor', dateOfBirth: '01/01/1990' });
    const f = getLedger('c1')!;
    expect(f.firstName).toBe('Wayne');
    expect(f.dateOfBirth).toBeUndefined();
    expect(renderKnownFacts('c1')).toContain('IDENTITY VERIFIED');
  });

  it('fax request renders a fax instruction, not a callback ask', () => {
    seedLedger('c1', { contactMethod: 'fax' });
    const block = renderKnownFacts('c1')!;
    expect(block).toContain('FAX was requested');
    expect(block).toContain('NOT a callback number');
  });

  it('repeat-caller elevation appears at 3 calls', () => {
    seedLedger('c1', { priorCallsSameIssue: 3 });
    expect(renderKnownFacts('c1')).toContain('elevated to a senior team member');
  });

  it('release clears the ledger', () => {
    seedLedger('c1', { callerPhone: '+15550001111' });
    releaseLedger('c1');
    expect(getLedger('c1')).toBeUndefined();
    expect(renderKnownFacts('c1')).toBeNull();
  });
});
