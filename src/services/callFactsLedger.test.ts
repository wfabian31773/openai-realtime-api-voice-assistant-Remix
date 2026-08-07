import { describe, it, expect, beforeEach } from 'vitest';
import { seedLedger, updateLedger, renderKnownFacts, releaseLedger, clearAllLedgers, getLedger, harvestCallerLine } from './callFactsLedger';

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

describe('harvestCallerLine — gathering independent of the driver', () => {
  beforeEach(() => clearAllLedgers());

  it('harvests DOB, requested day, and fax intent from natural speech', () => {
    seedLedger('h', {});
    harvestCallerLine('h', 'Sure, it is March 17th, 1973');
    harvestCallerLine('h', 'do you have any Tuesday afternoons open?');
    harvestCallerLine('h', 'please fax it to 760-555-1234');
    const f = getLedger('h')! as any;
    expect(f.dateOfBirth).toContain('March 17');
    expect(f.requestedDay).toBe('tuesday');
    expect(f.contactMethod).toBe('fax');
    expect(f.faxNumber).toContain('555');
  });

  it('never overwrites a filled slot', () => {
    seedLedger('h', { dateOfBirth: '01/01/1990' });
    harvestCallerLine('h', 'my birthday is 5/10/1983');
    expect(getLedger('h')!.dateOfBirth).toBe('01/01/1990');
  });
});
