import type { AxiosRequestConfig } from 'axios';
import { ProxyAgent } from 'proxy-agent';
import { describe, expect, it } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';

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
    it('uses one proxy-aware agent across clients and protocols with keep-alive and a 15 s timeout', async () => {
        const first = await captureRequestConfig(new ApifyClient({ token: 'token-a' }));
        const second = await captureRequestConfig(new ApifyClient({ token: 'token-b' }));

        expect(first.httpsAgent).toBeInstanceOf(ProxyAgent);
        expect(first.httpAgent).toBe(first.httpsAgent);
        expect(second.httpsAgent).toBe(first.httpsAgent);
        expect(second.httpAgent).toBe(first.httpAgent);
        // apify-client's own agent keeps free sockets for the whole 360 s request timeout.
        expect((first.httpsAgent as ProxyAgent).connectOpts).toMatchObject({ keepAlive: true, timeout: 15_000 });
    });
});
