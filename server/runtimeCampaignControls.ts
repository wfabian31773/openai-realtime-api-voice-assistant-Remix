/**
 * server/runtimeCampaignControls.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What the Campaigns screen's buttons do to a RUNTIME outbound campaign
 * (`campaign_type = 'runtime_outbound'`, e.g. NPX outreach), v277.
 *
 * THE BEFORE, read from the code on 2026-11-26. Every one of these routes was
 * written for the old core's executor and scheduler, and the runtime dialler
 * (src/runtime/outbound/dialer.ts) never read the campaign row's status:
 *
 *   - Stop (the screen's button) and Pause wrote `paused`, said "The campaign
 *     has stopped making calls", and the dialler kept ringing.
 *   - Cancel wrote `cancelled`, and the dialler kept ringing.
 *   - Resume wrote `running`, then asked the executor to run the campaign;
 *     the executor refuses a runtime campaign by throwing, and its catch
 *     marked the campaign `cancelled`. Start (`/start`) did the same.
 *   - Delete soft-deleted the row once it was not `running` (the screen tells
 *     you to pause or cancel first). The runtime looks a campaign up by name
 *     with `deleted_at IS NULL`, so its next tick created a FRESH campaign:
 *     no attempts, so the caps counted from zero, and the source refresh
 *     queued every person on the movable list again. The old row kept every
 *     outcome, booking and held cancel, which the runtime then never read.
 *
 * THE AFTER. The dialler and the outreach-text tick place new outreach only
 * while the row reads `running` and is not deleted (campaignHoldReason). So:
 *
 *   - Pause, Stop and Cancel stop new calls and outreach texts from the next
 *     minute's tick. A call already ringing finishes; a person who rings the
 *     caller ID back is still answered; booking confirmations and held Azul
 *     cancels owed to people who booked still go out.
 *   - Resume lets it dial again, without the executor.
 *   - Start (either start route) is refused: the runtime, not this server,
 *     dials it. Resume is the button.
 *   - Delete is refused. The contacts, attempts and opt-outs are the record of
 *     who was called and what was agreed. (And the runtime now answers a
 *     deleted row rather than creating a second one, src/runtime/outbound/
 *     store.ts ensureCampaign, so even a delete made in SQL stops the
 *     campaign instead of restarting it.)
 *   - An edit (PATCH) may change the description, and the status to running,
 *     paused or cancelled; never the name, type or agent the runtime finds
 *     the row by, and never the deleted mark.
 *
 * Whether Pause should be a button on this screen at all is the operator's
 * call; this makes the button do what it says. The environment switch
 * (OUTBOUND_CAMPAIGN_<KEY>) stays the master switch: a running campaign whose
 * switch is off dials nobody.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const RUNTIME_OUTBOUND_CAMPAIGN_TYPE = "runtime_outbound";

export type RuntimeCampaignAction = "pause" | "stop" | "cancel" | "resume" | "start" | "delete";

/** The fields of a campaigns row this module reads. */
export interface RuntimeCampaignRow {
  id: string;
  name?: string | null;
  campaignType?: string | null;
  status?: string | null;
  deletedAt?: Date | string | null;
}

export interface RuntimeCampaignDeps {
  /** storage.updateCampaign. */
  update(id: string, updates: Record<string, unknown>): Promise<unknown>;
}

export interface RouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

export function isRuntimeCampaign(campaign: RuntimeCampaignRow | null | undefined): boolean {
  return campaign?.campaignType === RUNTIME_OUTBOUND_CAMPAIGN_TYPE;
}

export const RUNTIME_PAUSED_MESSAGE =
  "Paused. The voice runtime places no new calls or outreach texts for this campaign from its next " +
  "minute's tick. A call already ringing finishes, people who call back are still answered, and " +
  "booking confirmations and held cancels still go out. Press Resume to start it again.";

export const RUNTIME_CANCELLED_MESSAGE =
  "Cancelled. As with Pause, the voice runtime places no new calls or outreach texts for this " +
  "campaign from its next minute's tick; people who call back are still answered, and booking " +
  "confirmations and held cancels still go out. Press Resume to start it again.";

export const RUNTIME_RESUMED_MESSAGE =
  "Resumed. The voice runtime dials this campaign again from its next minute's tick, inside its " +
  "calling hours and only while the campaign's environment switch is on.";

