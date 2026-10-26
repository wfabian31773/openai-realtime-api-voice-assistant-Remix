/**
 * Cancelling the Azul appointment an NPX outreach booking replaces (v110).
 *
 * Step 3 of the outreach call in NPX's contract: once NPX has booked the
 * sooner exam, the Azul appointment is cancelled in NextGen through the Eye
 * Care scheduling service (`cancel_appointment`), and the result is reported
 * back to NPX. A booking with no `cancelled` report reaches CEC's backup list
 * after 15 minutes, so every refusal here is SAFE: the worst a refusal costs
 * is a staffer cancelling by hand.
 *
 * The opposite mistake is the one this guards against — cancelling somebody
 * else's appointment. `cancel_appointment` checks nothing about whose
 * appointment it is, so before it runs the appointment is read back and must
 * still belong to the person the call was about, on the date the call
 * offered to move, and not be a schedule block.
 *
 * NOT the voice agent's pilot client (`callEyecareTool`): that one sends
 * X-Pilot-Fence, which hides every record outside the San Diego pilot
 * offices, and X-Zero-Id, which strips appointment ids. This call names the
 * appointment the Console handed us and must see it wherever it is.
 *
 * Every failure is a short code NPX accepts as a cancel-report reason.
 */

const DEFAULT_EYECARE_BASE_URL = 'https://eyecare-scheduling-agent-wayne-fabians-projects.vercel.app';
/** What the scheduling service is told it may spend (X-Deadline-Ms), and a
 * little more on this side so its own fast-fail reply can arrive. */
export const AZUL_CANCEL_DEADLINE_MS = 10_000;
const CLIENT_TIMEOUT_MS = AZUL_CANCEL_DEADLINE_MS + 2_000;
/** A step is not started with less than this left before the caller's
 * deadline: the scheduling service needs a second, and its reply must arrive. */
export const AZUL_CANCEL_MIN_STEP_MS = 3_000;

export interface AzulCancelRequest {
  /** The NextGen appointment id (the Console's `appointment_id`). */
  appointmentId: string;
  /** The NextGen PersonID the call was about (the Console's `person_id`). */
  personId: string;
  /** YYYY-MM-DD — the date the call offered to move. */
  appointmentDate: string;
  /** Recorded on the NextGen cancellation. No patient details. */
  comment: string;
  /**
   * Epoch ms by which the whole cancel must have answered. Each step's wait
   * is cut to what is left, and no step starts once too little is: the
   * outreach call books first and must still answer the caller inside its
   * own budget (Codex P1, #361). Running out is `nextgen_timeout`, which is
   * safe — NPX's backup list shows CEC a booking with no cancel. A step cut
   * short on this side may still land in NextGen; that, too, CEC sees.
   */
  deadlineAt?: number;
}

export type AzulCancelResult =
  | { cancelled: true; alreadyCancelled: boolean }
  | { cancelled: false; reason: AzulCancelRefusal };

export type AzulCancelRefusal =
  | 'scheduling_not_configured'
  | 'cancel_reason_not_configured'
  | 'cancel_reason_not_found'
  | 'appointment_not_found'
  | 'person_mismatch'
  | 'appointment_moved'
  | 'schedule_block'
  | 'nextgen_timeout'
  | 'nextgen_cancel_failed';

type Fetch = typeof fetch;

async function tool(
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  fetchImpl: Fetch,
  deadlineAt?: number,
): Promise<Record<string, unknown> | 'timeout' | 'failed'> {
  const base = (env.EYECARE_SCHEDULING_BASE_URL?.trim() || DEFAULT_EYECARE_BASE_URL).replace(/\/+$/, '');
  const waitMs = deadlineAt === undefined ? CLIENT_TIMEOUT_MS : Math.min(CLIENT_TIMEOUT_MS, deadlineAt - Date.now());
  const serverDeadlineMs = Math.max(1_000, Math.min(AZUL_CANCEL_DEADLINE_MS, waitMs - 2_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, waitMs));
  try {
    const r = await fetchImpl(`${base}/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.EYECARE_AGENT_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Deadline-Ms': String(serverDeadlineMs),
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      console.warn(`[OUTREACH CANCEL] ${name} answered HTTP ${r.status}`);
      return r.status === 504 ? 'timeout' : 'failed';
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // The endpoint answers { tool, result }, or { tool, ...fields } where the
    // handler sets its own envelope (api/tools/[name].ts).
    const inner = parsed && typeof parsed.result === 'object' && parsed.result !== null ? parsed.result : parsed;
    return inner as Record<string, unknown>;
  } catch {
    return controller.signal.aborted ? 'timeout' : 'failed';
  } finally {
    clearTimeout(timer);
  }
}

export async function cancelAzulAppointment(
  req: AzulCancelRequest,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: Fetch = fetch,
): Promise<AzulCancelResult> {
  const refuse = (reason: AzulCancelRefusal): AzulCancelResult => {
    console.warn(`[OUTREACH CANCEL] not cancelled: ${reason} — NPX's backup list will show it to CEC`);
    return { cancelled: false, reason };
  };
  if (!env.EYECARE_AGENT_API_KEY) return refuse('scheduling_not_configured');
  const reasonName = env.OUTREACH_CANCEL_REASON?.trim();
  if (!reasonName) return refuse('cancel_reason_not_configured');
  const outOfTime = (): boolean =>
    req.deadlineAt !== undefined && req.deadlineAt - Date.now() < AZUL_CANCEL_MIN_STEP_MS;

  // 1. Whose appointment is it, and is it still the one we offered to move?
  if (outOfTime()) return refuse('nextgen_timeout');
  const details = await tool('get_appointment_details', { appointmentId: req.appointmentId }, env, fetchImpl, req.deadlineAt);
  if (details === 'timeout') return refuse('nextgen_timeout');
  if (details === 'failed' || details.notFound === true || typeof details.personId !== 'string') {
    return refuse('appointment_not_found');
  }
  if (details.isPseudoPatient === true) return refuse('schedule_block');
  if (details.personId.toLowerCase() !== req.personId.toLowerCase()) return refuse('person_mismatch');
  if (details.isCancelled === true) return { cancelled: true, alreadyCancelled: true };
  if (String(details.appointmentDate ?? '').slice(0, 10) !== req.appointmentDate) return refuse('appointment_moved');

  // 2. The configured NextGen reason, matched by its whole name.
  if (outOfTime()) return refuse('nextgen_timeout');
  const list = await tool('list_cancel_reasons', {}, env, fetchImpl, req.deadlineAt);
  if (list === 'timeout') return refuse('nextgen_timeout');
  const reasons = list === 'failed' || !Array.isArray(list.reasons) ? [] : (list.reasons as Array<{ id?: unknown; name?: unknown }>);
  const reason = reasons.find((r) => String(r.name ?? '').trim().toLowerCase() === reasonName.toLowerCase());
  if (!reason || typeof reason.id !== 'string') return refuse('cancel_reason_not_found');

  // 3. Cancel.
  if (outOfTime()) return refuse('nextgen_timeout');
  const res = await tool(
    'cancel_appointment',
    { appointmentId: req.appointmentId, cancelReasonId: reason.id, comment: req.comment },
    env,
    fetchImpl,
    req.deadlineAt,
  );
  if (res === 'timeout') return refuse('nextgen_timeout');
  if (res === 'failed') return refuse('nextgen_cancel_failed');
  if (res.cancelled === true) return { cancelled: true, alreadyCancelled: false };
  if (res.alreadyCancelled === true) return { cancelled: true, alreadyCancelled: true };
  return refuse('nextgen_cancel_failed');
}
