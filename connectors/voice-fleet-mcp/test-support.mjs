// Test-only mock transport: no sockets, token files, or external network.
import { createVoiceFleetMcp } from './core.mjs';
export function mockFleet(handler) {
  const seen = [];
  const bearer = `si.${'a'.repeat(32)}.${'b'.repeat(64)}`;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname.replace('/api/plugin/v1', '') + new URL(url).search;
    const request = { method: options.method, path, body: options.body ? JSON.parse(options.body) : undefined, authorization: options.headers.Authorization };
    seen.push(request);
    if (request.authorization !== `Bearer ${bearer}`) throw new Error('wrong fake bearer');
    const [status, body] = handler(request);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const core = createVoiceFleetMcp({ baseUrl: 'http://127.0.0.1:5000', getToken: () => bearer });
  let id = 0;
  const rpc = (method, params) => core.handleMessage({ jsonrpc: '2.0', id: ++id, method, params });
  const call = async (name, args = {}) => (await rpc('tools/call', { name: `voice_fleet_${name}`, arguments: args })).result;
  return { seen, rpc, call };
}
