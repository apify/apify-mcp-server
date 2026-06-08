import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { createExpressApp } from '../../src/dev_server.js';

const CLIENT_INFO = {
    name: 'raw-http-test',
    version: '1.0.0',
};

let httpServer: HttpServer;
let mcpUrl: string;

function buildRequestHeaders(options?: { sessionId?: string; protocolVersion?: string }): Headers {
    const headers = new Headers({
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
    });

    if (options?.sessionId) headers.set('Mcp-Session-Id', options.sessionId);
    if (options?.protocolVersion) headers.set('MCP-Protocol-Version', options.protocolVersion);

    return headers;
}

function buildInitializeRequest(id = 1) {
    return {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        },
    };
}

async function postJson(body: unknown, options?: { sessionId?: string; protocolVersion?: string }): Promise<Response> {
    return await fetch(mcpUrl, {
        method: 'POST',
        headers: buildRequestHeaders(options),
        body: JSON.stringify(body),
    });
}

async function initializeSession(): Promise<{ response: Response; sessionId: string }> {
    const response = await postJson(buildInitializeRequest());
    const sessionId = response.headers.get('mcp-session-id');

    expect(response.status).toBe(200);
    expect(sessionId).toBeTruthy();

    await readSseJson(response);

    return { response, sessionId: sessionId! };
}

async function readSseJson(response: Response): Promise<unknown> {
    const body = await response.text();
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));

    expect(dataLine).toBeTruthy();

    return JSON.parse(dataLine!.slice('data: '.length));
}

describe('createExpressApp() streamable HTTP raw transport', () => {
    beforeEach(async () => {
        log.setLevel(log.LEVELS.OFF);

        const app = createExpressApp();
        httpServer = await new Promise<HttpServer>((resolve) => {
            const server = app.listen(0, '127.0.0.1', () => resolve(server));
        });

        const address = httpServer.address() as AddressInfo;
        mcpUrl = `http://127.0.0.1:${address.port}/?payment=skyfire&tools=docs&telemetry-enabled=false`;
    });

    afterEach(async () => {
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    });

    it('returns a visible ASCII session ID header on initialize', async () => {
        const response = await postJson(buildInitializeRequest());
        const sessionId = response.headers.get('mcp-session-id');

        expect(response.status).toBe(200);
        expect(sessionId).toMatch(/^[\x21-\x7E]+$/);

        const message = await readSseJson(response);
        expect(message).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            result: {
                protocolVersion: expect.any(String),
            },
        });
    });

    it('rejects non-initialize POST requests without a session ID', async () => {
        const response = await postJson({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
        });

        expect(response.status).toBe(400);
    });

    it('rejects POST requests with an unknown session ID', async () => {
        const response = await postJson(
            {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/list',
            },
            { sessionId: 'unknown-session-id', protocolVersion: LATEST_PROTOCOL_VERSION },
        );

        expect(response.status).toBe(404);
    });

    it('terminates a session with DELETE and rejects reuse afterwards', async () => {
        const { sessionId } = await initializeSession();

        const deleteResponse = await fetch(mcpUrl, {
            method: 'DELETE',
            headers: buildRequestHeaders({ sessionId, protocolVersion: LATEST_PROTOCOL_VERSION }),
        });
        expect(deleteResponse.status).toBeGreaterThanOrEqual(200);
        expect(deleteResponse.status).toBeLessThan(300);

        const reuseResponse = await postJson(
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/list',
            },
            { sessionId, protocolVersion: LATEST_PROTOCOL_VERSION },
        );
        expect(reuseResponse.status).toBe(404);
    });

    it('returns an empty 202 response for notifications', async () => {
        const { sessionId } = await initializeSession();

        const response = await postJson(
            {
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {},
            },
            { sessionId, protocolVersion: LATEST_PROTOCOL_VERSION },
        );

        expect(response.status).toBe(202);
        expect(await response.text()).toBe('');
    });

    it('accepts notifications/cancelled for unknown request IDs as a no-op', async () => {
        const { sessionId } = await initializeSession();

        const response = await postJson(
            {
                jsonrpc: '2.0',
                method: 'notifications/cancelled',
                params: {
                    requestId: 'missing-request',
                    reason: 'client no-op smoke test',
                },
            },
            { sessionId, protocolVersion: LATEST_PROTOCOL_VERSION },
        );

        expect(response.status).toBe(202);
        expect(await response.text()).toBe('');
    });

    it('rejects malformed JSON request bodies', async () => {
        const response = await fetch(mcpUrl, {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: '{not valid json',
        });

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });

    it('rejects unsupported protocol versions after initialization', async () => {
        const { sessionId } = await initializeSession();

        const response = await postJson(
            {
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/list',
            },
            { sessionId, protocolVersion: '2099-01-01' },
        );

        expect(response.status).toBe(400);
    });
});
