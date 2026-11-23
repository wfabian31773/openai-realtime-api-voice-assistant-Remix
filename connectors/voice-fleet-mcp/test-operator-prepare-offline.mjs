// Offline: operator prepare body matches the fleet allowlist; no sockets.
import assert from 'node:assert/strict';
import { mockFleet } from './test-support.mjs';
import { OPERATOR_PREPARE_FIELDS } from './core.mjs';
const { seen, rpc, call } = mockFleet(() => [200, { approvalId: 'synthetic' }]);
const allowed = new Set(OPERATOR_PREPARE_FIELDS);
const prepare = (args) => call('operator_prepare_call', args);
const schema = (await rpc('tools/list')).result.tools.find((tool) => tool.name === 'voice_fleet_operator_prepare_call').inputSchema;
for (const key of Object.keys(schema.properties)) assert(allowed.has(key));
assert.deepEqual(schema.required, ['phone']);
const phone = '+19095550000';
for (const [input, expected] of [
  [{ purpose: 'Ask about hours', callerScript: 'Synthetic script', language: 'en', maxDurationSec: 120, initiated_by: 'owner_request' }, { purpose: 'Ask about hours', callerScript: 'Synthetic script', language: 'en', maxDurationSec: 120, initiated_by: 'owner_request' }],
  [{ purpose: 'Synthetic purpose', callerScript: 'Synthetic script', openingLine: 'Synthetic opening' }, { purpose: 'Synthetic purpose', callerScript: 'Synthetic script', openingLine: 'Synthetic opening' }],
  [{ purpose: 'Synthetic purpose', caller_script: 'S', opening_line: 'O' }, { purpose: 'Synthetic purpose', callerScript: 'S', openingLine: 'O' }],
  [{ scenario_id: 'A3' }, { scenario_id: 'A3' }],
  [{ scenario_id: 'A1', purpose: 'goal' }, { scenario_id: 'A1', purpose: 'goal' }],
]) {
  const result = await prepare({ phone, ...input });
  assert(!result.isError, result.content[0].text);
  assert.equal(seen.at(-1).path, '/prepare_operator_call');
  assert.deepEqual(seen.at(-1).body, { phone, ...expected });
  for (const key of Object.keys(seen.at(-1).body)) assert(allowed.has(key));
}
const before = seen.length;
for (const bad of [{}, { purpose: 'x'.repeat(4001) }, { purpose: 'p', openingLine: 'x'.repeat(501) }, { purpose: 'p', openingLine: '' }, { purpose: 'p', callerScript: null }, { purpose: 'p', caller_script: '  ' }, { purpose: 'p', openingLine: '', opening_line: 'Hello' }, { purpose: 'p', callerScript: 'a', caller_script: 'b' }]) assert((await prepare({ phone, ...bad })).isError);
assert.equal(seen.length, before);
console.log('operator prepare offline: ok');
