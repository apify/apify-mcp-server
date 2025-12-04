/**
 * ESLint Configuration
 *
 * This configuration follows the apify-core style and uses the shared @apify/eslint-config package.
 * It enforces consistent code style, TypeScript best practices, and import organization.
 *
 * Key changes from previous version:
 * - Updated to @apify/eslint-config@1.1.0 (from 1.0.0) for latest rules and improvements
 * - Added import/no-extraneous-dependencies rule to prevent importing devDependencies in production code
 * - Added exception for config files to allow default exports (ESLint configs typically use default exports)
 * - Uses flat config format (ESLint 9+) which is more flexible and maintainable
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
            // Enforce maximum line length (matches EditorConfig max_line_length = 160)
            // This improves code readability and consistency
            'max-len': [
                'error',
                {
                    code: 160,
                    ignoreUrls: true, // Allow long URLs
                    ignoreComments: true, // Allow long comments
                    ignoreStrings: true, // Allow long strings (often contain URLs or user-facing text)
                    ignoreTemplateLiterals: true, // Allow long template literals
                },
            ],
            // Enforce consistent import ordering and grouping
            // Groups: builtin -> external -> parent/sibling -> index -> object
            // Alphabetizes within groups and requires newlines between groups
            // This improves code organization and makes imports easier to scan
            'import/order': [
                'error',
                {
                    'groups': ['builtin', 'external', ['parent', 'sibling'], 'index', 'object'],
                    'alphabetize': {
                        'order': 'asc',
                        'caseInsensitive': true,
                    },
                    'newlines-between': 'always',
                },
            ],
            // Enforce consistent quote style for object properties
            // Prevents mixing quoted and unquoted property names unnecessarily
            'quote-props': ['error', 'consistent'],
            // Disable simple-import-sort since we're using import/order instead
            // This prevents conflicts between the two import sorting rules
            'simple-import-sort/imports': 'off',
            'simple-import-sort/exports': 'off',
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
