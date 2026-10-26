import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, MAX_INLINE_BYTES, TOOL_STATUS } from '../../src/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import {
    executeSendServerActorRequest,
    RECOVERY_MAX_OPERATIONS,
    sendServerActorRequest,
} from '../../src/tools/actors/send_server_actor_request.js';
import { serverActorRequestOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { Actor, ActorDefinitionPruned, HelperTool, ToolTelemetryContext } from '../../src/types.js';
import { ACTOR_TENANCY, ALL_TOOLS_PRESENT, SERVER_MODE } from '../../src/types.js';
import { mockActor } from './helpers/actor_build_client.js';
import { getRequestHandler, makePaymentProvider, withServer } from './helpers/mcp_server.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    only,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const TOKEN = 'test-token';
const SERVER_ACTOR = 'apify/server-actor-test';

type ReceivedRequest = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
type ToolResult = TextToolResult & { toolTelemetry?: ToolTelemetryContext };

/** Where the local Actor server records requests; `recordRequests` gives each test its own list. */
let recording: ReceivedRequest[] = [];
let server: Server;
let standbyUrl: string;

/**
 * The fixture endpoints the tool is specified against (DEVELOPMENT.md), served locally. `/status/{code}` echoes
 * the Authorization header, which the real router strips, so the error-body masking can be checked here.
 */
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    recording.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const url = new URL(req.url!, standbyUrl);
    const n = Number(url.searchParams.get('n'));
    switch (url.pathname) {
        case '/echo':
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({ query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null }),
            );
            return;
        case '/fetch':
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    code: 'NOT_FOUND',
                    error: 'There is nothing at route GET /fetch. A "url" query parameter is required.',
                }),
            );
            return;
        case '/escaped-error-token':
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: TOKEN }).replace('test-token', '\\u0074est-token'));
            return;
        case '/text-error':
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('The "url" query parameter is required.');
            return;
        case '/bytes':
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(Buffer.alloc(n, 'a'));
            return;
        case '/gzip':
            res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
            res.end(gzipSync(Buffer.alloc(n, 'a')));
            return;
        case '/empty':
            res.writeHead(204);
            res.end();
            return;
        case '/latin1':
            res.writeHead(200, { 'content-type': 'text/plain; note=example; CHARSET="ISO-8859-1"' });
            res.end(Buffer.from('café', 'latin1'));
            return;
        case '/utf16-token':
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-16le' });
            res.end(Buffer.from(TOKEN, 'utf16le'));
            return;
        case '/unsupported-charset':
            res.writeHead(200, { 'content-type': 'text/plain; charset=unsupported-encoding' });
            res.end('café');
            return;
        case '/binary':
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(Buffer.from([0, 1, 2]));
            return;
        case '/redirect':
            res.writeHead(302, { location: '/echo' });
            res.end();
            return;
        case '/reflect-token': {
            const token = req.headers.authorization!.slice('Bearer '.length);
            res.writeHead(302, { location: `/login?token=${token}`, 'content-type': `text/plain; note=${token}` });
            res.end();
            return;
        }
        case '/drop-before-status':
            req.socket.destroy();
            return;
        case '/truncate':
            res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' });
            // Closed once the start of the body is on the wire, so the client has the status.
            res.write('abc', () => res.destroy());
            return;
        case '/drip':
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('a');
            await sleep(Number(url.searchParams.get('ms')));
            res.end('b');
            return;
        default: {
            const status = Number(url.pathname.slice('/status/'.length));
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ code: status, authorization: req.headers.authorization }));
        }
    }
}

/** Puts a public Actor with Actor Standby on and an API schema into the definition cache, so no API read is needed. */
function seedActor(
    name: string,
    overrides: { actor?: Partial<Actor>; definition?: Partial<ActorDefinitionPruned> } = {},
): void {
    const [username, actorName] = name.split('/');
    const info = mockActor({
        id: `${actorName}-id`,
        username,
        name: actorName,
        isPublic: true,
        standbyUrl,
        actorStandby: { isEnabled: true, tenancy: 'SINGLE_TENANT' },
        ...overrides.actor,
    });
    const definition: ActorDefinitionPruned = {
        id: info.id,
        actorFullName: name,
        buildTag: 'latest',
        readme: '',
        description: '',
        defaultRunOptions: { build: 'latest', memoryMbytes: 256, timeoutSecs: 300 },
        input: {
            type: 'object',
            properties: { firstNumber: { type: 'integer', title: 'First number', description: '' } },
        },
        hasWebServerSchema: true,
        ...overrides.definition,
    };
    actorDefinitionCache.set(name, { definition, info });
}

