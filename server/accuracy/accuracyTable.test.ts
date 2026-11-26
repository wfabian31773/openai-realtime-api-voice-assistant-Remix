/**
 * The table the app creates on its first run and the migration file that
 * writes it down must describe the same table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATE_INDEX_SQL, CREATE_TABLE_SQL } from './accuracy';

const strip = (sql: string) =>
  sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim();

describe('accuracy_check_results', () => {
  const migration = strip(readFileSync(join(__dirname, '../../migrations/add_accuracy_check_results.sql'), 'utf8'));

  it('the migration creates the table the app creates', () => {
    expect(migration).toContain(strip(CREATE_TABLE_SQL));
    expect(migration).toContain(strip(CREATE_INDEX_SQL));
  });
});
