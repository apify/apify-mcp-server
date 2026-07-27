// eslint-disable-next-line import/extensions
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['tests/unit/**/*.test.ts'],
                    testTimeout: 30_000,
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['tests/integration/**/*.test.ts'],
                    testTimeout: 120_000,
                },
            },
            {
                // TEMPORARY, AI-GENERATED, NOT HUMAN-MAINTAINED. Remove with tests/e2e/ when the
                // stateless migration (#1128) closes.
                // Opt-in only (`pnpm run test:e2e`); never add this project to CI.
                extends: true,
                test: {
                    name: 'e2e',
                    include: ['tests/e2e/**/*.test.ts'],
                    testTimeout: 300_000,
                    hookTimeout: 60_000,
                    maxConcurrency: Number(process.env.E2E_WORKERS ?? 6),
                },
            },
        ],
    },
});