/** Starts a fresh list of the requests the local Actor server gets, for the calling test. */
function recordRequests(): ReceivedRequest[] {
    recording = [];
    return recording;
}

// The real client: the request goes through apify-client's axios instance, as in production.
const client = new ApifyClient({ token: TOKEN });

async function callTool(
    args: Record<string, unknown>,
    options: {
        loadedToolNames?: string[];
        timeoutMillis?: number;
        signal?: AbortSignal;
        apifyClient?: ApifyClient;
    } = {},
): Promise<ToolResult> {
    const context = stubToolCallContext(
        { actor: SERVER_ACTOR, method: 'GET', ...args },
        options.apifyClient ?? client,
        {
            loadedToolNames: options.loadedToolNames,
        },
    );
    if (options.signal) context.signal = options.signal;
    return (await executeSendServerActorRequest(context, { timeoutMillis: options.timeoutMillis })) as ToolResult;
}

async function dispatchTool(
    args: Record<string, unknown>,
    options: Parameters<typeof withServer>[1] = {},
): Promise<Record<string, unknown>> {
    return withServer(
        async (mcpServer) => {
            mcpServer.upsertTools([sendServerActorRequest]);
            return getRequestHandler(mcpServer, 'tools/call')(
                {
                    method: 'tools/call',
                    params: {
                        name: HELPER_TOOLS.ACTOR_SERVER_REQUEST,
                        arguments: { actor: SERVER_ACTOR, method: 'POST', path: '/echo', ...args },
                        _meta: { mcpSessionId: 's1' },
                    },
                },
                { signal: new AbortController().signal, sendNotification: vi.fn() },
            );
        },
        { token: TOKEN, ...options },
    );
}

beforeAll(async () => {
    server = createServer((req, res) => void serve(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    standbyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    seedActor(SERVER_ACTOR);
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('sending the request', () => {
    it('sends the token, the request origin and the JSON body as is, once', async () => {
        const received = recordRequests();
        // Over 1 KiB: apify-client compresses a string body this large, which the Actor server would then get.
        const body = { pad: 'x'.repeat(2000) };

        await callTool({ method: 'POST', path: '/echo', body });

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ method: 'POST', url: '/echo', body: JSON.stringify(body) });
        expect(received[0].headers).toMatchObject({
            authorization: `Bearer ${TOKEN}`,
            'x-apify-request-origin': 'MCP',
            'content-type': 'application/json',
        });
        expect(received[0].headers['content-encoding']).toBeUndefined();
    });

    it('preserves scalar queries and JSON bodies through dispatch while stripping unknown keys', async () => {
        const received = recordRequests();
        const args = {
            path: '/echo?from=a%20path',
            query: { n: 1, asText: true, flag: false, label: 'apify' },
            body: { values: [null, 2, true, 'apify'] },
            extra: 'client metadata',
        };

        const result = await dispatchTool(args);

        expect(result.isError).toBe(false);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            method: 'POST',
            url: '/echo?from=a%20path&n=1&asText=true&flag=false&label=apify',
            body: JSON.stringify(args.body),
        });
    });

    it.each([
        ['null', null],
        ['a singleton array', [1]],
        ['an object', { a: 1 }],
    ])('rejects %s as a query value through dispatch before sending a POST', async (_label, value) => {
        const received = recordRequests();
        const result = await dispatchTool({ query: { deleteAll: value } });

        expect(received).toHaveLength(0);
        expect(result.isError).toBe(true);
    });

    it('sends to an Actor with both an API schema and an MCP path, even one that would not resolve', async () => {
        const received = recordRequests();
        // `getActorToolResolutionCached` throws on this path; the HTTP interface does not depend on it.
        seedActor('apify/server-and-mcp', { definition: { webServerMcpPath: 'https://other.example/mcp' } });

        const result = await callTool({ actor: 'apify/server-and-mcp', path: '/echo' });

        expect(result.isError).toBe(false);
        expect(received).toHaveLength(1);
    });
});

