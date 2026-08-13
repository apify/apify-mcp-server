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
            // Case.run() executes inside a real it() via registerCases (register.ts) — oxlint
            // can't trace that indirection, so expect() calls in Case.run bodies read as
            // standalone. register.ts itself disables vitest/expect-expect per runIt() call.
            files: ['tests/test_kit/**'],
            rules: {
                'vitest/no-standalone-expect': 'off',
            },
        },
    ],
    options: {
        typeAware: true,
    },
});
