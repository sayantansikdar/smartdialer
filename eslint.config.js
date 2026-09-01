import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Determinism is the property the whole prototype rests on: every simulation must be
 * reproducible from its seed, and the test suite must be able to run a 10-minute campaign
 * in milliseconds. Both break the moment a module reads wall-clock time or schedules work
 * on a real timer instead of going through the injected `Clock`.
 *
 * That rule is impossible to enforce by review alone — a single stray `Date.now()` added
 * months from now would silently make runs non-reproducible — so it is enforced here.
 * `src/core/clock.ts` is the one place allowed to touch real time, because that is where
 * real time is deliberately converted into virtual time.
 */
const REAL_TIME_BAN = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use the injected Clock (clock.now()) — Date.now() breaks deterministic replay.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Use the injected Clock (clock.now()) — new Date() breaks deterministic replay.',
  },
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message: 'Use clock.setTimer() — setTimeout escapes the simulated clock.',
  },
  {
    selector: "CallExpression[callee.name='setInterval']",
    message: 'Use clock.setTimer() — setInterval escapes the simulated clock.',
  },
  {
    selector: "CallExpression[callee.property.name='random'][callee.object.name='Math']",
    message: 'Use the seeded Rng — Math.random() breaks deterministic replay.',
  },
];

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'web/dist/**', 'data/**', '*.db', '*.db-*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-syntax': ['error', ...REAL_TIME_BAN],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Structured errors carry typed metadata; `any` would defeat that.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // The clock is the boundary where real time is converted into virtual time, and the
    // dev launcher is a plain process supervisor that never touches dialer state.
    files: ['src/core/clock.ts', 'scripts/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Plain Node scripts. These are `.mjs` rather than `.ts` deliberately — they must run
    // before the typechecker is known to work — so they need Node's globals declared, which
    // the TypeScript files get from `@types/node` instead.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
  {
    // Tests may await real microtask/timer boundaries to force the `await` interleavings
    // that the concurrency suite exists to reproduce.
    files: ['tests/**'],
    rules: { 'no-restricted-syntax': ['error', ...REAL_TIME_BAN.filter((r) => !r.selector.includes('setTimeout'))] },
  },
  {
    /**
     * React hooks rules.
     *
     * Worth a dev dependency: a stale or missing dependency in a `useEffect` is invisible in
     * review and produces exactly the failure this dashboard cannot afford — a panel that
     * silently stops updating while still looking authoritative.
     */
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        EventSource: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
      },
    },
    // The browser renders server-computed state; it has no dialer logic and no
    // determinism requirement, so it may use ordinary timers and formatting dates.
    rules: { 'no-restricted-syntax': 'off' },
  },
);