describe('returning the response', () => {
    it('returns the body as text with the status, size and tenancy, and reports them in telemetry', async () => {
        const result = await callTool({ method: 'POST', path: '/echo', body: { firstNumber: 2 } });

        expectSchemaConformingStructuredContent(result, serverActorRequestOutputSchema);
        const body = JSON.stringify({ query: {}, body: { firstNumber: 2 } });
        expect(result.structuredContent).toEqual({
            actorId: 'server-actor-test-id',
            actorName: SERVER_ACTOR,
            interface: 'server',
            tenancy: ACTOR_TENANCY.SINGLE_TENANT,
            method: 'POST',
            path: '/echo',
            status: 200,
            contentType: 'application/json',
            body,
            bytes: Buffer.byteLength(body),
            summary: expect.stringContaining('returned HTTP 200'),
        });
        expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
        expect(result.content[1].text).toBe((result.structuredContent as { summary: string }).summary);
        expect(result.toolTelemetry).toEqual({
            actorId: 'server-actor-test-id',
            actorTenancy: ACTOR_TENANCY.SINGLE_TENANT,
            httpStatus: 200,
        });
    });

    it('reports a multi-tenant Actor Server in the response and telemetry', async () => {
        seedActor('apify/multi-tenant-server', {
            actor: { actorStandby: { isEnabled: true, tenancy: 'MULTI_TENANT' } },
        });

        const result = await callTool({ actor: 'apify/multi-tenant-server', path: '/echo' });

        expect(result.structuredContent).toMatchObject({ tenancy: ACTOR_TENANCY.MULTI_TENANT });
        expect(result.toolTelemetry).toMatchObject({ actorTenancy: ACTOR_TENANCY.MULTI_TENANT });
    });

    it('succeeds with an empty body for a 204 without a Content-Type', async () => {
        const result = await callTool({ path: '/empty' });

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ status: 204, body: '', bytes: 0 });
        expect((result.structuredContent as { contentType?: string }).contentType).toBeUndefined();
    });

    it('returns a redirect with its status and location without following it', async () => {
        const received = recordRequests();
        const result = await callTool({ path: '/redirect' });

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ status: 302, location: '/echo', body: '', bytes: 0 });
        expect(received.map((request) => request.url)).toEqual(['/redirect']);
    });

    it('masks the session token in the path, the content type and the location, but sends it as is', async () => {
        const received = recordRequests();
        const result = await callTool({ path: '/reflect-token', query: { token: TOKEN } });

        expect(received[0].url).toBe(`/reflect-token?token=${TOKEN}`);
        expect(result.structuredContent).toMatchObject({
            path: '/reflect-token?token=[REDACTED]',
            contentType: 'text/plain; note=[REDACTED]',
            location: '/login?token=[REDACTED]',
        });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('decodes the declared charset and counts bytes before text conversion', async () => {
        const result = await callTool({ path: '/latin1' });

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ status: 200, body: 'café', bytes: 4 });
    });

    it('masks the session token after decoding a non-UTF-8 body', async () => {
        const result = await callTool({ path: '/utf16-token' });

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ body: '[REDACTED]', bytes: 20 });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('rejects an unsupported charset with the status and Actor telemetry after sending', async () => {
        const received = recordRequests();
        const result = await callTool({ path: '/unsupported-charset' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('unsupported-encoding');
        expect(result.content[0].text).toContain('The request itself was sent.');
        expect(result.toolTelemetry).toMatchObject({
            httpStatus: 200,
            failureHttpStatus: 200,
            actorId: 'server-actor-test-id',
            actorTenancy: ACTOR_TENANCY.SINGLE_TENANT,
        });
        expect(received).toHaveLength(1);
    });

    it('rejects a binary body by its content type and keeps the status', async () => {
        const result = await callTool({ path: '/binary' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('application/octet-stream');
        expect(result.toolTelemetry).toMatchObject({ httpStatus: 200, failureHttpStatus: 200 });
    });

    it.each(['/bytes', '/gzip'])(
        'returns a %s body of exactly the inline limit, counted after decompression',
        async (path) => {
            const result = await callTool({ path: `${path}?n=${MAX_INLINE_BYTES}` });

            expect(result.isError).toBe(false);
            expect(result.structuredContent).toMatchObject({ bytes: MAX_INLINE_BYTES });
        },
    );

    it.each(['/bytes', '/gzip'])(
        'does not return a %s body over the inline limit, keeps the status, and says the request was sent',
        async (path) => {
            const result = await callTool({ path: `${path}?n=${MAX_INLINE_BYTES + 1}` });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toContain(`larger than ${MAX_INLINE_BYTES} bytes`);
            expect(result.content[0].text).toContain('The request itself was sent.');
            expect(result.content[0].text).not.toContain('aaa');
            expect(result.toolTelemetry).toMatchObject({
                httpStatus: 200,
                actorTenancy: ACTOR_TENANCY.SINGLE_TENANT,
            });
        },
    );
});

describe('returning an Actor Server error', () => {
    it('passes an Actor error body through as an error, with the session token masked', async () => {
        const result = await callTool({ path: '/status/404' });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            status: 404,
            body: '{"code":404,"authorization":"Bearer [REDACTED]"}',
        });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect(result.toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureHttpStatus: 404,
            httpStatus: 404,
        });
    });

    it('mirrors structured output first and exposes a readable Actor error in both response surfaces', async () => {
        const received = recordRequests();
        const result = await callTool({ path: '/fetch' });
        const message = 'There is nothing at route GET /fetch. A "url" query parameter is required.';

        expect(result.structuredContent).toMatchObject({
            status: 404,
            body: JSON.stringify({ code: 'NOT_FOUND', error: message }),
            errorMessage: message,
            summary: expect.stringContaining('returned HTTP 404'),
        });
        expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
        expect(
            result.content
                .slice(1)
                .map(({ text }) => text)
                .join('\n'),
        ).toContain(message);
        expect(received).toHaveLength(1);
    });

    it('masks a token that JSON escapes hide, in the body and the error message', async () => {
        const result = await callTool({ path: '/escaped-error-token' });
        const { body } = result.structuredContent as { body: string };

        expect(JSON.parse(body)).toEqual({ error: '[REDACTED]' });
        expect(result.structuredContent).toMatchObject({ errorMessage: '[REDACTED]' });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('returns a non-JSON error body only once, as the body', async () => {
        const result = await callTool({ path: '/text-error' });
        const message = 'The "url" query parameter is required.';

        expect(result.structuredContent).toMatchObject({ body: message });
        expect(result.structuredContent).not.toHaveProperty('errorMessage');
        expect(
            result.content
                .slice(1)
                .map(({ text }) => text)
                .join('\n'),
        ).not.toContain(message);
    });

    it('marks a 401 from the Actor server as an authentication failure', async () => {
        const result = await callTool({ path: '/status/401' });

        expect(result.toolTelemetry).toMatchObject({ failureCategory: FAILURE_CATEGORY.AUTH, httpStatus: 401 });
        expect(result.content.map(({ text }) => text).join('\n')).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });

    it.each([true, false])(
        'points a 404 at the operation list, or at the README without fetch-actor-details: %s',
        async (hasDetails) => {
            const received = recordRequests();
            const result = await callTool(
                { path: '/status/404' },
                { loadedToolNames: hasDetails ? [HELPER_TOOLS.ACTOR_GET_DETAILS] : [] },
            );
            const { nextStep } = result.structuredContent as { nextStep: string };

            expect(received).toHaveLength(1);
            expect(result.isError).toBe(true);
            expect(result.content.at(-1)?.text).toBe(nextStep);
            if (hasDetails) {
                // The whole list, not the failed operation: on a 404 the path itself may be wrong.
                expect(nextStep).toContain(JSON.stringify({ actor: SERVER_ACTOR, output: { serverInterface: true } }));
            } else {
                expect(nextStep).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
                expect(nextStep).toContain('README');
            }
        },
    );

    it('lists the documented operations on a rejected request, so the agent can retry without a lookup', async () => {
        const webSearch = 'apify/web-search';
        seedActor(webSearch, {
            definition: { webServerOperations: ['GET / (required: query)', 'POST / (required: request body)'] },
        });

        const result = await callTool({ actor: webSearch, path: '/status/404' });

        expect(result.structuredContent).toMatchObject({
            nextStep: expect.stringContaining(
                'Documented operations: GET / (required: query), POST / (required: request body).',
            ),
        });
    });

    it('lists at most the operation limit and counts the rest', async () => {
        const manyOperations = 'acme/many-operations';
        const operations = Array.from({ length: RECOVERY_MAX_OPERATIONS + 3 }, (_, i) => `GET /op${i}`);
        seedActor(manyOperations, { definition: { webServerOperations: operations } });

        const result = await callTool({ actor: manyOperations, path: '/status/404' });
        const { nextStep } = result.structuredContent as { nextStep: string };

        expect(nextStep).toContain(`GET /op${RECOVERY_MAX_OPERATIONS - 1}, and 3 more.`);
        expect(nextStep).not.toContain(`GET /op${RECOVERY_MAX_OPERATIONS},`);
    });

    it('names the Actor Server error before the README only when the body carries one', async () => {
        const withError = await callTool({ path: '/fetch' });
        const withoutError = await callTool({ path: '/status/404' });

        expect(withError.structuredContent).toMatchObject({
            nextStep: expect.stringMatching(/^The Actor Server error may name/),
        });
        expect(withoutError.structuredContent).toMatchObject({
            nextStep: expect.not.stringContaining('Actor Server error'),
        });
    });

    it.each([
        [429, 'The Actor Server rate limit was reached.'],
        [503, 'The Actor Server is temporarily unavailable.'],
    ])('sends one request on a %i and names the cause', async (status, hint) => {
        const received = recordRequests();
        const result = await callTool({ path: `/status/${status}` });

        expect(received).toHaveLength(1);
        expect(result.isError).toBe(true);
        expect(result.content.at(-1)?.text).toBe(hint);
    });

    it('reports a 5xx from the Actor Server as a failure that keeps the status and the body', async () => {
        const result = await callTool({ path: '/status/500' });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ status: 500 });
        expect(result.toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.FAILED,
            failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR,
            failureHttpStatus: 500,
            httpStatus: 500,
        });
    });
});

