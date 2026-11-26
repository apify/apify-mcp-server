/** ApifyClient: request headers, base URLs, the capped raw request and the proxy route. */
import { createServer, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ApifyClient,
    getApifyAPIPublicBaseUrl,
    readBodyToCap,
    REQUEST_ORIGIN,
    ResponseTooLargeError,
    runWithForwardedApiHeaders,
    sendApifyApiRequest,
} from '../../src/apify_client.js';
import { MAX_INLINE_BYTES, STAGING_MCP_HOSTNAME } from '../../src/const.js';
import { jsonResponse, stubFetch } from './helpers/fetch_stub.js';

type ClientOptions = ConstructorParameters<typeof ApifyClient>[0];

/** The headers the client sends with one request to `url`; `fetch` is stubbed. */
async function sendAndReadHeaders(options: ClientOptions, url = 'https://api.apify.com/v2/users/me'): Promise<Headers> {
    const { requests } = stubFetch();
    await new ApifyClient(options).httpClient.call({ url, method: 'GET' });
    return requests[0].headers;
}

describe('ApifyClient', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('sends the MCP request origin by default', async () => {
        const headers = await sendAndReadHeaders({ token: 'test-token' });
        expect(headers.get('X-Apify-Request-Origin')).toBe('MCP');
    });

    it('sends the given request origin', async () => {
        const headers = await sendAndReadHeaders({ token: 'test-token', requestOrigin: REQUEST_ORIGIN.APIFY_AI });
        expect(headers.get('X-Apify-Request-Origin')).toBe('APIFY_AI');
    });

    it('sends the token and names this server in the User-Agent', async () => {
        const headers = await sendAndReadHeaders({ token: 'test-token' });
        expect(headers.get('Authorization')).toBe('Bearer test-token');
        expect(headers.get('User-Agent')).toMatch(/^ApifyClient\/.*Origin\/mcp-server$/);
    });

    it('sends forwarded headers only inside runWithForwardedApiHeaders', async () => {
        const forwarded = { 'x-apify-admin-ip-proof': 'proof' };
        // The request goes to the client's API origin, whatever APIFY_API_BASE_URL is.
        const options = { token: 'test-token', baseUrl: 'https://api.apify.com' };
        const inside = await runWithForwardedApiHeaders(forwarded, async () => sendAndReadHeaders(options));
        expect(inside.get('x-apify-admin-ip-proof')).toBe('proof');
        expect((await sendAndReadHeaders(options)).has('x-apify-admin-ip-proof')).toBe(false);
    });

    it('keeps the request origin when a forwarded header names another', async () => {
        const headers = await runWithForwardedApiHeaders({ 'x-apify-request-origin': 'CONSOLE' }, async () =>
            sendAndReadHeaders({ token: 'test-token', baseUrl: 'https://api.apify.com' }),
        );
        expect(headers.get('X-Apify-Request-Origin')).toBe('MCP');
    });

    it('keeps forwarded headers off a request to an Actor server', async () => {
        // The client also sends requests to an Actor's standby origin, which is not the API.
        const headers = await runWithForwardedApiHeaders({ 'x-apify-admin-ip-proof': 'proof' }, async () =>
            sendAndReadHeaders({ token: 'test-token' }, 'https://apify--web-fetch.apify.actor/fetch'),
        );
        expect(headers.has('x-apify-admin-ip-proof')).toBe(false);
    });

    it('explicit baseUrl wins over env default', () => {
        vi.stubEnv('APIFY_API_BASE_URL', 'https://api.apify.com');
        const client = new ApifyClient({ token: 'test-token', baseUrl: 'http://localhost:3333' });
        expect(client.baseUrl).toBe('http://localhost:3333/v2');
    });

    it('passes the client-facing origin as publicBaseUrl, separately from the egress baseUrl', () => {
        vi.stubEnv('APIFY_API_BASE_URL', 'http://api.internal.example:3333');
        const client = new ApifyClient({ token: 'test-token' });
        expect(client.baseUrl).toBe('http://api.internal.example:3333/v2');
        expect(client.publicBaseUrl).toBe('https://api.apify.com/v2');
    });
});

