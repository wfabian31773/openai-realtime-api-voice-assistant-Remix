/**
 * The demo line took three live calls as the after-hours agent (2026-08-09)
 * because two independent allowlists and one env var all had to agree before
 * it could be itself. This pins the one that lives in code: the demo line is
 * a ticket-agent line with no secret set.
 */
import { describe, it, expect } from 'vitest';
import { newCoreEnabled, newCoreFor } from './router';

describe('router — demo line', () => {
  it('is a ticket-agent line without TICKET_AGENT_LINES naming it', () => {
    expect(process.env.TICKET_AGENT_LINES ?? '').not.toContain('demo');
    expect(newCoreEnabled('demo')).toBe(true);
  });

  it('resolves to a module, so the caller never hears the old core', () => {
    const mod = newCoreFor('demo');
    expect(mod).not.toBeNull();
    expect(mod!.slug).toBe('demo');
  });

  it('leaves every unnamed line on the old core', () => {
    expect(newCoreEnabled('answering-service')).toBe(false);
    expect(newCoreFor('answering-service')).toBeNull();
  });
});