describe('rejecting a call before sending', () => {
    it('requires a token through dispatch without sending', async () => {
        const received = recordRequests();
        const result = await dispatchTool({}, { token: '', allowUnauthMode: true });

        expect(result.isError).toBe(true);
        expect((result.content as { text: string }[])[0].text).toContain('An Apify API token is required');
        expect(received).toHaveLength(0);
    });

    it.each(['//other.example/echo', '//user:pw@{host}/echo', '//[bad/echo'])(
        'does not send to %s, which leaves the standby origin, carries credentials, or does not parse',
        async (template) => {
            const received = recordRequests();
            const result = await callTool({ path: template.replace('{host}', new URL(standbyUrl).host) });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toContain('must be a valid path on the Actor Server');
            expect(received).toHaveLength(0);
        },
    );

    it.each([`echo?token=${TOKEN}`, `//${TOKEN}@other.example/echo`])(
        'masks the session token when rejecting path %s without sending',
        async (path) => {
            const received = recordRequests();
            const result = await callTool({ path });

            expectSoftFailInvalidInput(result);
            expect(JSON.stringify(result)).not.toContain(TOKEN);
            expect(received).toHaveLength(0);
        },
    );

    it('rejects a body on GET without sending', async () => {
        const received = recordRequests();
        const result = await callTool({ path: '/echo', body: { a: 1 } });

        expectSoftFailInvalidInput(result);
        expect(received).toHaveLength(0);
    });

    it('returns the not-found response for an Actor the API does not know', async () => {
        const unknownActorClient = Object.assign(
            new ApifyClient({ token: TOKEN }),
            mockApifyClient({ actor: () => ({ get: async () => undefined }) }),
        );

        const result = await callTool({ actor: 'apify/missing', path: '/echo' }, { apifyClient: unknownActorClient });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain("Actor information for 'apify/missing' was not found.");
    });

    it('rejects an Actor with Actor Standby off, naming call-actor only when the session has it', async () => {
        const received = recordRequests();
        seedActor('apify/server-off', { actor: { actorStandby: { isEnabled: false } } });

        const withCallActor = await callTool({ actor: 'apify/server-off', path: '/echo' });
        const withoutCallActor = await callTool(
            { actor: 'apify/server-off', path: '/echo' },
            { loadedToolNames: [HELPER_TOOLS.ACTOR_SERVER_REQUEST] },
        );

        expectSoftFailInvalidInput(withCallActor);
        expect(withCallActor.content[0].text).toContain(`It can be run from an input with ${HELPER_TOOLS.ACTOR_CALL}.`);
        expect(withoutCallActor.content[0].text).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(withCallActor.toolTelemetry?.actorTenancy).toBeUndefined();
        expect(received).toHaveLength(0);
    });

    it('rejects an MCP-server Actor without an API schema, pointing at its MCP tools', async () => {
        const received = recordRequests();
        seedActor('apify/mcp-only', { definition: { webServerMcpPath: '/mcp', hasWebServerSchema: false } });

        const result = await callTool({ actor: 'apify/mcp-only', path: '/echo' });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain(`${HELPER_TOOLS.ACTOR_CALL} as "apify/mcp-only:toolName"`);
        expect(received).toHaveLength(0);
    });

    it('reports a missing standby URL as a configuration failure without sending', async () => {
        const received = recordRequests();
        seedActor('apify/no-standby-url', { actor: { standbyUrl: null } });

        const result = await callTool({ actor: 'apify/no-standby-url', path: '/echo' });

        expect(result.isError).toBe(true);
        expect(result.toolTelemetry).toMatchObject({ toolStatus: TOOL_STATUS.FAILED });
        expect(received).toHaveLength(0);
    });

    it('rejects a payment-provider session before any request reaches the Actor server', async () => {
        const received = recordRequests();
        const result = await dispatchTool({ method: 'GET' }, { paymentProvider: makePaymentProvider() });

        expect(result.isError).toBe(true);
        expect((result.content as { text: string }[])[0].text).toContain('is not supported in agentic payment mode');
        expect(received).toHaveLength(0);
    });

    it('is not listed in a payment-provider session', async () => {
        const listActorsTools = async (options: Parameters<typeof withServer>[1]) =>
            withServer(
                async (server) => {
                    await server.loadToolsFromInput({ tools: ['actors'] }, mockApifyClient());
                    return server.listToolNames();
                },
                { serverMode: SERVER_MODE.DEFAULT, ...options },
            );

        expect(await listActorsTools({})).toContain(HELPER_TOOLS.ACTOR_SERVER_REQUEST);
        expect(await listActorsTools({ paymentProvider: makePaymentProvider() })).not.toContain(
            HELPER_TOOLS.ACTOR_SERVER_REQUEST,
        );
    });
});

