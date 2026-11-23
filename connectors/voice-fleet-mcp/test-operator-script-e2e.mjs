// MCP tool input -> forwarded body -> Remix parseOperatorPayload + operatorOpeningSource (needs REMIX_DIR checkout + tsx).
import assert from 'node:assert';
import { operatorPrepareBody } from './server.mjs';
import { execFileSync } from 'node:child_process';
const REMIX = process.env.REMIX_DIR || '/workspace/rx-op413';
const input = { phone: '+19095550143', purpose: 'Synthetic QA', callerScript: 'You are Benchmark Tester asking about an upcoming appointment.', openingLine: 'Hi, this is Benchmark Tester, I have a question about my upcoming appointment.', language: 'en', maxDurationSec: 240 };
const run = (body) => JSON.parse(execFileSync('npx', ['tsx', '-e', `
import { parseOperatorPayload } from "./src/plugin/operatorLine";
import { operatorOpeningSource, operatorOpening } from "./src/agents/operatorLineAgent";
const p = parseOperatorPayload(${JSON.stringify(body)});
if ("error" in p) { console.log(JSON.stringify({ error: p.error })); } else console.log(JSON.stringify({ source: operatorOpeningSource(p.payload ?? p), text: operatorOpening(p.payload ?? p) }));`], { cwd: REMIX, encoding: 'utf8' }).trim().split('\n').pop());
let r = run(operatorPrepareBody(input));
assert.deepEqual(r, { source: 'openingLine', text: input.openingLine });
const { openingLine, ...scriptOnly } = input;
r = run(operatorPrepareBody(scriptOnly)); assert.equal(r.source, 'callerScript');
console.log('operator script e2e: ok'); process.exit(0);
