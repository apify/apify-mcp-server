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
                    // The suite tests the `/v2/store` path; tests of `/unstable/store` turn the flag on themselves.
                    env: { APIFY_STORE_UNSTABLE_ENDPOINT: '' },
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
        ],
    },
});
