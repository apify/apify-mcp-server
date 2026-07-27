import { once } from 'node:events';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { HELPER_TOOLS } from '../../src/const.js';
import {
    createExpressApp,
    extractInitializeMessage,
    isStatelessRequest,
    parseInitializeParams,
} from '../../src/dev_server.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActors } from '../../src/utils/tools_loader.js';
import { makeArgsRecorderTool, readJsonRpcPayload, STATELESS_PROTOCOL_VERSION } from './helpers/mcp_server.js';

vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActors: vi.fn() };
});

const getActorsMock = vi.mocked(getActors);

/** The per-request `_meta` envelope that makes a request 2026-07-28 traffic. */
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: STATELESS_PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: { name: 'era-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
};

describe('extractInitializeMessage()', () => {
    it('matches a well-formed initialize request', () => {
        const body = {
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        };
        expect(extractInitializeMessage(body)).toEqual(body);
    });

    it('matches an initialize request with malformed params (regression: must still route to the initialize branch, not the session-id 400)', () => {
        const body = { method: 'initialize', params: { protocolVersion: 123 } };
        expect(extractInitializeMessage(body)).toEqual(body);
    });

    it('matches an initialize request with no params at all', () => {
        const body = { method: 'initialize' };
        expect(extractInitializeMessage(body)).toEqual(body);
    });

    it('matches inside a batched array body', () => {
        const body = [{ method: 'ping' }, { method: 'initialize', params: {} }];
        expect(extractInitializeMessage(body)).toEqual(body[1]);
    });

    it('returns undefined for a non-initialize request', () => {
        expect(extractInitializeMessage({ method: 'tools/list' })).toBeUndefined();
        expect(extractInitializeMessage(null)).toBeUndefined();
        expect(extractInitializeMessage('not an object')).toBeUndefined();
    });
});

describe('isStatelessRequest()', () => {
    const post = (body: unknown, headers: Record<string, string> = {}) => ({
        method: 'POST',
        url: '/',
        headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
        body,
    });

    it('routes a request carrying the per-request envelope to the stateless path', async () => {
        const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } };

        await expect(isStatelessRequest(post(body, { 'mcp-method': 'tools/list' }))).resolves.toBe(true);
    });

    it('keeps a claim-less initialize on the sessionful path', async () => {
        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
        };

        await expect(isStatelessRequest(post(body))).resolves.toBe(false);
    });

    it('keeps a claim-less follow-up request on the sessionful path', async () => {
        const body = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

        await expect(isStatelessRequest(post(body))).resolves.toBe(false);
    });

    it('keeps session operations on the sessionful path', async () => {
        // `express.json()` leaves an empty object behind on a body-less request.
        for (const method of ['GET', 'DELETE']) {
            await expect(
                isStatelessRequest({
                    method,
                    url: '/',
                    headers: { host: 'localhost', 'mcp-session-id': 'session-1' },
                    body: {},
                }),
            ).resolves.toBe(false);
        }
    });
});

describe('parseInitializeParams()', () => {
    it('parses well-formed params', () => {
        const params = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } };
        expect(parseInitializeParams(params)).toEqual(params);
    });

    it('returns undefined for malformed or missing params instead of throwing', () => {
        expect(parseInitializeParams({ protocolVersion: 123 })).toBeUndefined();
        expect(parseInitializeParams(undefined)).toBeUndefined();
    });
});

type DevServerResponse = { status: number; headers: Headers; body: string };
type PostFn = (path: string, body: unknown, headers?: Record<string, string>) => Promise<DevServerResponse>;

/** URL every case posts to: one endpoint for both eras, with telemetry off so nothing goes out. */
const DEV_URL = '/?telemetry-enabled=false';

/**
 * Runs `run` against the dev server's real Express app, listening on an ephemeral loopback port, so
 * era routing and the stateless branch behind it are exercised through the same POST route a client
 * hits. Nothing leaves the machine: `getActors` is mocked, so no Actor metadata is fetched.
 */
async function withDevServer<T>(run: (post: PostFn, port: number) => Promise<T>): Promise<T> {
    const httpServer: HttpServer = createExpressApp().listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const { port } = httpServer.address() as AddressInfo;
    try {
        return await run(async (path, body, headers = {}) => {
            const response = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    ...headers,
                },
                body: JSON.stringify(body),
            });
            return { status: response.status, headers: response.headers, body: await response.text() };
        }, port);
    } finally {
        // Keep-alive sockets otherwise hold close() open past the test timeout.
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    }
}

/** A 2026-07-28 request body plus the method/target headers the revision requires to match it. */
function statelessRequest(
    method: string,
    params: Record<string, unknown> = {},
    meta: Record<string, unknown> = {},
): { body: unknown; headers: Record<string, string> } {
    const headers: Record<string, string> = { 'mcp-method': method };
    if (typeof params.name === 'string') headers['mcp-name'] = params.name;
    return {
        body: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { ...ENVELOPE, ...meta } } },
        headers,
    };
}

