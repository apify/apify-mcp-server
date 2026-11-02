import type { AxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient, FREE_SOCKET_TIMEOUT_MILLIS, sharedAgents } from '../../src/apify_client.js';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

/** Captures the final request config of one call instead of sending it, through the real interceptor chain. */
async function captureRequestConfig(client: ApifyClient): Promise<AxiosRequestConfig> {
    let captured: AxiosRequestConfig | undefined;
    client.httpClient.axios.defaults.adapter = async (config) => {
        captured = config;
        // apify-client requests `arraybuffer` and parses JSON from it by content type.
        return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            config,
            data: Buffer.from(JSON.stringify({ data: { id: 'me' } })),
        };
    };
    await client.user('me').get();
    return captured!;
}

describe('every client sends through one keep-alive pool', () => {
    it('two instances share the same agents, with free sockets closed after the idle timeout', async () => {
        const first = await captureRequestConfig(new ApifyClient({ token: 'token-a' }));
        const second = await captureRequestConfig(new ApifyClient({ token: 'token-b' }));

        expect(first.httpsAgent).toBe(sharedAgents!.httpsAgent);
        expect(second.httpsAgent).toBe(first.httpsAgent);
        expect(second.httpAgent).toBe(first.httpAgent);
        expect(first.httpsAgent.options).toMatchObject({ keepAlive: true, timeout: FREE_SOCKET_TIMEOUT_MILLIS });
    });

    it('leaves apify-client its own proxy-aware agent when a proxy is configured', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal:3128');
        const proxied = await import('../../src/apify_client.js');
        const client = new proxied.ApifyClient({ token: 'token-a' });

        const config = await captureRequestConfig(client);

        expect(proxied.sharedAgents).toBeUndefined();
        expect(config.httpsAgent).toBe(client.httpClient.httpsAgent);
    });
});
