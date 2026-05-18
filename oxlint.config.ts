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
    ],
    options: {
        typeAware: true,
    },
});
