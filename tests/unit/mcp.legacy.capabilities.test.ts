import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { InitializeRequest, InitializeResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, GetPromptResultSchema, ListPromptsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import type { ActorsMcpServer } from '../../src/mcp/server.js';
import { getRequestHandler, withServer, withTestPrompt } from './helpers/mcp_server.js';

async function readInitializeCapabilities(server: ActorsMcpServer): Promise<InitializeResult['capabilities']> {
    const request: InitializeRequest = {
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
        },
    };
    const result = (await getRequestHandler(server, 'initialize')(
        request as unknown as Record<string, unknown>,
        {},
    )) as unknown as InitializeResult;
    return result.capabilities;
}

/**
 * Pins what the legacy (2025-11-25) adapter advertises at `initialize`. `tools` carries no
 * sub-capabilities: this server never changes its own tool list, so it never originates
 * `notifications/tools/list_changed` — `tool_dispatch.ts` only relays a proxied Actor-MCP server's,
 * which reports that server's list, not ours. Read through the `initialize` handler because the SDK
 * keeps `Server.getCapabilities()` private.
 */
describe('LegacyMcpServer capabilities', () => {
    const ADVERTISED_CAPABILITIES = {
        tools: {},
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        resources: {},
        logging: {},
    };

    it('advertises tools without listChanged, alongside tasks, resources and logging', async () => {
        await withServer(async (server) => {
            expect(await readInitializeCapabilities(server)).toEqual(ADVERTISED_CAPABILITIES);
        });
    });

    it('advertises prompts when the host has a prompt', async () => {
        await withTestPrompt(async () => {
            await withServer(async (server) => {
                expect(await readInitializeCapabilities(server)).toEqual({ ...ADVERTISED_CAPABILITIES, prompts: {} });
            });
        });
    });

    // A raw request: the SDK client sends it although the server declared no prompts.
    it('answers prompts/list and prompts/get with method not found when the host has no prompts', async () => {
        await withServer(async (server) => {
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            await expect(
                client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema),
            ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
            await expect(
                client.request({ method: 'prompts/get', params: { name: 'greet' } }, GetPromptResultSchema),
            ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
            await client.close();
        });
    });
});
