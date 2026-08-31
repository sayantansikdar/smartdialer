import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the two halves of this repository have genuinely different
 * TypeScript configurations: the backend runs under Node's type stripping with NodeNext
 * resolution, the frontend is bundled with DOM types. Running them as one project would
 * force one of them to typecheck against the wrong lib.
 *
 * Both run in a Node environment. The frontend tests deliberately cover its *logic* — form
 * validation, route parsing, the API client's error handling, the bounded event buffer — and
 * not its markup. Asserting the shape of rendered JSX tests the test, not the application;
 * what the dashboard's components actually do is verified by driving a real browser against
 * the running system (TEST_CHECKLIST.md rows 39–53).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          // Each suite builds its own in-memory SQLite database and its own clock, so files
          // are independent — forks keep each file's native sqlite handles isolated.
          pool: 'forks',
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'web',
          include: ['web/tests/**/*.test.ts'],
          environment: 'node',
          testTimeout: 10_000,
        },
      },
    ],
    reporters: ['default'],
  },
});
