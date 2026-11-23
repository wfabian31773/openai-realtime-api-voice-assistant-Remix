// Offline: operator SID validation, paths and mandatory masking. No sockets.
import assert from 'node:assert/strict';
import { mockFleet } from './test-support.mjs';
const { seen, rpc, call } = mockFleet(() => [200, {
  from: '+19095551234', name: 'Synthetic Person', email: 'synthetic@example.test',
  body: 'Synthetic body', transcript: [{ role: 'caller', text: 'Synthetic private words' }],
  transcriptionText: 'Synthetic transcription', recordingUrl: 'https://example.test/recording', mediaUrls: ['https://example.test/media'],
  note: 'mail synthetic@example.test', status: 'received',
}]);
const names = (await rpc('tools/list')).result.tools.map((tool) => tool.name);
assert.equal(names.length, 26);
const hex = '0123456789abcdef'.repeat(2);
for (const [tool, key, good, bads, path] of [
  ['operator_inbound_get', 'callSid', 'CA' + hex, ['SM' + hex, 'CA' + hex.slice(1), 'CA' + hex.toUpperCase(), '../x'], '/operator-line/inbound/'],
  ['operator_sms_get', 'messageSid', 'MM' + hex, ['CA' + hex, 'SMxyz'], '/operator-line/sms/'],
  ['operator_voicemail_get', 'recordingSid', 'RE' + hex, ['CA' + hex, ''], '/operator-line/voicemail/'],
]) {
  assert(names.includes(`voice_fleet_${tool}`));
  const before = seen.length;
  for (const bad of bads) assert((await call(tool, { [key]: bad })).isError);
  assert.equal(seen.length, before);
  for (const includeContent of [false, true]) {
    const result = await call(tool, { [key]: good, includeContent });
    const text = result.content[0].text;
    assert(!result.isError, text);
    assert.equal(seen.at(-1).path, path + good);
    assert(text.includes('***-***-1234') && text.includes('[email]') && text.includes('[redacted]'));
    for (const privateText of ['Synthetic', '555', 'recordingUrl', 'mediaUrls', 'synthetic@example.test']) assert(!text.includes(privateText), text);
  }
}
assert(!(await call('operator_sms_get', { messageSid: 'SM' + hex })).isError);
const before = seen.length;
for (const bad of [{ to: '9095551234', body: 'hi' }, { to: '', body: 'hi', idempotency_key: 'k' }, { to: '9095551234', body: 'hi', idempotency_key: 'x'.repeat(201) }]) assert((await call('operator_sms_send', bad)).isError);
assert.equal(seen.length, before);
const sent = await call('operator_sms_send', { to: '909-555-1234', body: 'Synthetic body', idempotency_key: 'synthetic:confirm' });
assert(!sent.isError);
assert.equal(seen.at(-1).method, 'POST');
assert.equal(seen.at(-1).path, '/operator-line/sms/send');
assert.equal(seen.at(-1).body.body, 'Synthetic body');
assert(!sent.content[0].text.includes('Synthetic'));
console.log('operator offline: ok (26 tools)');
