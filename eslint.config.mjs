/**
 * ESLint Configuration
 *
 * This configuration follows the apify-core style and uses the shared @apify/eslint-config package.
 * It follows the shared config as much as possible, only adding project-specific overrides where necessary.
 *
 * The shared config provides:
 * - Import ordering via simple-import-sort/imports (groups: side effects, node:, external, @apify/, @apify-packages/, relative)
 * - max-len rule (160 chars, ignores URLs and template literals)
 * - TypeScript-specific rules and best practices
 *
 * Project-specific overrides:
 * - import/no-extraneous-dependencies: Adds vitest.config.ts and evals/** patterns
 * - @typescript-eslint/consistent-type-definitions: Prefers 'interface' over 'type'
 * - import/no-default-export: Allows default exports in config files
 */
import apifyTypeScriptConfig from '@apify/eslint-config/ts.js';

export default [
    {
        // Ignores must be defined first in flat config format
        // These directories/files are excluded from linting
        ignores: [
            '**/dist', // Build output directory
            '**/.venv', // Python virtual environment (if present)
            'evals/**', // Evaluation scripts directory
        ],
    },
    // Apply the shared Apify TypeScript ESLint configuration
    // This includes TypeScript-specific rules, import ordering, and other best practices
    ...apifyTypeScriptConfig,
    {
        rules: {
            // Prevent importing devDependencies in production code
            // This helps catch accidental imports of test/build tools in source code
            'import/no-extraneous-dependencies': [
                'error',
                {
                    // Allow importing devDependencies in these specific file patterns:
                    devDependencies: [
                        '**/eslint.config.mjs', // ESLint config files
                        '**/vitest.config.ts', // Vitest config files
                        '**/*.test.{js,ts,jsx,tsx}', // Test files
                        '**/{test,tests}/**/*.{js,ts,jsx,tsx,mjs,mts,cjs,cts}', // Test directories
                        'evals/**/*.{js,ts,jsx,tsx,mjs,mts,cjs,cts}', // Evaluation scripts
                    ],
                },
            ],
        },
        languageOptions: {
            // Use ES modules (import/export syntax)
            sourceType: 'module',
            parserOptions: {
                // Use the ESLint-specific tsconfig that includes test files
                // This ensures TypeScript-aware linting works for all files
                project: './tsconfig.eslint.json',
            },
        },
    },
    // TypeScript-specific rules (applied only to .ts files)
    // These rules require the @typescript-eslint plugin which is included in apifyTypeScriptConfig
    {
        files: ['**/*.ts', '**/*.tsx'],
        rules: {
            // Prefer 'interface' over 'type' for object type definitions
            // Interfaces can be extended and merged, making them more flexible
            // Note: This matches apify-core CONTRIBUTING.md guidance
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
        },
    },
    // Override rules for configuration files
    // Config files (like this one) typically use default exports, which is acceptable
    {
        files: ['**/eslint.config.mjs', '**/vitest.config.ts'],
        rules: {
            // Allow default exports in config files (standard practice for config files)
            'import/no-default-export': 'off',
        },
    },
];
