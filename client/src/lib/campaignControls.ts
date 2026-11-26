/**
 * Which buttons a campaign card shows (v277).
 *
 * A RUNTIME outbound campaign (NPX outreach and the rest) is dialled by the
 * voice runtime, which reads the campaign's status every minute. So it gets
 * Pause and Resume, which the runtime obeys, and never the old scheduler's
 * Start dialog (it asks for a from number the runtime does not use) or the
 * delete button (its contacts, attempts and opt-outs are the record of who
 * was called; the server refuses it too, server/runtimeCampaignControls.ts).
 * Every other campaign keeps the buttons it had.
 */

export const RUNTIME_OUTBOUND_CAMPAIGN_TYPE = 'runtime_outbound'

export interface CampaignButtons {
  add: boolean
  start: boolean
  stop: boolean
  pause: boolean
  resume: boolean
  delete: boolean
  /** One line under the buttons saying what the buttons do, or null. */
  note: string | null
}

export const RUNTIME_CAMPAIGN_NOTE =
  'Dialled by the voice runtime. Pause stops new calls and texts from its next minute; calls back are ' +
  'still answered and booking confirmations still go out. It dials only while its environment switch is on.'

export function campaignButtons(campaign: {
  campaignType: string
  status: string
  totalContacts: number
}): CampaignButtons {
  const running = campaign.status === 'running'
  if (campaign.campaignType === RUNTIME_OUTBOUND_CAMPAIGN_TYPE) {
    return {
      add: !running,
      start: false,
      stop: false,
      pause: running,
      resume: !running,
      delete: false,
      note: RUNTIME_CAMPAIGN_NOTE,
    }
  }
  return {
    add: !running,
    start: !running && campaign.totalContacts > 0,
    stop: running,
    pause: false,
    resume: false,
    delete: !running,
    note: null,
  }
}
