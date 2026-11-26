/**
 * THE CAMPAIGNS SCREEN RECEIVES NO DATE OF BIRTH AND NO FULL PHONE NUMBER.
 *
 * Found by the screen accuracy audit of 2026-11-26 (voice PR #525):
 * `GET /api/campaigns/:id/contacts` returned the stored rows, and for the NPX
 * outreach campaign each one carries the patient's full phone, date of birth
 * (`patient_dob` and `custom_data.date_of_birth`), appointment, payer and the
 * outreach text's state. The View dialog shows the name, the phone and a
 * status.
 *
 * The routes are driven through `mountCampaignContactReads` with a fake
 * storage, the way `operatorLineSettings.test.ts` drives its routes, and
 * `server/routes.ts` is pinned to the mount by reading it (the route file
 * opens the database and the session store at import). Every value below is
 * synthetic: a 555 number and invented names and dates.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import { DrizzleQueryError } from 'drizzle-orm';
import type { CampaignContact, CampaignContactAttempt } from '../shared/schema';

vi.mock('./db', () => ({ db: {} }));

const { mountCampaignContactReads, toCampaignContactView, campaignErrorForLog } = await import(
  './campaignContactsView'
);
const { requireAuth } = await import('./auth');

const PHONE = '+15555550123';
const DOB_ISO = '1950-03-04';

/** An NPX outreach contact row as the outbound store writes it. */
function npxContact(over: Partial<CampaignContact> = {}): CampaignContact {
  return {
    id: 'contact-1',
    campaignId: 'campaign-npx',
    phoneNumber: PHONE,
    firstName: 'Testa',
    lastName: 'Lake',
    email: 'testa.lake@example.com',
    customData: {
      date_of_birth: DOB_ISO,
      medical_group: 'Example Medical Group',
      event_name: 'Dilated Exam',
      outreach_text: { state: 'sent', confirmation: { when: 'Tue, Dec 1 at 9:00 AM' } },
    },
    appointmentDate: new Date('2041-12-01T17:00:00.000Z'),
    appointmentDoctor: 'Dr. Example',
    appointmentLocation: 'Example Office',
    appointmentType: 'Dilated Exam',
    patientDob: '03/04/1950',
    outreachStatus: 'answered',
    confirmationResult: null,
    contacted: true,
    successful: false,
    attempts: 1,
    lastAttemptAt: new Date('2041-11-20T18:00:00.000Z'),
    nextAttemptAt: null,
    maxAttempts: 3,
    voicemailLeft: false,
    lastCallSid: 'CA00000000000000000000000000000c01',
    timezone: 'America/Los_Angeles',
    agentNotes: 'npx_booking:example; caller DOB 03/04/1950',
    externalRef: 'appt-0001',
    createdAt: new Date('2041-11-19T00:00:00.000Z'),
    updatedAt: new Date('2041-11-20T18:00:00.000Z'),
    ...over,
  } as CampaignContact;
}

function attempt(over: Partial<CampaignContactAttempt> = {}): CampaignContactAttempt {
  return {
    id: 'attempt-1',
    contactId: 'contact-1',
    campaignId: 'campaign-npx',
    attemptNumber: 1,
    callSid: 'CA00000000000000000000000000000c02',
    direction: 'outbound',
    attemptedAt: new Date('2041-11-20T18:00:00.000Z'),
    answeredAt: new Date('2041-11-20T18:00:10.000Z'),
    endedAt: new Date('2041-11-20T18:02:00.000Z'),
    duration: 110,
    status: 'answered',
    answeredBy: 'human',
    outcome: 'call_back_later',
    recordingUrl: 'https://api.twilio.com/recordings/RE0000',
    transcriptSummary: `Patient confirmed date of birth ${DOB_ISO}, phone ${PHONE}.`,
    notes: 'Spoke with Testa Lake, DOB 03/04/1950.',
    createdAt: new Date('2041-11-20T18:00:00.000Z'),
    ...over,
  } as CampaignContactAttempt;
}

function boot(contacts: CampaignContact[], attempts: CampaignContactAttempt[] = []) {
  const routes: Record<string, RequestHandler[]> = {};
  const app = {
    get: (p: string, ...handlers: RequestHandler[]) => { routes[`GET ${p}`] = handlers; },
  } as unknown as Express;
  const storage = {
    getCampaignContacts: vi.fn(async (_id: string) => contacts),
    getContactAttempts: vi.fn(async (_id: string) => attempts),
  };
  mountCampaignContactReads(app, { authenticate: requireAuth as RequestHandler, storage });

  async function request(route: string, params: Record<string, string>, signedIn = true) {
    const req = { params, session: signedIn ? { userId: 'staff-id' } : {}, headers: {} };
    const result = { status: 200, body: undefined as any, headers: new Headers() };
    const res = {
      status(code: number) { result.status = code; return res; },
      json(value: unknown) { result.body = JSON.parse(JSON.stringify(value)); return res; },
      setHeader(name: string, value: string) { result.headers.set(name, value); },
    };
    const handlers = routes[`GET ${route}`];
    if (!handlers) throw new Error(`no route ${route}`);
    async function run(i: number): Promise<void> {
      const handler = handlers[i];
      if (!handler) return;
      let next: Promise<void> | undefined;
      await handler(req as never, res as never, () => { next = run(i + 1); });
      await next;
    }
    await run(0);
    return result;
  }
  return { request, storage };
}

