import { describe, expect, it, vi } from 'vitest';

vi.mock('./schedulingWorkflowManager', () => ({ workflowManager: {} }));
vi.mock('playwright', () => ({ chromium: {} }));

import { PhreesiaComputerUseAgent } from './computerUseAgent';

describe('Phreesia location selection with historical option labels', () => {
  it.each([
    ['Mission Hills', 'North Valley Eye'],
    ['Covina', 'Magan'],
    ['North Valley Eye', 'Mission Hills'],
  ])('selects preferred %s when the form calls it %s', async (preferred, formLabel) => {
    const selectOption = vi.fn();
    const page = {
      waitForSelector: vi.fn(),
      $: vi.fn(async () => ({ click: vi.fn() })),
      $$eval: vi.fn(async () => [
        { value: 'other', text: 'Unrelated Office' },
        { value: 'preferred', text: formLabel },
      ]),
      selectOption,
      waitForTimeout: vi.fn(),
      waitForLoadState: vi.fn(),
    };
    const agent = new PhreesiaComputerUseAgent('synthetic-workflow', 'returning', preferred);
    const seam = agent as unknown as { _page: typeof page; selectLocation: (label: string) => Promise<void> };
    seam._page = page;
    await seam.selectLocation(preferred);
    expect(selectOption).toHaveBeenCalledWith('select', 'preferred');
    expect(selectOption).not.toHaveBeenCalledWith('select', 'other');
  });

  it('also matches a historical label in a custom combobox', async () => {
    const preferredClick = vi.fn();
    const otherClick = vi.fn();
    const page = {
      waitForSelector: vi.fn(),
      $: vi.fn(async (selector: string) => selector.startsWith('select') ? null : { click: vi.fn() }),
      $$: vi.fn(async () => [
        { textContent: async () => 'Unrelated Office', click: otherClick },
        { textContent: async () => 'North Valley Eye', click: preferredClick },
      ]),
      waitForTimeout: vi.fn(),
      waitForLoadState: vi.fn(),
    };
    const agent = new PhreesiaComputerUseAgent('synthetic-workflow');
    const seam = agent as unknown as { _page: typeof page; selectLocation: (label: string) => Promise<void> };
    seam._page = page;
    await seam.selectLocation('Mission Hills');
    expect(preferredClick).toHaveBeenCalledOnce();
    expect(otherClick).not.toHaveBeenCalled();
  });
});
