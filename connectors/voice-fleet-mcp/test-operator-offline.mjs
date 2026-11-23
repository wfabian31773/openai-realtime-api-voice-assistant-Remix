// Offline: operator SID validation, paths and original includeContent behavior. No sockets.
import assert from 'node:assert/strict';
import { mockFleet } from './test-support.mjs';
const content = 'Synthetic body from synthetic@example.test, phone +1 (909) 555-1234';
const maskedContent = 'Synthetic body from synthetic@example.test, phone ***-***-1234';
const nestedContent = [{ role: 'caller', text: content, name: 'Synthetic Speaker', email: 'synthetic@example.test', nested: { phone: '9095551234', body: content, mediaUrl: 'https://example.test/media' } }];
const { seen, rpc, call } = mockFleet(() => [200, {
  from: '+19095551234', name: 'Synthetic Person', email: 'synthetic@example.test',
  body: content, text: content, transcript: nestedContent, turns: nestedContent,
  transcription: content, transcriptionText: content, content: { messages: nestedContent }, messages: nestedContent,
  empty: { body: '', text: null }, recordingUrl: 'https://example.test/recording', mediaUrls: ['https://example.test/media'],
  note: 'mail synthetic@example.test', status: 'received',
}]);
const names = (await rpc('tools/list')).result.tools.map((tool) => tool.name);
assert.equal(names.length, 26);
const hex = '0123456789abcdef'.repeat(2);
for (const [tool, key, good, bads, path] of [
  ['operator_inbound_get', 'callSid', 'CA' + hex, ['SM' + hex, 'CA' + hex.slice(1), 'CA' + hex.slice(1) + 'g', '../x'], '/operator-line/inbound/'],
  ['operator_sms_get', 'messageSid', 'MM' + hex, ['CA' + hex, 'SMxyz'], '/operator-line/sms/'],
  ['operator_voicemail_get', 'recordingSid', 'RE' + hex, ['CA' + hex, ''], '/operator-line/voicemail/'],
]) {
  assert(names.includes(`voice_fleet_${tool}`));
  const before = seen.length;
  for (const bad of bads) assert((await call(tool, { [key]: bad })).isError);
  assert.equal(seen.length, before);
  for (const sid of [good.slice(0, 2) + hex.toUpperCase(), good.slice(0, 2) + 'aBcDeF0123456789'.repeat(2)]) {
    assert(!(await call(tool, { [key]: sid })).isError);
    assert.equal(seen.at(-1).path, path + sid);
  }
  for (const includeContent of [undefined, false, true]) {
    const result = await call(tool, { [key]: good, includeContent });
    const text = result.content[0].text;
    assert(!result.isError, text);
    assert.equal(seen.at(-1).path, path + good);
    const data = JSON.parse(text).data;
    assert.equal(data.from, '***-***-1234');
    assert.equal(data.name, '[redacted 16 chars]');
    assert.equal(data.email, '[redacted 22 chars]');
    assert.equal(data.note, 'mail [email]');
    assert.deepEqual(data.empty, { body: '', text: null });
    for (const key of ['body', 'text', 'transcription', 'transcriptionText']) {
      assert.equal(data[key], includeContent === true ? maskedContent : `[redacted ${content.length} chars]`);
    }
    for (const turns of [data.transcript, data.turns, data.messages, data.content.messages]) {
      assert.equal(turns[0].text, includeContent === true ? maskedContent : `[redacted ${content.length} chars]`);
      assert.equal(turns[0].name, includeContent === true ? 'Synthetic Speaker' : '[redacted 17 chars]');
      assert.equal(turns[0].email, includeContent === true ? 'synthetic@example.test' : '[redacted 22 chars]');
      assert.equal(turns[0].nested.phone, '***-***-1234');
      assert.equal(turns[0].nested.body, includeContent === true ? maskedContent : `[redacted ${content.length} chars]`);
    }
    for (const privateText of ['555', 'recordingUrl', 'mediaUrls', 'mediaUrl', 'https://example.test/']) assert(!text.includes(privateText), text);
    if (includeContent !== true) assert(!text.includes('Synthetic body') && !text.includes('synthetic@example.test'), text);
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
