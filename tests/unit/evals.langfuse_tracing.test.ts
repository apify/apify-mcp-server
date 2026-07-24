import { describe, expect, it } from 'vitest';

import { getMissingLangfuseEnvVars, LANGFUSE_ENV_VARS } from '../../evals/workflows/langfuse_tracing.js';

describe('getMissingLangfuseEnvVars()', () => {
    it('reports all vars missing when the env is empty', () => {
        expect(getMissingLangfuseEnvVars({})).toEqual([...LANGFUSE_ENV_VARS]);
    });

    it('reports none missing when all are set', () => {
        expect(
            getMissingLangfuseEnvVars({
                LANGFUSE_PUBLIC_KEY: 'pk',
                LANGFUSE_SECRET_KEY: 'sk',
                LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
            }),
        ).toEqual([]);
    });

    it('treats whitespace/quote-only values as missing (sanitized to empty)', () => {
        expect(
            getMissingLangfuseEnvVars({
                LANGFUSE_PUBLIC_KEY: 'pk',
                LANGFUSE_SECRET_KEY: '  ',
                LANGFUSE_BASE_URL: '""',
            }),
        ).toEqual(['LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']);
    });
});
