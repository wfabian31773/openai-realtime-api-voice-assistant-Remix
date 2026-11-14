/**
 * THE TOOL ARGUMENTS ARE KEPT (v238) — operator, 2026-11-14: "Dont' you think
 * we should be tracking the tools arguments? Seems like this is the only way
 * to pinpoint what is happening behind the scenes on some of these calls."
 * Approved the same day: a separate store, 30 days, admins only.
 *
 * THE BEFORE. `call_logs.tool_timeline` keeps an allow-listed subset of each
 * tool call (`SAFE_ARG_KEYS`). Over the seven days to 2026-11-14, 15,998
 * runtime tool calls, and on 9,028 (56%) it kept NO argument. Four defects
 * that could not be read back because of it, by real SID (every value below is
 * synthetic, in each call's shape):
 *
 *   CAd9bc221aa5b4eb90f43a16745849a4fb  identify_callback_caller: the first
 *       name the model sent and whether the tool identified the caller
 *   CA3eec4f155e08f15868b34008bd15d988  book_sooner_exam (#476): the form the
 *       date and time arrived in
 *   CAa36ae68ef6d5654594fe11253d30a942  record_pcp_intake (v177): which field
 *       the model got wrong, and with what
 *   CAc7a24aeff2ec7f71932c8bbd1cf54971  file_records_ticket (#482 bucket B):
 *       whether the tool ever received the patient's name
 *
 * Each corpus test drives the REAL `recordingExecute` and the REAL timeline,
 * with only the database faked, and asserts both halves: the timeline still
 * drops the field (it must stay PHI-free for the reports), and the payload
 * store receives it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  executeThrows: false,
}));

vi.mock('../../server/db', async () => {
  const { PgDialect: D } = await import('drizzle-orm/pg-core');
  const dialect = new D();
  return {
    db: {
      execute: async (q: SQL) => {
        if (h.executeThrows) throw new Error('database unavailable (synthetic)');
        const r = dialect.sqlToQuery(q);
        h.queries.push({ sql: r.sql, params: r.params });
        return { rows: [] };
      },
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: 'row-1' }] }) }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'row-1' }] }) }) }),
    },
  };
});
vi.mock('./callGradingService', () => ({
  callGradingService: { runAndPersistDeterministicGraders: vi.fn(async () => undefined) },
}));

const timeline = await import('./toolTimeline');
const payloads = await import('./toolPayloads');
const dialect = new PgDialect();

function last<T>(xs: T[]): T {
  return xs[xs.length - 1];
}

/** Let fire-and-forget writes settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function inserts() {
  return h.queries.filter((q) => q.sql.includes('INSERT INTO tool_call_payloads'));
}

/** The INSERT's parameters, by column. */
function insertedRow(i = -1) {
  const all = inserts();
  const q = all[i < 0 ? all.length + i : i];
  const [callId, callSid, callLogId, agentSlug, seq, tool, eventAt, at, ms, args, result] = q.params as any[];
  return {
    callId, callSid, callLogId, agentSlug, seq, tool, eventAt, at, ms,
    args: JSON.parse(args), result: JSON.parse(result),
  };
}

async function runTool(
  sid: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  agentSlug = 'npx-outreach',
) {
  const exec = timeline.recordingExecute({ callId: sid, callSid: sid, agentSlug }, tool, async () => result);
  const out = await exec(args);
  await settle();
  return out;
}

beforeEach(() => {
  h.queries.length = 0;
  h.executeThrows = false;
});

