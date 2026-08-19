/** ApifyClient: request-origin header + baseUrl override. */
import { describe, expect, it, vi } from 'vitest';

import { ApifyClient, REQUEST_ORIGIN } from '../../src/apify_client.js';

const { capturedOptions } = vi.hoisted(() => ({ capturedOptions: [] as unknown[] }));

vi.mock('apify-client', () => ({
    ApifyClient: class {
        constructor(options: unknown) {
            capturedOptions.push(options);
        }
    },
}));

type RequestConfig = { headers: Record<string, string> };
type CapturedClientOptions = {
    requestInterceptors: ((config: RequestConfig) => RequestConfig)[];
    baseUrl: string;
};

/** Builds a client and runs its request interceptor to get the headers sent with every request. */
function buildStaticHeaders(options: ConstructorParameters<typeof ApifyClient>[0]): Record<string, string> {
    capturedOptions.length = 0;
    void new ApifyClient(options);
    const passed = capturedOptions[0] as CapturedClientOptions;
    return passed.requestInterceptors[0]({ headers: {} }).headers;
}

/** baseUrl passed to the underlying apify-client. */
function buildBaseUrl(options: ConstructorParameters<typeof ApifyClient>[0]): string {
    capturedOptions.length = 0;
    void new ApifyClient(options);
    return (capturedOptions[0] as CapturedClientOptions).baseUrl;
}

describe('ApifyClient', () => {
    it('sends the MCP request origin by default', () => {
        const headers = buildStaticHeaders({ token: 'test-token' });
        expect(headers['X-Apify-Request-Origin']).toBe('MCP');
    });

    it('sends the given request origin', () => {
        const headers = buildStaticHeaders({ token: 'test-token', requestOrigin: REQUEST_ORIGIN.APIFY_AI });
        expect(headers['X-Apify-Request-Origin']).toBe('APIFY_AI');
    });

    it('keeps payment headers alongside origin', () => {
        const headers = buildStaticHeaders({
            paymentHeaders: { 'skyfire-pay-id': 'jwt-token-123' },
            requestOrigin: REQUEST_ORIGIN.APIFY_AI,
        });
        expect(headers['skyfire-pay-id']).toBe('jwt-token-123');
        expect(headers['X-Apify-Request-Origin']).toBe('APIFY_AI');
    });

    it('explicit baseUrl wins over env default', () => {
        const original = process.env.APIFY_API_BASE_URL;
        process.env.APIFY_API_BASE_URL = 'https://api.apify.com';
        try {
            expect(buildBaseUrl({ token: 'test-token', baseUrl: 'http://localhost:3333' })).toBe(
                'http://localhost:3333',
            );
        } finally {
            if (original === undefined) delete process.env.APIFY_API_BASE_URL;
            else process.env.APIFY_API_BASE_URL = original;
        }
    });
});