export const RUNTIME_START_REFUSAL =
  "This is a runtime outbound campaign: the voice runtime dials it, from its own number, under its " +
  "own hours and caps. It is not started here. Use Resume to let it dial and Pause to stop it.";

export const RUNTIME_DELETE_REFUSAL =
  "A runtime outbound campaign cannot be deleted. Its contacts, call attempts and opt-outs are the " +
  "record of who was called and what was agreed. Use Pause to stop it.";

export const RUNTIME_DELETED_REFUSAL =
  "This campaign was deleted, so the voice runtime does not dial it. Restoring it is a database change.";

/** The statuses an edit may write on a runtime campaign. */
export const RUNTIME_EDITABLE_STATUSES = ["running", "paused", "cancelled"] as const;

/** The fields an edit may change on a runtime campaign. */
const RUNTIME_EDITABLE_FIELDS = new Set(["description", "status"]);

function isDeleted(campaign: RuntimeCampaignRow): boolean {
  return campaign.deletedAt !== null && campaign.deletedAt !== undefined;
}

/**
 * The route's answer for a runtime campaign, having written what it says; or
 * null when the campaign is not a runtime one (the route goes on as before).
 */
export async function runtimeCampaignControl(
  action: RuntimeCampaignAction,
  campaign: RuntimeCampaignRow | null | undefined,
  deps: RuntimeCampaignDeps,
  now: () => Date = () => new Date(),
): Promise<RouteAnswer | null> {
  if (!campaign || !isRuntimeCampaign(campaign)) return null;
  const campaignId = campaign.id;
  if (action === "delete") {
    return { status: 409, body: { success: false, message: RUNTIME_DELETE_REFUSAL, campaignId } };
  }
  if (action === "start") {
    return { status: 409, body: { success: false, message: RUNTIME_START_REFUSAL, campaignId } };
  }
  if (isDeleted(campaign)) {
    return { status: 409, body: { success: false, message: RUNTIME_DELETED_REFUSAL, campaignId } };
  }
  if (action === "pause" || action === "stop") {
    await deps.update(campaignId, { status: "paused" });
    console.info(`[CAMPAIGNS] runtime campaign ${campaign.name ?? campaignId} paused on the Campaigns screen`);
    return { status: 200, body: { success: true, message: RUNTIME_PAUSED_MESSAGE, campaignId, status: "paused" } };
  }
  if (action === "cancel") {
    await deps.update(campaignId, { status: "cancelled", actualEndTime: now() });
    console.info(`[CAMPAIGNS] runtime campaign ${campaign.name ?? campaignId} cancelled on the Campaigns screen`);
    return { status: 200, body: { success: true, message: RUNTIME_CANCELLED_MESSAGE, campaignId, status: "cancelled" } };
  }
  // resume
  await deps.update(campaignId, { status: "running", actualEndTime: null });
  console.info(`[CAMPAIGNS] runtime campaign ${campaign.name ?? campaignId} resumed on the Campaigns screen`);
  return { status: 200, body: { success: true, message: RUNTIME_RESUMED_MESSAGE, campaignId, status: "running" } };
}

/**
 * Why an edit (PATCH) may not be applied to this runtime campaign, or null
 * when it may (or the campaign is not a runtime one). The name, type and
 * agent are how the runtime finds the row (store.ensureCampaign); changing
 * one would make it create a second campaign and call everyone again.
 */
export function runtimeCampaignEditRefusal(
  campaign: RuntimeCampaignRow | null | undefined,
  updates: unknown,
): string | null {
  if (!campaign || !isRuntimeCampaign(campaign)) return null;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return "A runtime outbound campaign takes only a description or a status (running, paused or cancelled).";
  }
  const fields = Object.keys(updates as Record<string, unknown>);
  const refused = fields.filter((f) => !RUNTIME_EDITABLE_FIELDS.has(f));
  if (refused.length > 0) {
    return (
      `A runtime outbound campaign's ${refused.join(", ")} cannot be changed here: the voice runtime ` +
      "finds the campaign by its name, type and agent, and its record must stay whole. Only the " +
      "description and the status (running, paused or cancelled) can be."
    );
  }
  if ("status" in (updates as Record<string, unknown>)) {
    const status = (updates as Record<string, unknown>).status;
    if (!(RUNTIME_EDITABLE_STATUSES as readonly unknown[]).includes(status)) {
      return "A runtime outbound campaign's status can be running, paused or cancelled.";
    }
    if (isDeleted(campaign)) return RUNTIME_DELETED_REFUSAL;
  }
  return null;
}
