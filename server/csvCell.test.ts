import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvCell } from './csvCell';

describe('a CSV cell a spreadsheet opens', () => {
  it('writes a cell that starts like a formula as text', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell('+cmd|calc')).toBe(`'+cmd|calc`);
    expect(csvCell('-2+3')).toBe(`'-2+3`);
    expect(csvCell('@SUM(A1:A9)')).toBe(`'@SUM(A1:A9)`);
    expect(csvCell('\t=1+1')).toBe(`'\t=1+1`);
    expect(csvCell('\r=1+1')).toBe(`"'\r=1+1"`);
  });

  it('leaves a phone number and a plain number alone', () => {
    expect(csvCell('+17145551234')).toBe('+17145551234');
    expect(csvCell('+1 (714) 555-1234')).toBe('+1 (714) 555-1234');
    expect(csvCell('-3')).toBe('-3');
    expect(csvCell(42)).toBe('42');
  });

  it('still quotes commas, quotes and line breaks, and writes nothing for null', () => {
    expect(csvCell('Pain, left eye')).toBe('"Pain, left eye"');
    expect(csvCell('said "now"')).toBe('"said ""now"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('Eye pain')).toBe('Eye pain');
  });

  it('is what the urgent-calls export writes its cells with', () => {
    const routes = readFileSync(join(__dirname, 'routes.ts'), 'utf8');
    const start = routes.indexOf("'/api/call-logs/urgent/export'");
    expect(start).toBeGreaterThan(-1);
    const body = routes.slice(start, routes.indexOf('res.send(csv)', start));
    expect(body).toContain("const { csvCell: csvEscape } = await import('./csvCell')");
    expect(body).not.toMatch(/function csvEscape/);
  });
});