describe('createExpressApp() era routing', () => {
    let previousLogLevel: number;

    beforeAll(() => {
        previousLogLevel = log.getLevel();
        log.setLevel(log.LEVELS.OFF);
    });

    afterAll(() => {
        log.setLevel(previousLogLevel);
    });

    beforeEach(() => {
        getActorsMock.mockResolvedValue([]);
    });

    afterEach(() => {
        getActorsMock.mockReset();
        vi.restoreAllMocks();
    });

    it('serves an envelope-carrying request from the stateless path', async () => {
        await withDevServer(async (post) => {
            const { body, headers } = statelessRequest('tools/list');

            const response = await post(DEV_URL, body, { ...headers, authorization: 'Bearer dev-token' });

            expect(response.status).toBe(200);
            // No session id: that header is the sessionful path's marker, and nothing was retained.
            expect(response.headers.get('mcp-session-id')).toBeNull();
            const tools = (readJsonRpcPayload(response.body).result?.tools ?? []) as { name: string }[];
            expect(tools.map((tool) => tool.name)).toContain(HELPER_TOOLS.ACTOR_CALL);
        });
    });

    it('rejects a non-localhost Origin', async () => {
        await withDevServer(async (post) => {
            const { body, headers } = statelessRequest('tools/list');

            const response = await post(DEV_URL, body, {
                ...headers,
                authorization: 'Bearer dev-token',
                origin: 'https://evil.example.com',
            });

            expect(response.status).toBe(403);
            expect(readJsonRpcPayload(response.body).error?.code).toBe(-32000);
        });
    });
    it('rejects a non-localhost Host', async () => {
        // The DNS-rebinding vector the Origin guard cannot see: a rebound hostname resolves here,
        // the browser sends no Origin, and the Host header carries the attacker's name. `fetch`
        // strips `Host` (a spec-forbidden header), so this probe goes through `node:http`.
        await withDevServer(async (_post, port) => {
            const { body, headers } = statelessRequest('tools/list');

            const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                const probe = httpRequest(
                    `http://127.0.0.1:${port}${DEV_URL}`,
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            accept: 'application/json, text/event-stream',
                            authorization: 'Bearer dev-token',
                            ...headers,
                            host: 'evil.example.com',
                        },
                    },
                    (res) => {
                        const chunks: Buffer[] = [];
                        res.on('data', (chunk) => chunks.push(chunk));
                        res.on('end', () =>
                            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
                        );
                    },
                );
                probe.on('error', reject);
                probe.end(JSON.stringify(body));
            });

            expect(response.status).toBe(403);
            expect(readJsonRpcPayload(response.body).error?.code).toBe(-32000);
        });
    });
    it('keeps a claim-less initialize on the sessionful path at the same endpoint', async () => {
        await withDevServer(async (post) => {
            const response = await post(
                DEV_URL,
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2025-06-18',
                        clientInfo: { name: 'legacy-client', version: '1.0.0' },
                        capabilities: {},
                    },
                },
                { authorization: 'Bearer dev-token' },
            );

            expect(response.status).toBe(200);
            expect(response.headers.get('mcp-session-id')).toBeTruthy();
            const { result } = readJsonRpcPayload(response.body);
            expect(result?.serverInfo).toBeDefined();
        });
    });

    it('passes the bearer token to the stateless adapter as auth info', async () => {
        const { tool, received } = makeArgsRecorderTool();
        getActorsMock.mockResolvedValue([tool]);

        await withDevServer(async (post) => {
            const { body, headers } = statelessRequest(
                'tools/call',
                { name: tool.name, arguments: {} },
                { apifyToken: 'client-supplied-token' },
            );

            const response = await post(DEV_URL, body, { ...headers, authorization: 'Bearer bearer-token' });

            expect(response.status).toBe(200);
            // The bearer the server extracted reached the adapter as `ctx.http.authInfo.token`, and
            // outranks the token the client wrote into its own `_meta`.
            expect(received.apifyToken).toBe('bearer-token');
        });
    });

    it('sends no auth info in payment mode, so the client-supplied token is used', async () => {
        const { tool, received } = makeArgsRecorderTool();
        getActorsMock.mockResolvedValue([tool]);

        await withDevServer(async (post) => {
            const { body, headers } = statelessRequest(
                'tools/call',
                { name: tool.name, arguments: {} },
                { apifyToken: 'client-supplied-token' },
            );

            const response = await post(`${DEV_URL}&payment=skyfire`, body, headers);

            expect(response.status).toBe(200);
            expect(received.apifyToken).toBe('client-supplied-token');
        });
    });

    it('rejects a header-mismatched request 400/-32020 even without a token', async () => {
        // SEP-2243: a framing rejection outranks auth. The body names `tools/list` while the
        // `Mcp-Method` header claims `tools/call`, and the request carries no token — the
        // standard-header cross-check must answer, not the 401 auth gate.
        await withDevServer(async (post) => {
            const { body } = statelessRequest('tools/list');

            const response = await post(DEV_URL, body, { 'mcp-method': 'tools/call' });

            expect(response.status).toBe(400);
            expect(readJsonRpcPayload(response.body).error?.code).toBe(-32020);
        });
    });

    it('answers a stateless request carrying no token with the sessionful 401', async () => {
        // The missing-token 401 is resolved inside the server factory — after the SDK's validation
        // ladder, to keep SEP-2243 ordering — and swapped in for the entry's 500 by the fetch
        // wrapper in `serveStatelessRequest`. The spy pins down that the sentinel throw is answered
        // as the auth 401, not logged as an exception the way a real 500 would be.
        const exceptionSpy = vi.spyOn(log, 'exception').mockImplementation(() => log);

        await withDevServer(async (post) => {
            const { body, headers } = statelessRequest('tools/list');

            const response = await post(DEV_URL, body, headers);

            expect(response.status).toBe(401);
            expect(readJsonRpcPayload(response.body).error?.code).toBe(-32001);
            expect(exceptionSpy).not.toHaveBeenCalled();
        });
    });
});
