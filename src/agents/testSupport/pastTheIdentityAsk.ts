/**
 * v244: an after-hours escalation the gate refuses as administrative or as an
 * unstated provider, with no usable patient name or date of birth, first ASKS
 * for them and files nothing (`decideRefusedEscalationIdentityAsk`). The next
 * call outside the two-second batch window files, whatever it carries.
 *
 * Suites that are about what the refusal FILES (its routing, its notes, the
 * record it carries, the ticket beside it) call again past the window, as the
 * model does once the caller has answered or declined. Only the refused
 * escalation's ask is passed: its answer carries `refused`, while the identity
 * ask before a sanctioned transfer (VA-76222) carries none and is returned
 * untouched, so a suite that tests that ask still sees it.
 *
 * Test support only. Nothing in production imports it.
 */
import { vi } from 'vitest';
import { ASK_BATCH_WINDOW_MS } from '../../services/onCallIdentityBeforeTransfer';

export async function pastTheIdentityAsk<T>(invoke: () => Promise<T>): Promise<T> {
  const first = (await invoke()) as Record<string, unknown>;
  if (first?.need_identity !== true || typeof first?.refused !== 'string') return first as T;
  const realNow = Date.now.bind(Date);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ASK_BATCH_WINDOW_MS + 1);
  try {
    return await invoke();
  } finally {
    clock.mockRestore();
  }
}
