// Offline: capability-independent live controls, confirm hand-off and output parity. No sockets.
import assert from 'node:assert/strict';
import { mockFleet } from './test-support.mjs';
let liveCaps = true;
let capsStatus = 200;
const { seen, rpc, call } = mockFleet(({ path }) => {
  if (path === '/capabilities') return [capsStatus, { liveCalls: liveCaps, confirmTokenHandoff: true }];
  if (path === '/contact_requests/ap1/confirm_token') return [200, { confirmToken: 'a'.repeat(64) }];
  if (path === '/commit_call_live') return [200, { status: 'live', sessionId: 's1' }];
  if (path === '/live_calls/s1?after=2') return [200, { status: 'in_progress', phone: '909-555-1234', note: 'synthetic@example.test', transcript: [{ role: 'caller', text: 'Synthetic private words' }] }];
  if (path === '/live_calls/s1/instruct') return [200, { status: 'instructed' }];
  if (path === '/live_calls/s1/end') return [200, { status: 'completed' }];
  return [404, { error: 'not found' }];
});
const names = (await rpc('tools/list')).result.tools.map((tool) => tool.name);
assert.equal(names.length, 26);
for (const name of ['capabilities', 'commit_call_live', 'live_call_status', 'live_call_instruct', 'live_call_end']) assert(names.includes(`voice_fleet_${name}`));
// README contract: confirmToken is optional only when id is supplied.
// approvalId was a stale test input, never a supported hand-off argument.
const before = seen.length;
assert((await call('commit')).isError);
assert((await call('commit_call_live', { approvalId: 'ap1' })).isError);
assert.equal(seen.length, before);
const live = await call('commit_call_live', { id: 'ap1' });
assert(!live.isError, live.content[0].text);
assert(seen.some((request) => request.method === 'POST' && request.path === '/commit_call_live' && request.body.confirmToken === 'a'.repeat(64)));
assert(!JSON.stringify(live).includes('a'.repeat(64)));
const status = await call('live_call_status', { sessionId: 's1', after: 2 });
assert(!status.isError);
assert(status.content[0].text.includes('909-555-1234') && status.content[0].text.includes('synthetic@example.test'));
assert(status.content[0].text.includes('Synthetic private words'));
assert(!(await call('live_call_instruct', { sessionId: 's1', text: 'Synthetic guidance' })).isError);
const invalidBefore = seen.length;
assert((await call('live_call_instruct', { sessionId: 's1', text: 'x'.repeat(2001) })).isError);
assert((await call('live_call_status', { sessionId: '../x' })).isError);
assert.equal(seen.length, invalidBefore);
// The original never probed capabilities. A token without fleet:read can
// still use its owned live routes, and the real route decides availability.
for (const capabilityStatus of [200, 403]) {
  liveCaps = false;
  capsStatus = capabilityStatus;
  const capsBefore = seen.length;
  for (const tool of ['commit_call_live', 'operator_commit_call']) assert(!(await call(tool, { id: 'ap1' })).isError);
  assert(!(await call('live_call_status', { sessionId: 's1', after: 2 })).isError);
  assert(!(await call('live_call_instruct', { sessionId: 's1', text: 'Synthetic guidance' })).isError);
  assert(!(await call('live_call_end', { sessionId: 's1' })).isError);
  assert.deepEqual(seen.slice(capsBefore).map((request) => request.path), [
    '/contact_requests/ap1/confirm_token', '/commit_call_live',
    '/contact_requests/ap1/confirm_token', '/commit_call_live',
    '/live_calls/s1?after=2', '/live_calls/s1/instruct', '/live_calls/s1/end',
  ]);
}
console.log('offline: ok');
