import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { createExpressApp } from '../../src/dev_server.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';

const STATELESS_META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
};

let httpServer: Server;
let baseUrl: string;

async function postStatelessRequest(includeMethodHeader = true): Promise<Response> {
    return await fetch(baseUrl, {
        method: 'POST',
        headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
            ...(includeMethodHeader ? { 'mcp-method': 'tools/list' } : {}),
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: { _meta: STATELESS_META },
        }),
    });
}

describe('createExpressApp()', () => {
    beforeEach(async () => {
        log.setLevel(log.LEVELS.OFF);
        vi.spyOn(ActorsMcpServer.prototype, 'loadToolsFromUrl').mockResolvedValue();
        const app = createExpressApp();
        await new Promise<void>((resolve) => {
            httpServer = app.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    describe('2026-07-28 stateless requests', () => {
        it('serves a stateless tools list', async () => {
            const response = await postStatelessRequest();

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
                jsonrpc: '2.0',
                id: 1,
                result: { tools: expect.any(Array) },
            });
        });

        it('rejects a request without the required Mcp-Method header', async () => {
            const response = await postStatelessRequest(false);

            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toMatchObject({
                error: { code: -32020 },
            });
        });
    });
});
