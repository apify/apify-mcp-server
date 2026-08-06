import { defineConfig } from '@apify/oxlint-config';

export default defineConfig({
    ignorePatterns: [
        '**/dist',
        '**/.venv',
        '.claude/worktrees/**',
        'evals/*.ts',
        'evals/*.md',
        'evals/*.json',
        'src/web/**',
    ],
    overrides: [
        {
            files: ['**/*.spec.*', '**/*.test.*', '**/test/**', '**/tests/**', '**/integration_tests/**'],
            rules: {
                'vitest/no-conditional-expect': 'off',
                'jest/no-conditional-expect': 'off',
            },
        },
        {
            // src/test_kit/cases/*.cases.ts define `Case` objects whose `run(ctx)` is built via
            // the `withClient(options, testFn)` helper — `expect()` calls inside `testFn` really
            // do execute inside a real `it()` block (wired up by `registerCases` in register.ts),
            // but oxlint's static vitest rules can't trace that indirection and flag them as
            // standalone. False positive, not a real issue — see src/test_kit/register.ts.
            files: ['src/test_kit/**'],
            rules: {
                'vitest/no-standalone-expect': 'off',
                'vitest/expect-expect': 'off',
            },
        },
    ],
    options: {
        typeAware: true,
    },
});
