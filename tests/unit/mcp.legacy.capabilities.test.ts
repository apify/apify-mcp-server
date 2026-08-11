import type { InitializeRequest, InitializeResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { getRequestHandler, withServer } from './helpers/mcp_server.js';

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
        prompts: {},
        logging: {},
    };

    it('advertises tools without listChanged, alongside tasks, resources, prompts and logging', async () => {
        await withServer(async (server) => {
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

            expect(result.capabilities).toEqual(ADVERTISED_CAPABILITIES);
        });
    });
});