describe('the corpus: what the timeline dropped is now kept', () => {
  it('CAd9bc221a — the first name sent to identify_callback_caller, and that it did not identify them', async () => {
    const sid = 'CAd9bc221aa5b4eb90f43a16745849a4fb';
    await runTool(sid, 'identify_callback_caller', { first_name: 'Testa', call_sid: sid }, {
      success: true,
      identified: false,
      fix: 'Ask for their last name.',
    });
    const ev = last(timeline.getAzulTimeline(sid)!);
    expect(ev.args).not.toHaveProperty('first_name');
    expect(ev.outcome).not.toHaveProperty('identified');

    const row = insertedRow();
    expect(row.callSid).toBe(sid);
    expect(row.tool).toBe('identify_callback_caller');
    expect(row.args.first_name).toBe('Testa');
    expect(row.result.identified).toBe(false);
  });

  it('CA3eec4f15 (#476) — the date and time the model sent to book_sooner_exam, in the form it sent them', async () => {
    const sid = 'CA3eec4f155e08f15868b34008bd15d988';
    await runTool(sid, 'book_sooner_exam', { date: 'February 13', time: '9 AM', option: 1 }, {
      success: false,
      refused: 'which_list',
      choices: [{ date: '2041-02-13', time: '09:00' }],
    });
    const ev = last(timeline.getAzulTimeline(sid)!);
    expect(ev.args).not.toHaveProperty('date');
    expect(ev.args).not.toHaveProperty('time');

    const row = insertedRow();
    expect(row.args).toMatchObject({ date: 'February 13', time: '9 AM', option: 1 });
    expect(row.result.refused).toBe('which_list');
  });

  it('CAa36ae68e (v177) — the value the model sent to the field record_pcp_intake refused', async () => {
    const sid = 'CAa36ae68ef6d5654594fe11253d30a942';
    await runTool(
      sid,
      'record_pcp_intake',
      { callPurpose: 'schedule_appointment', patientDob: '3/17/41' },
      { success: false, refused: 'invalid_arguments', invalidFields: ['patientDob'] },
      'pcp',
    );
    const ev = last(timeline.getAzulTimeline(sid)!);
    expect(ev.args).not.toHaveProperty('patientDob');

    const row = insertedRow();
    expect(row.agentSlug).toBe('pcp');
    expect(row.args.patientDob).toBe('3/17/41');
    expect(row.result.invalidFields).toEqual(['patientDob']);
  });

  it('CAc7a24aef (#482 bucket B) — the patient name a filing tool received', async () => {
    const sid = 'CAc7a24aeff2ec7f71932c8bbd1cf54971';
    await runTool(
      sid,
      'file_records_ticket',
      { first_name: 'Testa', last_name: 'Lake', request_description: 'Wants records sent to a new doctor.' },
      { success: true, ticket_number: 'VA-00001' },
      'records',
    );
    const ev = last(timeline.getAzulTimeline(sid)!);
    expect(ev.args).not.toHaveProperty('first_name');
    expect(ev.args).not.toHaveProperty('last_name');

    const row = insertedRow();
    expect(row.args).toMatchObject({ first_name: 'Testa', last_name: 'Lake' });
    expect(row.result.ticket_number).toBe('VA-00001');
  });
});

describe('the row lines up with the timeline event it belongs to', () => {
  it('carries the event index and the event’s own timestamp, byte for byte', async () => {
    const sid = 'CA00000000000000000000000000000a01';
    await runTool(sid, 'lookup_patient', { first_name: 'Testa' }, { success: true });
    await runTool(sid, 'resolve_location', { location: 'Covina' }, { success: true, verified: true });
    const events = timeline.getAzulTimeline(sid)!;
    const [first, second] = inserts().map((_, i) => insertedRow(i));
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(first.eventAt).toBe(events[0].at);
    expect(second.eventAt).toBe(events[1].at);
    expect(second.at).toBe(events[1].at);
  });

  it('takes the CallSid from the call id when no ids are given and the id is a CallSid', async () => {
    const sid = 'CA00000000000000000000000000000a02';
    timeline.recordToolEvent(sid, 'check_open_tickets', { caller_phone: 'x' }, '{"success":true}', 12);
    await settle();
    const row = insertedRow();
    expect(row.callId).toBe(sid);
    expect(row.callSid).toBe(sid);
    expect(row.ms).toBe(12);
  });

  it('stores a call whose id is not a CallSid under its id, with no CallSid', async () => {
    timeline.recordToolEvent('rtc_old_core_call_1', 'create_ticket', {}, '{"success":true}', 3.6);
    await settle();
    const row = insertedRow();
    expect(row.callId).toBe('rtc_old_core_call_1');
    expect(row.callSid).toBeNull();
    expect(row.ms).toBe(4);
  });

  it('keeps a result that is not JSON as its text', async () => {
    timeline.recordToolEvent('CA00000000000000000000000000000a03', 'end_call', {}, 'hanging up', 0);
    await settle();
    expect(insertedRow().result).toEqual({ text: 'hanging up' });
  });
});

