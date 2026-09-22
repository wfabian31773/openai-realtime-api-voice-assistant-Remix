/**
 * Read the literal strings out of a drizzle `sql` statement — TEST SUPPORT.
 *
 * `flushCallEvents` hands `db.execute` one `SQL` object per INSERT, and the
 * only way to assert WHICH events a flush actually wrote is to read the values
 * back out of it. Walks `queryChunks` (nested `SQL` for the VALUES list) and
 * collects every string it finds.
 *
 * Not imported by any production path; `.testkit.ts` so that is visible at the
 * import site.
 */
export function chunkStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const c of node) chunkStrings(c, out);
    return out;
  }
  const n = node as { value?: unknown; queryChunks?: unknown };
  if (n.value !== undefined) return chunkStrings(n.value, out);
  if (Array.isArray(n.queryChunks)) chunkStrings(n.queryChunks, out);
  return out;
}
