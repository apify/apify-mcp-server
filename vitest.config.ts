// eslint-disable-next-line import/extensions
import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.ts'],
        testTimeout: 60_000, // 1 minute
    },
});
