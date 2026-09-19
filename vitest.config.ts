import { defineConfig } from 'vitest/config';

/**
 * WHY THIS FILE EXISTS: `npm test` reported 113 failures that were not real.
 *
 * There was no vitest config at all, so the defaults applied — and on 2026-09-17
 * a bare `npx vitest run` collected the compiled copy of the suite under
 * `dist/`, left by a `tsc -p .` build the day before. Those copies resolve
 * their fixtures relative to `dist/`, so they fail with ENOENT on paths like
 * `dist/src/agents/surgeryAgent.ts` — 36 files and 113 tests of pure noise from
 * a build artifact `.gitignore` already ignores.
 *
 * The cost was not the red. It was that the red meant NOTHING, so a real
 * regression could not be told apart from the pile — and a suite you cannot
 * read is the same as no suite. The identical run with `dist` excluded is
 * 230 files / 4,436 tests, all green.
 *
 * ONLY `exclude` IS SET, DELIBERATELY. An earlier draft also pinned `include`
 * to `src/**` and `scripts/**` and silently dropped 17 files / 226 tests —
 * every test under `server/` and `client/`. Narrowing what gets collected is
 * how a suite quietly stops covering things, which is the same failure as the
 * one this file is fixing, pointed the other way. The defaults find the tests;
 * this only keeps the build output out.
 */
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // PHI lives here and nothing in it is a test, but both directories are
      // gitignored and can hold anything, so they are named rather than
      // trusted to contain no *.test.* file.
      'replay-corpus/**',
      'replay-out/**',
    ],
  },
});
