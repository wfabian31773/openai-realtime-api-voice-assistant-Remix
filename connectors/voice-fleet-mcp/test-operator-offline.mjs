// Offline: mock fleet for operator-line read tools (SID validation, paths, masking). No network.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const seen = [];
const srv = createServer((req, res) => { seen.push(`${req.method} ${req.url} ${req.headers.authorization ? 'auth' : 'noauth'}`); res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ sid: req.url.split('/').pop(), from: '+19095551234', body: 'my DOB is 1/2/1950', transcript: [{ role: 'caller', text: 'call me at 909-555-1234 about drops' }], transcriptionText: 'leave it at the front', recordingUrl: 'https://api.twilio.com/x', mediaUrls: ['https://m/1'], note: 'mail a@b.com', status: 'received' })); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const dir = mkdtempSync(`${tmpdir()}/vf-`); writeFileSync(`${dir}/bot.token`, `si.${'a'.repeat(32)}.${'b'.repeat(64)}`);
const p = spawn('node', ['server.mjs'], { env: { ...process.env, VOICE_FLEET_BASE_URL: `http://127.0.0.1:${srv.address().port}`, VOICE_FLEET_TOKEN_FILE: `${dir}/bot.token` }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waits = new Map();
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
let n = 0; const rpc = (method, params) => new Promise((r) => { const id = ++n; waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = async (name, a) => (await rpc('tools/call', { name: `voice_fleet_${name}`, arguments: a })).result;
await rpc('initialize', {});
const names = (await rpc('tools/list')).result.tools.map((t) => t.name);
assert.equal(names.length, 26);
const h = '0123456789abcdef'.repeat(2);
for (const [t, k, good, bads, path] of [
  ['operator_inbound_get', 'callSid', 'CA' + h, ['SM' + h, 'CA' + h.slice(1), 'CA' + h.toUpperCase(), '../x'], '/operator-line/inbound/'],
  ['operator_sms_get', 'messageSid', 'MM' + h, ['CA' + h, 'SMxyz'], '/operator-line/sms/'],
  ['operator_voicemail_get', 'recordingSid', 'RE' + h, ['CA' + h, ''], '/operator-line/voicemail/']]) {
  assert(names.includes(`voice_fleet_${t}`));
  const before = seen.length;
  for (const b of bads) assert((await call(t, { [k]: b })).isError, `${t} accepted ${b}`);
  assert.equal(seen.length, before, 'bad SID must not hit network');
  const r = await call(t, { [k]: good }); const txt = r.content[0].text;
  assert(!r.isError, txt);
  assert.equal(seen.at(-1), `GET /api/plugin/v1${path}${good} auth`);
  assert(txt.includes('***-***-1234') && txt.includes('[email]') && !txt.includes('555') && !txt.includes('1950'), txt);
  assert(!txt.includes('twilio.com/x') && !txt.includes('https://m/1') && !txt.includes('about drops'), txt);
  const f = (await call(t, { [k]: good, includeContent: true })).content[0].text;
  assert(f.includes('my DOB is 1/2/1950') && f.includes('call me at ***-***-1234 about drops') && f.includes('leave it at the front'), f);
  assert(!f.includes('555') && !f.includes('recordingUrl') && !f.includes('mediaUrls') && f.includes('[email]'), f);
}
assert((await call('operator_sms_get', { messageSid: 'SM' + h })).content[0].text.includes('SM' + h));
// operator_sms_send: validation local, POST path, body/phones not echoed.
const b0 = seen.length;
for (const bad of [{ to: '9095551234', body: 'hi' }, { to: '', body: 'hi', idempotency_key: 'k' }, { to: '9095551234', body: 'hi', idempotency_key: 'x'.repeat(201) }]) assert((await call('operator_sms_send', bad)).isError);
assert.equal(seen.length, b0, 'invalid send must not hit network');
const s1 = await call('operator_sms_send', { to: '909-555-1234', body: 'secret body text', idempotency_key: 'CAabc:confirm' });
const st = s1.content[0].text;
assert.equal(seen.at(-1), 'POST /api/plugin/v1/operator-line/sms/send auth');
assert(!st.includes('555') && !st.includes('secret body text') && !st.includes('1950'), st);
assert(names.includes('voice_fleet_operator_sms_send'));
p.stdin.end(); srv.close(); console.log('operator offline: ok (26 tools)');