describe('reporting an incomplete response', () => {
    it('reports a connection dropped before any status as possibly processed', async () => {
        const received = recordRequests();
        const result = await callTool({ method: 'POST', path: '/drop-before-status', body: { a: 1 } });

        expect(received).toHaveLength(1);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('got no complete response');
        expect(result.content[0].text).toContain('may still have processed the request');
        expect(result.toolTelemetry).toMatchObject({ actorTenancy: ACTOR_TENANCY.SINGLE_TENANT });
    });

    it('reports a timeout as a failure that does not claim the request was undone', async () => {
        const result = await callTool({ path: '/drip?ms=2000' }, { timeoutMillis: 100 });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('within 0.1 seconds');
        expect(result.content[0].text).toContain('may still have processed the request');
        // /drip sends its 200 before the body stalls, so the status that arrived is kept.
        expect(result.toolTelemetry).toMatchObject({
            toolStatus: TOOL_STATUS.FAILED,
            actorTenancy: ACTOR_TENANCY.SINGLE_TENANT,
            httpStatus: 200,
        });
    });

    it('reports a body cut off after the status as a failure that keeps the status', async () => {
        const result = await callTool({ path: '/truncate' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('got HTTP 200 but not the whole body');
        expect(result.content[0].text).not.toContain('abc');
        expect(result.toolTelemetry).toMatchObject({ toolStatus: TOOL_STATUS.FAILED, httpStatus: 200 });
    });

    it('returns the empty aborted response when the client cancels mid-request', async () => {
        const received = recordRequests();
        const controller = new AbortController();
        const pending = callTool({ path: '/drip?ms=2000' }, { signal: controller.signal });
        await vi.waitFor(() => expect(received).toHaveLength(1));
        controller.abort();

        await expect(pending).resolves.toEqual({});
    });
});

describe('describing the tool', () => {
    it('names fetch-actor-details in the description only when the session has it', () => {
        const withDetails = sendServerActorRequest.buildDescription!(ALL_TOOLS_PRESENT);
        const withoutDetails = sendServerActorRequest.buildDescription!(only(HELPER_TOOLS.ACTOR_SERVER_REQUEST));

        expect(sendServerActorRequest.description).toBe(withDetails);
        expect(withDetails).toContain(`${HELPER_TOOLS.ACTOR_GET_DETAILS} with output.serverInterface`);
        expect(withoutDetails).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });
});

describe('logging the call', () => {
    it('logs the body and every query value as redacted, and keeps the Actor name and query names', () => {
        const { redactArgs } = sendServerActorRequest as HelperTool;
        const args = {
            actor: SERVER_ACTOR,
            method: 'POST',
            path: '/echo',
            query: { apiKey: 'secret', limit: 5 },
            body: { value: 'secret' },
        };

        expect(JSON.stringify(redactArgs?.(args))).not.toContain('secret');
        expect(redactArgs?.(args)).toMatchObject({
            actor: SERVER_ACTOR,
            method: 'POST',
            path: '/echo',
            query: { apiKey: '[REDACTED]', limit: '[REDACTED]' },
        });
    });
});
