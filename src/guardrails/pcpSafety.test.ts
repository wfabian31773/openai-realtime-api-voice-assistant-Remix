import { describe, expect, it } from 'vitest';
import { pcpSafetyGuardrails } from './pcpSafety';

async function trips(text: string): Promise<boolean> {
  for (const guardrail of pcpSafetyGuardrails) {
    const result = await guardrail.execute({ agentOutput: text } as never);
    if (result.tripwireTriggered) return true;
  }
  return false;
}

describe('PCP safety guardrails', () => {
  it('blocks non-ophthalmic diagnosis claims', async () => {
    await expect(trips('This is probably diabetes.')).resolves.toBe(true);
  });

  it('blocks general medication dosing instructions', async () => {
    await expect(trips('You should take 20 mg of metformin daily.')).resolves.toBe(true);
  });

  it('allows administrative acknowledgements', async () => {
    await expect(trips('I will document the request for clinical staff to review.')).resolves.toBe(false);
  });
});
