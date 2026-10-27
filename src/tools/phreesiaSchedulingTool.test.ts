import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunContext } from '@openai/agents';

const state = vi.hoisted(() => ({
  constructors: vi.fn(),
  createWorkflow: vi.fn(async () => ({ id: 'synthetic-workflow' })),
  completeWorkflow: vi.fn(),
  fill: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('../../server/services/schedulingWorkflowManager', () => ({
  workflowManager: { createWorkflow: state.createWorkflow, completeWorkflow: state.completeWorkflow },
}));
vi.mock('../../server/services/computerUseAgent', () => ({
  PhreesiaComputerUseAgent: class {
    constructor(...args: unknown[]) { state.constructors(...args); }
    async init() {}
    fillPhreesiaForm = state.fill;
    dispose = state.dispose;
  },
}));

import { createPhreesiaSchedulingTool } from './phreesiaSchedulingTool';

const patient = {
  firstName: 'Synthetic', lastName: 'Example', dateOfBirth: '01/01/1970', gender: 'female',
  address: '1 Example Street', city: 'Example City', state: 'CA', zip: '00000',
  homePhone: '555-010-0100', mobilePhone: '555-010-0101',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('Phreesia tool current clinic names', () => {
  it.each([
    ['North Valley Eye', 'Mission Hills'],
    ['Magan', 'Covina'],
    ['Example Clinic', 'Example Clinic'],
  ])('carries %s as %s into automation, persistence, and the spoken result', async (original, current) => {
    state.fill.mockResolvedValue({
      success: true, confirmationNumber: 'SYNTHETIC',
      appointmentDetails: { date: '2099-01-01', time: '09:00', location: original, visitType: 'Synthetic visit' },
    });
    const tool = createPhreesiaSchedulingTool({ callLogId: 'synthetic-call', agentId: 'synthetic-agent' });
    const reply = await tool.invoke(new RunContext(), JSON.stringify({
      patient_type: 'returning', preferred_location: original, patient_data: patient,
    }));
    expect(state.constructors).toHaveBeenCalledWith('synthetic-workflow', 'returning', current);
    expect(reply).toContain(`Location: ${current}`);
    if (original !== current) expect(reply).not.toContain(original);
    expect(state.completeWorkflow).toHaveBeenCalledWith('synthetic-workflow', true, 'SYNTHETIC', {
      date: '2099-01-01', time: '09:00', location: current, visitType: 'Synthetic visit',
    });
    expect(state.dispose).toHaveBeenCalledOnce();
  });

  it('preserves absent appointment details', async () => {
    state.fill.mockResolvedValue({ success: true, confirmationNumber: 'SYNTHETIC' });
    const tool = createPhreesiaSchedulingTool({ callLogId: 'synthetic-call', agentId: 'synthetic-agent' });
    await tool.invoke(new RunContext(), JSON.stringify({ patient_type: 'returning', patient_data: patient }));
    expect(state.completeWorkflow).toHaveBeenCalledWith('synthetic-workflow', true, 'SYNTHETIC', undefined);
  });
});
