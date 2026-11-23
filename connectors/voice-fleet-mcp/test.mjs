// Offline unit checks + live READ-ONLY smoke test. Never calls prepare/commit/cancel.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mask, maskString, inCallingWindow } from './core.mjs';
assert.equal(maskString('call +1 (909) 555-0113 now'), 'call ***-***-0113 now');
assert.deepEqual(mask({ phone: '9095550113', firstName: 'A', nested: [{ dateOfBirth: 'x', note: 'x@y.com' }], confirmToken: 'abc' }), { phone: '***-***-0113', firstName: '[redacted]', nested: [{ dateOfBirth: '[redacted]', note: '[email]' }], confirmToken: '[redacted]' });
assert.equal(inCallingWindow(new Date('2026-10-27T16:00:00Z')), true);  // 9 AM PDT
assert.equal(inCallingWindow(new Date('2026-10-27T15:59:00Z')), false);
assert.equal(inCallingWindow(new Date('2026-10-28T03:00:00Z')), false); // 8 PM PDT
console.log('unit: ok');
const READS = ['health', 'list_agents', 'agent_health', 'fleet_today', 'recent_outcomes', 'outbound_status', 'email_replies'];
const p = spawn('node', [fileURLToPath(new URL('./server.mjs', import.meta.url))], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waits = new Map();
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
let n = 0; const rpc = (method, params) => new Promise((r) => { const id = ++n; waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2025-06-18' });
const { result } = await rpc('tools/list');
console.log('tools:', result.tools.map((t) => t.name).join(', '));
for (const t of READS) { const r = (await rpc('tools/call', { name: `voice_fleet_${t}`, arguments: {} })).result; console.log(`${t}: ${r.isError ? 'ERR' : 'OK'} ${r.content[0].text.slice(0, 160).replace(/\s+/g, ' ')}`); }
const ap = (await rpc('tools/call', { name: 'voice_fleet_approval_status', arguments: { id: '00000000-0000-0000-0000-000000000000' } })).result;
console.log(`approval_status(bogus): ${ap.isError ? 'ERR' : 'OK'} ${ap.content[0].text.slice(0, 160)}`);
p.stdin.end();
