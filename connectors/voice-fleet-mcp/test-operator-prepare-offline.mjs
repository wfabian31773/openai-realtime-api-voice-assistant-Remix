// Offline: operator_prepare_call body must match Remix operatorLine.ts parseOperatorPayload allowlist. No network beyond a local mock.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const ALLOW = new Set(["callKind", "phone", "purpose", "callerScript", "openingLine", "scenario_id", "initiated_by", "requested_by", "language", "maxDurationSec"]);
const bodies = [];
const srv = createServer((req, res) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => { bodies.push({ url: req.url, body: JSON.parse(d || '{}') }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"approvalId":"x"}'); }); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const dir = mkdtempSync(`${tmpdir()}/vf-`); writeFileSync(`${dir}/bot.token`, `si.${'a'.repeat(32)}.${'b'.repeat(64)}`);
const p = spawn('node', ['server.mjs'], { env: { ...process.env, VOICE_FLEET_BASE_URL: `http://127.0.0.1:${srv.address().port}`, VOICE_FLEET_TOKEN_FILE: `${dir}/bot.token` }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waits = new Map();
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
let n = 0; const rpc = (method, params) => new Promise((r) => { const id = ++n; waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = async (a) => (await rpc('tools/call', { name: 'voice_fleet_operator_prepare_call', arguments: a })).result;
await rpc('initialize', {});
const tool = (await rpc('tools/list')).result.tools.find((t) => t.name === 'voice_fleet_operator_prepare_call');
for (const k of Object.keys(tool.inputSchema.properties)) assert(ALLOW.has(k), `schema field ${k} not accepted by server`);
assert.deepEqual(tool.inputSchema.required, ['phone']);
const phone = '+1909555' + '0000';
const check = (b) => { for (const k of Object.keys(b)) assert(ALLOW.has(k), `sent unknown field ${k}`); };
// purpose path
assert(!(await call({ phone, purpose: 'Ask about hours', callerScript: 'x', language: 'en', maxDurationSec: 120, initiated_by: 'owner_request' })).isError);
let last = bodies.at(-1); assert.equal(last.url, '/api/plugin/v1/prepare_operator_call'); check(last.body);
assert.deepEqual(last.body, { phone, purpose: 'Ask about hours', callerScript: 'x', language: 'en', maxDurationSec: 120, initiated_by: 'owner_request' });
// script + opening line forwarded camelCase; snake_case aliases normalised
await call({ phone, purpose: 'p', callerScript: 'You are Benchmark Tester.', openingLine: 'Hi, this is Benchmark Tester.' }); last = bodies.at(-1); check(last.body);
assert.deepEqual(last.body, { phone, purpose: 'p', callerScript: 'You are Benchmark Tester.', openingLine: 'Hi, this is Benchmark Tester.' });
await call({ phone, purpose: 'p', caller_script: 'S', opening_line: 'O' }); last = bodies.at(-1); check(last.body);
assert.deepEqual(last.body, { phone, purpose: 'p', callerScript: 'S', openingLine: 'O' });
// scenario path: scenario_id passed through, no empty purpose
assert(!(await call({ phone, scenario_id: 'A3' })).isError);
last = bodies.at(-1); check(last.body); assert.deepEqual(last.body, { phone, scenario_id: 'A3' });
// both passed through unchanged
await call({ phone, scenario_id: 'A1', purpose: 'goal' }); last = bodies.at(-1); check(last.body); assert.deepEqual(last.body, { phone, scenario_id: 'A1', purpose: 'goal' });
// neither -> local error, no network
const before = bodies.length;
assert((await call({ phone })).isError); assert((await call({ phone, purpose: 'x'.repeat(4001) })).isError); assert((await call({ phone, purpose: 'p', openingLine: 'x'.repeat(501) })).isError);
for (const bad of [{ openingLine: '' }, { callerScript: null }, { caller_script: '  ' }, { openingLine: '', opening_line: 'Hello' }, { callerScript: 'a', caller_script: 'b' }]) assert((await call({ phone, purpose: 'p', ...bad })).isError, JSON.stringify(bad));
assert.equal(bodies.length, before);
p.stdin.end(); srv.close(); console.log('operator prepare offline: ok');
