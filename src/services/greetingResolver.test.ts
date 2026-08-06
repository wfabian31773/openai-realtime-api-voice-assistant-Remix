import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/storage', () => ({
  storage: {
    getAgentBySlug: vi.fn(),
  },
}));

import { storage } from '../../server/storage';
import { resolveConfiguredGreeting, clearGreetingCache } from './greetingResolver';

const getAgentBySlug = storage.getAgentBySlug as ReturnType<typeof vi.fn>;

describe('resolveConfiguredGreeting', () => {
  beforeEach(() => {
    clearGreetingCache();
    getAgentBySlug.mockReset();
  });

  it('returns the database welcome_greeting when configured', async () => {
    getAgentBySlug.mockResolvedValue({ welcomeGreeting: 'Thank you for calling Azul Vision.' });
    await expect(resolveConfiguredGreeting('azul-scheduling')).resolves.toBe(
      'Thank you for calling Azul Vision.',
    );
    expect(getAgentBySlug).toHaveBeenCalledWith('azul-scheduling');
  });

  it('returns null when the agent has no greeting configured (blank or missing)', async () => {
    getAgentBySlug.mockResolvedValue({ welcomeGreeting: '   ' });
    await expect(resolveConfiguredGreeting('pcp')).resolves.toBeNull();
    getAgentBySlug.mockResolvedValue(undefined);
    clearGreetingCache();
    await expect(resolveConfiguredGreeting('pcp')).resolves.toBeNull();
  });

  it('serves repeat lookups from cache within the TTL', async () => {
    getAgentBySlug.mockResolvedValue({ welcomeGreeting: 'Hello.' });
    await resolveConfiguredGreeting('no-ivr');
    await resolveConfiguredGreeting('no-ivr');
    expect(getAgentBySlug).toHaveBeenCalledTimes(1);
  });

  it('returns null instead of throwing when the lookup fails', async () => {
    getAgentBySlug.mockRejectedValue(new Error('db down'));
    await expect(resolveConfiguredGreeting('answering-service')).resolves.toBeNull();
  });

  it('returns null for a missing slug without touching the database', async () => {
    await expect(resolveConfiguredGreeting(undefined)).resolves.toBeNull();
    expect(getAgentBySlug).not.toHaveBeenCalled();
  });
});
