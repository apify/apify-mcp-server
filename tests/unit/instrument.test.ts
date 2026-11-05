import { describe, expect, it, vi } from 'vitest';

const init = vi.hoisted(() => vi.fn());
vi.mock('@sentry/node', () => ({ init, startSession: vi.fn(), captureSession: vi.fn(), endSession: vi.fn() }));

describe('Sentry instrumentation', () => {
    it('drops the query string of HTTP breadcrumbs, which carries the Store search use case', async () => {
        await import('../../src/instrument.js');
        const { beforeBreadcrumb } = init.mock.calls[0][0];
        const data = { url: 'https://api.apify.com/v2/store', 'http.query': '?_useCase=private', status_code: 200 };
        expect(beforeBreadcrumb({ category: 'http', data }).data).toEqual({
            url: 'https://api.apify.com/v2/store',
            status_code: 200,
        });
        expect(beforeBreadcrumb({ category: 'console' })).toEqual({ category: 'console' });
    });
});
