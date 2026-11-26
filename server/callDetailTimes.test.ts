/**
 * The call page's transcript, Messages and Logs clocks. call_turns.at and
 * call_events.at are timestamp WITHOUT time zone holding UTC; the detail route
 * reads them with a raw query, which returned a bare "2026-11-26 01:56:48"
 * that the browser read as local time, so every line read 8 hours off in
 * Pacific and the tool chips sorted above the first line (2026-11-26, call
 * CA393256052f139cbf4e5cd1d1ec4b4e2f: header 5:56 PM, transcript 1:56 AM).
 * Read from the source, as server/callLogShape.test.ts pins its routes.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const routes = fs.readFileSync(path.join(__dirname, 'routes.ts'), 'utf8');
const detail = routes.slice(routes.indexOf(`app.get('/api/call-logs/:id/detail'`), routes.indexOf('res.json({ callLog: normalizeCallLog(callLog), turns, events'));

describe('the call detail route returns each line and event time as an instant', () => {
  it('reads call_turns.at as UTC', () => {
    expect(detail).toContain('FROM call_turns');
    expect(detail).toMatch(/SELECT turn_index, role, \(at AT TIME ZONE 'UTC'\) AS at,/);
  });

  it('reads call_events.at as UTC', () => {
    expect(detail).toContain('FROM call_events');
    expect(detail).toMatch(/SELECT \(at AT TIME ZONE 'UTC'\) AS at, level, category, message, data/);
  });
});
