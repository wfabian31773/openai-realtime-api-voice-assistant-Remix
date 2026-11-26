/**
 * What the Campaigns screen may read about a campaign's contacts.
 *
 * Before this module, `GET /api/campaigns/:id/contacts` returned the
 * `campaign_contacts` rows as stored. For the NPX outreach campaign each row
 * carries the patient's full phone number, date of birth (`patient_dob`, and
 * `custom_data.date_of_birth`), appointment, payer and the outreach text's
 * state, and the screen shows three things: the name, the phone and a status
 * (found by the screen accuracy audit of 2026-11-26, voice PR #525).
 *
 * So each response is built from an ALLOW-LIST, field by field, never by
 * copying a row and deleting what should not go: a column added to the table
 * later reaches no screen until somebody names it here.
 *
 *   - the phone goes as its last four digits, and only when the number has
 *     ten digits or more (`speakableLast4`, the v40 rule), so a short or
 *     malformed value is never sent whole;
 *   - no date of birth, no `custom_data`, no appointment, no email, no notes.
 *
 * The attempts route has no caller in the client today. It answers the same
 * way: when and how each attempt went, never its transcript summary, notes,
 * recording link or CallSid, and only attempts that belong to the campaign in
 * the URL.
 *
 * `campaignErrorForLog` exists because drizzle-orm 0.44 throws a
 * `DrizzleQueryError` whose message is the query AND every bound parameter.
 * The upload and schedule-import routes insert a batch of contacts, so a
 * failed insert logged with `console.error(error)` would have written every
 * name, phone and date of birth in the batch to the log.
 */
import type { Express, RequestHandler } from 'express';
import type { CampaignContact, CampaignContactAttempt } from '../shared/schema';
import { speakableLast4 } from '../src/utils/timeAware';

/** One contact as the Campaigns › View dialog shows it. */
export interface CampaignContactView {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** Last four digits of a ten-digit-or-longer number; null otherwise. */
  phoneLast4: string | null;
  contacted: boolean;
  successful: boolean;
}

export function toCampaignContactView(contact: CampaignContact): CampaignContactView {
  return {
    id: contact.id,
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    phoneLast4: speakableLast4(contact.phoneNumber),
    contacted: contact.contacted === true,
    successful: contact.successful === true,
  };
}

/** One call attempt, with nothing a caller said and no link to the audio. */
export interface ContactAttemptView {
  id: string;
  attemptNumber: number;
  direction: string;
  attemptedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  duration: number | null;
  status: string;
  answeredBy: string | null;
  outcome: string | null;
}

export function toContactAttemptView(attempt: CampaignContactAttempt): ContactAttemptView {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    direction: attempt.direction,
    attemptedAt: attempt.attemptedAt ?? null,
    answeredAt: attempt.answeredAt ?? null,
    endedAt: attempt.endedAt ?? null,
    duration: attempt.duration ?? null,
    status: attempt.status,
    answeredBy: attempt.answeredBy ?? null,
    outcome: attempt.outcome ?? null,
  };
}

/**
 * A failure described without its message: the error's name, and the
 * Postgres code, table, column and constraint when the database raised it.
 * A message can hold the rows being written (drizzle's `params:`), a CSV
 * field (csv-parse quotes the field it refused) or a key's value (a unique
 * violation's `detail`), so no message or detail is ever read here.
 */
export function campaignErrorForLog(error: unknown): string {
  const e = error as any;
  const db = e?.cause && typeof e.cause === 'object' ? e.cause : e;
  const parts = [typeof e?.name === 'string' ? e.name : typeof error];
  for (const key of ['code', 'table', 'column', 'constraint'] as const) {
    const v = db?.[key];
    if (typeof v === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(v)) parts.push(`${key}=${v}`);
  }
  return parts.join(' ');
}

export interface CampaignContactReads {
  getCampaignContacts(campaignId: string): Promise<CampaignContact[]>;
  getContactAttempts(contactId: string): Promise<CampaignContactAttempt[]>;
}

export function mountCampaignContactReads(app: Express, deps: {
  authenticate: RequestHandler;
  storage: CampaignContactReads;
}): void {
  app.get('/api/campaigns/:id/contacts', deps.authenticate, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const contacts = await deps.storage.getCampaignContacts(req.params.id);
      res.json(contacts.map(toCampaignContactView));
    } catch (error) {
      console.error('Error fetching campaign contacts:', campaignErrorForLog(error));
      res.status(500).json({ message: 'Failed to fetch campaign contacts' });
    }
  });

  app.get('/api/campaigns/:campaignId/contacts/:contactId/attempts', deps.authenticate, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const attempts = await deps.storage.getContactAttempts(req.params.contactId);
      res.json(
        attempts
          .filter((a) => a.campaignId === req.params.campaignId)
          .map(toContactAttemptView),
      );
    } catch (error) {
      console.error('[API] Error fetching contact attempts:', campaignErrorForLog(error));
      res.status(500).json({ message: 'Failed to fetch contact attempts' });
    }
  });
}