describe('credentials never reach the store', () => {
  it('removes a key that names a token, secret, password, key, signature or cookie', () => {
    const out = payloads.scrubForStorage({
      confirm_token: 'abc',
      apiKey: 'k',
      'X-Signature': 's',
      accessToken: 't',
      password: 'p',
      sessionCookie: 'c',
      authorization: 'Bearer x',
      nested: { client_secret: 'z', keep: 'yes' },
    }) as any;
    for (const k of ['confirm_token', 'apiKey', 'X-Signature', 'accessToken', 'password', 'sessionCookie', 'authorization']) {
      expect(out[k]).toBe('[removed]');
    }
    expect(out.nested.client_secret).toBe('[removed]');
    expect(out.nested.keep).toBe('yes');
  });

  it('keeps keys that only look close: an idempotency key, a confirmation type, key phrases', () => {
    const out = payloads.scrubForStorage({
      idempotencyKey: 'call-CA1',
      confirmation_type: 'appointment',
      key_phrases: ['glasses'],
      confirmed: true,
    }) as any;
    expect(out).toEqual({
      idempotencyKey: 'call-CA1',
      confirmation_type: 'appointment',
      key_phrases: ['glasses'],
      confirmed: true,
    });
  });

  it('cuts a URL’s query string and its opaque path segments, wherever the URL sits', () => {
    const token = 'Zx8_Qm2-Lp4vT7rW9nB1cD3eF5gH6jK0aS';
    expect(payloads.scrubUrl(`https://example.test/book/${token}?sig=abc#x`)).toBe(
      'https://example.test/book/[removed]?[removed]',
    );
    expect(payloads.scrubUrl('https://example.test/voice/no-ivr')).toBe('https://example.test/voice/no-ivr');
    const out = payloads.scrubForStorage({ message: `Your link: https://example.test/book/${token}. Thanks` }) as any;
    expect(out.message).toBe('Your link: https://example.test/book/[removed]. Thanks');
  });

  it('removes a bearer token and a JWT inside free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = payloads.scrubString(`Authorization: Bearer abc.def-123 and ${jwt}`);
    expect(out).not.toContain('abc.def-123');
    expect(out).not.toContain(jwt);
    expect(out).toContain('Bearer [removed]');
  });

  it('never changes what it is given — the tool is still using it', () => {
    const args = { confirm_token: 'abc', url: 'https://example.test/x?y=1' };
    payloads.scrubForStorage(args);
    expect(args).toEqual({ confirm_token: 'abc', url: 'https://example.test/x?y=1' });
  });

  it('a credential in a tool’s arguments is removed on the way into the table', async () => {
    const sid = 'CA00000000000000000000000000000a04';
    await runTool(sid, 'commit_contact', { confirm_token: 'abc123', channel: 'sms' }, { success: true });
    const row = insertedRow();
    expect(row.args).toEqual({ confirm_token: '[removed]', channel: 'sms' });
    expect(JSON.stringify(h.queries)).not.toContain('abc123');
  });
});

describe('a half too large to keep is cut and says so', () => {
  it('keeps the first characters of the JSON, the total length and a flag', () => {
    const big = { text: 'x'.repeat(payloads.RESULT_CHAR_CAP + 500) };
    const out = payloads.capped(big, payloads.RESULT_CHAR_CAP) as any;
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(payloads.RESULT_CHAR_CAP);
    expect(out.chars).toBe(JSON.stringify(big).length);
  });

  it('keeps a half under the cap as it is', () => {
    expect(payloads.capped({ a: 1 }, payloads.ARGS_CHAR_CAP)).toEqual({ a: 1 });
  });

  it('arguments and result have their own caps', () => {
    const p = payloads.payloadFor({
      args: { note: 'y'.repeat(payloads.ARGS_CHAR_CAP + 1) },
      resultJson: JSON.stringify({ ok: 'z'.repeat(payloads.ARGS_CHAR_CAP + 1) }),
    }) as any;
    expect(p.args.truncated).toBe(true);
    expect(p.result.truncated).toBeUndefined();
  });
});

