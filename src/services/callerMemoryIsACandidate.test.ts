/**
 * CALLER MEMORY IS A CANDIDATE, NOT AN IDENTITY.
 *
 * The CALLER HISTORY section of the after-hours prompt is built from the
 * previous calls on the CALLING NUMBER. Until 2026-09-30 it carried the
 * previous call's full name and date of birth (`KNOWN PATIENT: <name>
 * (DOB: …)`), the last provider and office seen, each call's summary, and the
 * guidance "Don't re-ask for information you already have (name, DOB)".
 *
 * `CA32108e28bc5b21ca1514a126303d0671` (after-hours, 2026-09-30 13:31 UTC):
 * the v47 redaction withheld the appointment behind a name-and-date lookup,
 * and this section handed the model the surname and the date to make that
 * lookup by itself. The caller affirmed a first name and spoke a date of
 * birth; the surname never came from their mouth; the appointment was read;
 * the full name was asked afterwards. RULE ZERO step 2 and standing
 * instruction 6: a match on the calling number is a candidate to confirm,
 * never an identity — and memory keyed on that number is the same thing.
 *
 * Synthetic caller, synthetic doctor, synthetic office — RULE THREE. Every
 * string in RECORD_FACTS is one that appears nowhere else in the renderer.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
vi.mock('../../server/storage', () => ({ storage: { getCallHistoryByPhone: async () => [] } }));

const { callerMemoryService } = await import('./callerMemoryService');

const MEMORY = {
  phoneNumber: '+15550001111',
  totalCalls: 5,
  lastCallDate: 'Yesterday',
  patientName: 'Zelda Quixote',
  patientDob: '01/04/1958',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
  lastLocationSeen: 'Quixotic Vision Testville',
  preferredContactMethod: 'text',
  recentCalls: [
    { date: 'Yesterday', reason: 'Asked about a latanoprost refill after the retina visit', outcome: 'Ticket created: VA-TEST-1', ticketNumber: 'VA-TEST-1' },
    { date: '3 days ago', reason: 'Post-op pain after cataract surgery', outcome: 'Transferred to staff' },
    { date: 'Sep 2, 2026', reason: 'General inquiry', outcome: 'Resolved by agent' },
  ],
  openTickets: ['VA-TEST-1'],
  notes: 'Transferred to staff 1 time(s) in recent calls. 2 ticket(s) created in recent calls',
};

/** Facts about a PERSON or their RECORD — none of them may reach the prompt. */
const RECORD_FACTS = ['Zelda', 'Quixote', '01/04/1958', '1958', 'Zebrastripe', 'Testville', 'latanoprost', 'retina', 'cataract', 'Post-op'];

describe('the caller-history section discloses nothing from anyone\'s record', () => {
  const section = callerMemoryService.buildContextForPrompt(MEMORY as any);

  it("a previous call's name, date of birth, doctor, office and summaries never reach the prompt", () => {
    for (const fact of RECORD_FACTS) {
      expect(section, `the section carries "${fact}"`).not.toContain(fact);
    }
    expect(section).not.toContain('KNOWN PATIENT');
    expect(section).not.toContain('LAST PROVIDER SEEN');
    expect(section).not.toContain('LAST LOCATION SEEN');
  });

  it('what is true of the NUMBER still reaches it: count, outcomes, open tickets, preference, notes', () => {
    expect(section).toContain('CALLER HISTORY (5 previous calls from this NUMBER)');
    expect(section).toContain('- Yesterday: Ticket created: VA-TEST-1');
    expect(section).toContain('- 3 days ago: Transferred to staff');
    expect(section).toContain('OPEN TICKETS: VA-TEST-1');
    expect(section).toContain('PREFERRED CONTACT: text');
    expect(section).toContain('NOTES: Transferred to staff 1 time(s)');
  });

  it('says in as many words that the history is the number\'s, not the caller\'s', () => {
    expect(section).toMatch(/fact about the NUMBER, not the caller/);
    expect(section).toMatch(/several people share a phone/);
  });

  it('no instruction to greet by name or to skip the identity questions — the opposite, stated', () => {
    expect(section).not.toMatch(/greet by name if known/i);
    expect(section).not.toMatch(/don't re-ask/i);
    expect(section).not.toMatch(/information you already have/i);
    expect(section).toMatch(/do NOT skip the name or date-of-birth\s+questions/);
    expect(section).toMatch(/not this caller's identity/);
  });

  it('the outcome line keeps a ticket number and drops the summary', () => {
    const line = section.split('\n').find((l) => l.startsWith('- Yesterday:'));
    expect(line).toBe('- Yesterday: Ticket created: VA-TEST-1');
  });

  it('a number with no history gets no section at all', () => {
    expect(callerMemoryService.buildContextForPrompt({ ...MEMORY, totalCalls: 0 } as any)).toBe('');
    expect(callerMemoryService.buildContextForPrompt(null as any)).toBe('');
  });

  it('a single previous call reads as one call', () => {
    const one = callerMemoryService.buildContextForPrompt({ ...MEMORY, totalCalls: 1, recentCalls: MEMORY.recentCalls.slice(0, 1) } as any);
    expect(one).toContain('CALLER HISTORY (1 previous call from this NUMBER)');
    expect(one).not.toContain('Quixote');
  });
});
