import { describe, expect, it } from 'vitest';

import {
    actorDetailsOutputDefaults,
    buildActorDetailsTextResponse,
} from '../../src/tools/core/fetch_actor_details_common.js';
import type { ActorDetailsResult } from '../../src/utils/actor_details.js';

const MOCK_DETAILS = {
    actorInfo: {
        id: 'actor-id-1',
        name: 'example-mcp-server',
        username: 'apify',
        title: 'Example MCP Server',
        description: 'An example MCP server actor.',
        categories: ['MCP Servers'],
    },
    actorCard: '# Actor card',
    actorCardStructured: {
        id: 'actor-id-1',
        fullName: 'apify/example-mcp-server',
        url: 'https://apify.com/apify/example-mcp-server',
        title: 'Example MCP Server',
        description: 'An example MCP server actor.',
        categories: ['MCP Servers'],
        isDeprecated: false,
        developer: { username: 'apify', isOfficialApify: true, url: 'https://apify.com/apify' },
    },
    inputSchema: { type: 'object', properties: {} },
    readme: '# Example MCP Server',
    readmeSummary: 'Short summary.',
} as unknown as ActorDetailsResult;

describe('buildActorDetailsTextResponse()', () => {
    it('mirrors mcpToolsMessage into structuredContent.mcpTools when output.mcpTools is requested', () => {
        const mcpToolsMessage = '# Available MCP Tools\nThis Actor is an MCP server with 1 tools.';

        const { texts, structuredContent } = buildActorDetailsTextResponse({
            details: MOCK_DETAILS,
            output: {
                ...actorDetailsOutputDefaults,
                description: false,
                stats: false,
                pricing: false,
                rating: false,
                metadata: false,
                inputSchema: false,
                readme: false,
                outputSchema: false,
                mcpTools: true,
            },
            mcpToolsMessage,
        });

        // Text channel: MCP tools message is the only text emitted.
        expect(texts).toEqual([mcpToolsMessage]);

        // Structured channel: the same information must be present so that
        // schema-aware MCP clients (which prefer structuredContent over texts)
        // do not see an empty `{}` response.
        expect(structuredContent.mcpTools).toBe(mcpToolsMessage);
    });

    it('omits structuredContent.mcpTools when output.mcpTools is not requested', () => {
        const { structuredContent } = buildActorDetailsTextResponse({
            details: MOCK_DETAILS,
            output: { ...actorDetailsOutputDefaults, mcpTools: false },
        });

        expect(structuredContent.mcpTools).toBeUndefined();
    });
});