describe('the writer never reaches the call', () => {
  function fakeStore() {
    const s = {
      ensures: 0,
      rows: [] as unknown[],
      purges: [] as string[],
      ensureFails: 0,
      insertFails: false,
      async ensure() {
        s.ensures += 1;
        if (s.ensureFails > 0) {
          s.ensureFails -= 1;
          throw new Error('ensure failed (synthetic)');
        }
      },
      async insert(row: unknown) {
        if (s.insertFails) throw new Error('insert failed (synthetic)');
        s.rows.push(row);
      },
      async purge(cutoff: string) {
        s.purges.push(cutoff);
      },
    };
    return s;
  }
  const row = (n = 0) => ({
    callId: `CA${n}`, callSid: null, callLogId: null, agentSlug: null,
    seq: n, tool: 't', eventAt: new Date(0).toISOString(), ms: 1, args: {}, result: {},
  });
  const quiet = { info: () => {}, warn: () => {} };

  it('a tool still returns its own answer when the database is down', async () => {
    h.executeThrows = true;
    const sid = 'CA00000000000000000000000000000a05';
    const out = await runTool(sid, 'lookup_patient', { first_name: 'Testa' }, { success: true, found: true });
    expect(out).toEqual({ success: true, found: true });
  });

  it('ensures the table once, and again only after a failed attempt', async () => {
    const store = fakeStore();
    store.ensureFails = 1;
    const w = payloads.createToolPayloadWriter(store, { log: quiet, env: {} });
    await w.record(row(1)); // ensure fails, nothing written, nothing thrown
    await w.record(row(2));
    await w.record(row(3));
    expect(store.ensures).toBe(2);
    expect(store.rows).toHaveLength(2);
  });

  it('never rejects, and warns on the first failure only', async () => {
    const store = fakeStore();
    store.insertFails = true;
    const warn = vi.fn();
    const w = payloads.createToolPayloadWriter(store, { log: { info: () => {}, warn }, env: {} });
    await expect(w.record(row(1))).resolves.toBeUndefined();
    await w.record(row(2));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names a failure by its code, never by a message that could quote the value', async () => {
    const store = fakeStore();
    store.insert = async () => {
      throw Object.assign(new Error('invalid input syntax for type json: "Testa Lake"'), { code: '22P02' });
    };
    const warn = vi.fn();
    const w = payloads.createToolPayloadWriter(store, { log: { info: () => {}, warn }, env: {} });
    await w.record(row(1));
    expect(warn.mock.calls[0][0]).toContain('code 22P02');
    expect(warn.mock.calls[0][0]).not.toContain('Testa');
  });

  it('says it is storing, once, on the first write', async () => {
    const store = fakeStore();
    const info = vi.fn();
    const w = payloads.createToolPayloadWriter(store, { log: { info, warn: () => {} }, env: {} });
    await w.record(row(1));
    await w.record(row(2));
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('30-day retention');
  });

  it('TOOL_PAYLOADS_DISABLED=1 writes nothing', async () => {
    const store = fakeStore();
    const w = payloads.createToolPayloadWriter(store, { log: quiet, env: { TOOL_PAYLOADS_DISABLED: '1' } });
    await w.record(row(1));
    expect(store.ensures).toBe(0);
    expect(store.rows).toHaveLength(0);
  });

  it('deletes rows older than 30 days, at most once an hour', async () => {
    const store = fakeStore();
    let t = Date.parse('2026-11-14T12:00:00.000Z');
    const w = payloads.createToolPayloadWriter(store, { log: quiet, env: {}, now: () => t });
    await w.record(row(1));
    expect(store.purges).toEqual(['2026-10-15T12:00:00.000Z']);
    t += payloads.PURGE_EVERY_MS - 1;
    await w.record(row(2));
    expect(store.purges).toHaveLength(1);
    t += 1;
    await w.record(row(3));
    expect(store.purges).toHaveLength(2);
    expect(payloads.TOOL_PAYLOAD_RETENTION_DAYS).toBe(30);
  });
});

describe('the table', () => {
  it('is created with row-level security on, and indexed for the call page and the purge', async () => {
    h.queries.length = 0;
    await payloads.hubToolPayloadStore.ensure();
    const text = h.queries.map((q) => q.sql).join('\n');
    expect(text).toContain('CREATE TABLE IF NOT EXISTS tool_call_payloads');
    expect(text).toContain('ALTER TABLE tool_call_payloads ENABLE ROW LEVEL SECURITY');
    expect(text).toContain('ON tool_call_payloads (call_sid)');
    expect(text).toContain('ON tool_call_payloads (created_at)');
  });

  it('types every bound value, so Postgres can parse the insert (the v52 lesson)', async () => {
    h.queries.length = 0;
    await payloads.hubToolPayloadStore.insert({
      callId: 'CA1', callSid: null, callLogId: null, agentSlug: null, seq: 0, tool: 't',
      eventAt: '2026-11-14T00:00:00.000Z', ms: null, args: {}, result: {},
    });
    const q = h.queries[0].sql;
    for (const cast of ['::text', '::integer', '::timestamptz', '::jsonb']) expect(q).toContain(cast);
    expect((q.match(/\$\d+/g) ?? []).length).toBe(11);
  });

  it('the purge deletes by creation time against a typed cutoff', async () => {
    h.queries.length = 0;
    await payloads.hubToolPayloadStore.purge('2026-10-15T12:00:00.000Z');
    expect(h.queries[0].sql).toContain('DELETE FROM tool_call_payloads WHERE created_at < $1::timestamptz');
    expect(h.queries[0].params).toEqual(['2026-10-15T12:00:00.000Z']);
  });
});

describe('the timeline itself is unchanged', () => {
  it('still keeps only the allow-listed keys', async () => {
    const sid = 'CA00000000000000000000000000000a06';
    await runTool(sid, 'file_optical_ticket', { first_name: 'Testa', priority: 'high', department_id: 1 }, { success: true });
    const ev = last(timeline.getAzulTimeline(sid)!);
    expect(ev.args).toMatchObject({ priority: 'high', department_id: 1 });
    expect(ev.args).not.toHaveProperty('first_name');
  });

  it('the recorder hands the payload store the same arguments and result the tool saw', () => {
    const src = readFileSync(new URL('./toolTimeline.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function recordAzulToolEvent'), src.indexOf('export const recordToolEvent'));
    expect(body).toContain('recordToolPayload(');
    expect(body).toContain('...payloadFor({ args, resultJson })');
    expect(body).toContain('eventAt: recorded.at');
  });
});

void dialect;