/** Every way the synthetic date of birth or the full number could be written. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

function leaksPhi(body: unknown): string[] {
  const text = JSON.stringify(body);
  const found: string[] = [];
  // Any value that is not a timestamp but holds seven or more digits, however
  // it is punctuated, could be a phone number.
  for (const s of strings(typeof body === 'string' ? [body] : body)) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) continue;
    if (s.replace(/\D/g, '').length >= 7) found.push(`a phone-length number in "${s.length > 4 ? '…' : s}"`);
  }
  if (text.includes('5555550123')) found.push('the full phone');
  if (text.includes('555-0123') || text.includes('(555)')) found.push('a formatted phone');
  for (const dob of [DOB_ISO, '03/04/1950', '3/4/1950', '1950']) if (text.includes(dob)) found.push(`date of birth ${dob}`);
  for (const key of ['date_of_birth', 'dateOfBirth', 'patientDob', 'dob', 'customData', 'custom_data', 'email', 'agentNotes', 'notes', 'transcriptSummary', 'recordingUrl'])
    if (new RegExp(`"${key}"`, 'i').test(text)) found.push(`the ${key} field`);
  return found;
}

describe('GET /api/campaigns/:id/contacts', () => {
  it('answers each NPX contact with only the name, the phone last 4 and the status', async () => {
    const h = boot([npxContact()]);
    const out = await h.request('/api/campaigns/:id/contacts', { id: 'campaign-npx' });
    expect(out.status).toBe(200);
    expect(h.storage.getCampaignContacts).toHaveBeenCalledWith('campaign-npx');
    expect(out.body).toEqual([
      { id: 'contact-1', firstName: 'Testa', lastName: 'Lake', phoneLast4: '0123', contacted: true, successful: false },
    ]);
  });

  it('carries no date of birth, no full phone and no custom_data', async () => {
    const h = boot([npxContact(), npxContact({ id: 'contact-2', phoneNumber: '(555) 555-0123' })]);
    const out = await h.request('/api/campaigns/:id/contacts', { id: 'campaign-npx' });
    expect(leaksPhi(out.body)).toEqual([]);
  });

  it('a number shorter than ten digits is not sent at all, not even its last 4', async () => {
    const h = boot([npxContact({ phoneNumber: '5550123' }), npxContact({ id: 'c2', phoneNumber: '' })]);
    const out = await h.request('/api/campaigns/:id/contacts', { id: 'campaign-npx' });
    expect(out.body.map((c: any) => c.phoneLast4)).toEqual([null, null]);
  });

  it('a field added to the table later reaches no screen until it is named', () => {
    const row = npxContact() as any;
    row.someNewColumn = 'value from a future migration';
    expect(Object.keys(toCampaignContactView(row)).sort()).toEqual(
      ['contacted', 'firstName', 'id', 'lastName', 'phoneLast4', 'successful'],
    );
  });

  it('is not cached, and refuses a caller who is not signed in', async () => {
    const h = boot([npxContact()]);
    const ok = await h.request('/api/campaigns/:id/contacts', { id: 'campaign-npx' });
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const anon = await h.request('/api/campaigns/:id/contacts', { id: 'campaign-npx' }, false);
    expect(anon.status).toBe(401);
    expect(h.storage.getCampaignContacts).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/campaigns/:campaignId/contacts/:contactId/attempts', () => {
  it('answers how each attempt went, never what was said, the recording or the CallSid', async () => {
    const h = boot([], [attempt()]);
    const out = await h.request('/api/campaigns/:campaignId/contacts/:contactId/attempts', {
      campaignId: 'campaign-npx', contactId: 'contact-1',
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual([{
      id: 'attempt-1', attemptNumber: 1, direction: 'outbound',
      attemptedAt: '2041-11-20T18:00:00.000Z', answeredAt: '2041-11-20T18:00:10.000Z',
      endedAt: '2041-11-20T18:02:00.000Z', duration: 110,
      status: 'answered', answeredBy: 'human', outcome: 'call_back_later',
    }]);
    expect(leaksPhi(out.body)).toEqual([]);
    expect(JSON.stringify(out.body)).not.toContain('CA00000000000000000000000000000c02');
    expect(out.headers.get('cache-control')).toBe('no-store');
  });

  it('answers only attempts that belong to the campaign in the URL', async () => {
    const h = boot([], [attempt(), attempt({ id: 'attempt-2', campaignId: 'another-campaign' })]);
    const out = await h.request('/api/campaigns/:campaignId/contacts/:contactId/attempts', {
      campaignId: 'campaign-npx', contactId: 'contact-1',
    });
    expect(out.body.map((a: any) => a.id)).toEqual(['attempt-1']);
  });
});

describe('a failed campaign write is logged without the rows it was writing', () => {
  it("names the error and the database's code and column, never drizzle's params", () => {
    const cause = Object.assign(new Error('null value in column "phone_number" violates not-null constraint'), {
      code: '23502', table: 'campaign_contacts', column: 'phone_number',
      detail: `Failing row contains (x, campaign-npx, null, Testa, Lake, ${DOB_ISO}).`,
    });
    const error = new DrizzleQueryError(
      'insert into "campaign_contacts" ("phone_number", "first_name", "patient_dob") values ($1, $2, $3)',
      [PHONE, 'Testa', DOB_ISO],
      cause,
    );
    // The leak this exists for: drizzle's own message holds every parameter.
    expect(error.message).toContain(PHONE);
    const line = campaignErrorForLog(error);
    expect(line).toBe('Error code=23502 table=campaign_contacts column=phone_number');
    expect(leaksPhi(line)).toEqual([]);
    expect(line).not.toContain('Testa');
  });

  it("never reads a parser's message, which can quote the field it refused", () => {
    const csvError = Object.assign(new Error('Invalid Opening Quote: a quote is found on field 0 at line 3, value is "Testa"'), {
      name: 'CsvError', code: 'INVALID_OPENING_QUOTE',
    });
    expect(campaignErrorForLog(csvError)).toBe('CsvError code=INVALID_OPENING_QUOTE');
    expect(campaignErrorForLog('a bare string')).toBe('string');
    expect(campaignErrorForLog(undefined)).toBe('undefined');
  });

  it('keeps out a code or column that is not a plain identifier', () => {
    const odd = { name: 'Error', code: `23502 ${PHONE}`, column: 'first name' };
    expect(campaignErrorForLog(odd)).toBe('Error');
  });
});

describe('server/routes.ts answers through the module', () => {
  const routes = readFileSync(path.resolve(__dirname, 'routes.ts'), 'utf8');

  it('mounts the two reads and keeps no inline copy of either', () => {
    expect(routes).toContain('import { mountCampaignContactReads, campaignErrorForLog } from "./campaignContactsView";');
    expect(routes).toContain('mountCampaignContactReads(app, { authenticate: isAuthenticated, storage });');
    expect(routes).not.toMatch(/app\.get\(\s*['"`]\/api\/campaigns\/:id\/contacts['"`]/);
    expect(routes).not.toMatch(/app\.get\(\s*['"`]\/api\/campaigns\/:campaignId\/contacts\/:contactId\/attempts['"`]/);
    expect(routes).not.toMatch(/res\.json\(\s*(contacts|attempts|createdContacts)\s*\)/);
  });

  it('the upload and the schedule import answer counts, and log no error object', () => {
    expect(routes).toContain('console.error("Error uploading contacts:", campaignErrorForLog(error));');
    expect(routes).toContain('console.error("Error populating contacts from schedule:", campaignErrorForLog(error));');
    expect(routes).not.toMatch(/console\.error\("Error (uploading contacts|populating contacts from schedule):", error\)/);
    // Both answer a message and counts, never the rows they created.
    expect(routes).not.toMatch(/res\.json\([^)]*createdContacts\s*[,})]/);
  });
});

describe('the Campaigns screen reads the shape it is sent', () => {
  const page = readFileSync(path.resolve(__dirname, '../client/src/pages/CampaignsPage.tsx'), 'utf8');
  const types = readFileSync(path.resolve(__dirname, '../client/src/types/index.ts'), 'utf8');

  it('shows the last 4 and has no full-phone field to fall back on', () => {
    expect(page).toContain('contact.phoneLast4');
    expect(page).not.toContain('contact.phoneNumber');
    const contactType = types.slice(types.indexOf('export interface CampaignContact {'));
    const body = contactType.slice(0, contactType.indexOf('}'));
    expect(body).toContain('phoneLast4: string | null');
    for (const gone of ['phoneNumber', 'email', 'customData', 'patientDob']) expect(body).not.toContain(gone);
  });
});