describe('sendApifyApiRequest()', () => {
    afterEach(() => vi.unstubAllGlobals());

    const URL_TO_READ = 'https://api.apify.com/v2/datasets/a1B2c3D4e5F6g7H8i/items';

    /** A response whose body arrives in chunks of 64 KiB. */
    function chunkedResponse(bytes: number, contentType = 'application/octet-stream'): Response {
        const chunk = new Uint8Array(64 * 1024);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent >= bytes) return controller.close();
                const size = Math.min(chunk.byteLength, bytes - sent);
                sent += size;
                return controller.enqueue(chunk.subarray(0, size));
            },
        });
        return new Response(body, { headers: { 'content-type': contentType } });
    }

    it.each([
        ['reads a body of exactly MAX_INLINE_BYTES whole', MAX_INLINE_BYTES, false],
        ['cuts a longer body at MAX_INLINE_BYTES', MAX_INLINE_BYTES + 1, true],
    ])('%s', async (_name, bytes, isTruncated) => {
        stubFetch(() => chunkedResponse(bytes));
        const client = new ApifyClient({ token: 'test-token' });

        const response = await sendApifyApiRequest<ReadableStream<Uint8Array>>(client, {
            url: URL_TO_READ,
            method: 'GET',
            responseType: 'stream',
        });
        const read = await readBodyToCap(response);

        expect(read.isTruncated).toBe(isTruncated);
        expect(read.body.byteLength).toBe(MAX_INLINE_BYTES);
    });

    it('rejects a parsed response over the limit with its status and headers', async () => {
        stubFetch(() => chunkedResponse(MAX_INLINE_BYTES + 1, 'application/zip'));
        const client = new ApifyClient({ token: 'test-token' });

        const error = await sendApifyApiRequest(client, { url: URL_TO_READ, method: 'GET' }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ResponseTooLargeError);
        expect(error).toMatchObject({ responseStatus: 200, responseHeaders: { 'content-type': 'application/zip' } });
    });

    it('leaves the responses of other requests uncapped', async () => {
        stubFetch(() => chunkedResponse(MAX_INLINE_BYTES + 1));
        const client = new ApifyClient({ token: 'test-token' });

        const { data } = await client.httpClient.call<Uint8Array>({ url: URL_TO_READ, method: 'GET' });

        expect(data.byteLength).toBe(MAX_INLINE_BYTES + 1);
    });

    it('sends once and resolves an error status, which the client would retry and throw', async () => {
        const { requests } = stubFetch(() => jsonResponse({ error: { type: 'internal', message: 'Oops' } }, 500));
        const client = new ApifyClient({ token: 'test-token' });

        const response = await sendApifyApiRequest(client, { url: URL_TO_READ, method: 'GET' });

        expect(response.status).toBe(500);
        expect(requests).toHaveLength(1);
    });
});

describe('proxy environment variables', () => {
    afterEach(() => vi.unstubAllEnvs());

    /** Closes the server and the sockets a tunnel keeps open. */
    async function close(server: Server): Promise<void> {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const listen = async (server: Server): Promise<number> =>
        new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

    it('sends requests through the proxy that HTTP_PROXY names', async () => {
        const api = createServer((_req, res) => res.setHeader('content-type', 'text/plain').end('through the proxy'));
        const apiPort = await listen(api);
        // A forward proxy: undici asks it for a tunnel to the target.
        const tunnels: (string | undefined)[] = [];
        const sockets: Duplex[] = [];
        const proxy = createServer().on('connect', (req, clientSocket) => {
            tunnels.push(req.url);
            const upstream = connect(apiPort, '127.0.0.1', () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                upstream.pipe(clientSocket).pipe(upstream);
            });
            sockets.push(upstream, clientSocket);
        });
        vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${await listen(proxy)}`);
        vi.stubEnv('NO_PROXY', '');
        vi.stubEnv('NODE_USE_ENV_PROXY', '');
        // The proxy connection pool is created once per process, so the module is loaded fresh.
        vi.resetModules();
        const { ApifyClient: FreshApifyClient } = await import('../../src/apify_client.js');
        const baseUrl = `http://127.0.0.1:${apiPort}`;

        try {
            const client = new FreshApifyClient({ token: 'test-token', baseUrl, maxRetries: 0 });
            const { data } = await client.httpClient.call<string>({ url: `${baseUrl}/v2/users/me`, method: 'GET' });

            expect(data).toBe('through the proxy');
            expect(tunnels).toEqual([`127.0.0.1:${apiPort}`]);
        } finally {
            for (const socket of sockets) socket.destroy();
            await close(proxy);
            await close(api);
        }
    });
});

describe('getApifyAPIPublicBaseUrl()', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each([
        // The hosted server reaches the API through a host clients cannot resolve; what clients see must not follow it.
        [
            'production, whatever APIFY_API_BASE_URL is',
            { APIFY_API_BASE_URL: 'http://api.internal.example:3333' },
            'https://api.apify.com',
        ],
        [
            'the staging API on the staging MCP host',
            { HOSTNAME: STAGING_MCP_HOSTNAME },
            'https://api-securitybyobscurity.apify.com',
        ],
        [
            'the APIFY_API_PUBLIC_BASE_URL override, over the staging host',
            { HOSTNAME: STAGING_MCP_HOSTNAME, APIFY_API_PUBLIC_BASE_URL: 'http://localhost:3333' },
            'http://localhost:3333',
        ],
    ])('returns %s', (_case, env, expected) => {
        for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
        expect(getApifyAPIPublicBaseUrl()).toBe(expected);
    });
});
