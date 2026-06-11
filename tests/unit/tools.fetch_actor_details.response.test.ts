import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    actorDetailsOutputDefaults,
    buildActorDetailsTextResponse,
    buildFetchActorDetailsResult,
} from '../../src/tools/core/fetch_actor_details_common.js';
import type { ActorDetailsResult } from '../../src/utils/actor_details.js';
import { fetchActorDetails } from '../../src/utils/actor_details.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { stubInternalToolArgs } from './tools.search_actors.fixtures.js';

vi.mock('../../src/utils/actor_details.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/utils/actor_details.js');
    return {
        ...actual,
        fetchActorDetails: vi.fn(),
    };
});

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

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
        const mcpToolsMessage = '# Available MCP Tools\nThis Actor is an MCP server with 1 tool.';

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

    it('omits structuredContent.mcpTools when output.mcpTools is requested but no message is available', () => {
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
        });

        expect(texts).toEqual([]);
        expect(structuredContent.mcpTools).toBeUndefined();
    });

    describe('with a Console link context', () => {
        const linkContext = {};
        const inputSchemaOnlyOutput = {
            ...actorDetailsOutputDefaults,
            description: false,
            stats: false,
            pricing: false,
            rating: false,
            metadata: false,
            readme: false,
        };

        it('links the input schema to the Console Actor detail page (Console has no /input sub-page)', () => {
            const { texts } = buildActorDetailsTextResponse({
                details: MOCK_DETAILS,
                output: inputSchemaOnlyOutput,
                linkContext,
            });

            expect(texts[0]).toContain('# [Input schema](https://console.apify.com/actors/actor-id-1)');
            expect(texts[0]).not.toContain('/input)');
        });

        it('appends the verbatim-links nudge as the last text', () => {
            const { texts } = buildActorDetailsTextResponse({
                details: MOCK_DETAILS,
                output: inputSchemaOnlyOutput,
                linkContext,
            });

            expect(texts.at(-1)).toBe(VERBATIM_LINKS_NUDGE);
        });

        it('keeps the public /input link and omits the nudge without a link context', () => {
            const { texts } = buildActorDetailsTextResponse({
                details: MOCK_DETAILS,
                output: inputSchemaOnlyOutput,
            });

            expect(texts[0]).toContain('# [Input schema](https://apify.com/apify/example-mcp-server/input)');
            expect(texts.at(-1)).not.toBe(VERBATIM_LINKS_NUDGE);
        });
    });
});

describe('buildFetchActorDetailsResult()', () => {
    beforeEach(() => {
        vi.mocked(fetchActorDetails).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(fetchActorDetails).mockResolvedValue(MOCK_DETAILS);
    });

    // pricing: false → the users/me lookup is needed only for Console UI tokens.
    const callWithToken = async (apifyToken: string) => {
        const result = await buildFetchActorDetailsResult({
            ...stubInternalToolArgs({ actor: 'apify/example-mcp-server', output: { inputSchema: true } }),
            apifyToken,
        });
        return result as { content: { type: string; text: string }[] };
    };

    it('skips the users/me lookup for API tokens when pricing is not rendered', async () => {
        const { content } = await callWithToken('apify_api_test');

        expect(getUserInfoCached).not.toHaveBeenCalled();
        expect(content[0].text).toContain('https://apify.com/apify/example-mcp-server/input');
    });

    it('performs the lookup for Console UI tokens and mints Console links', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue({
            userId: 'USER_ID',
            userPlanTier: 'FREE',
            isOrganization: false,
        });

        const { content } = await callWithToken('apify_ui_test');

        expect(getUserInfoCached).toHaveBeenCalledOnce();
        // linkContext is forwarded to the card formatters.
        expect(vi.mocked(fetchActorDetails).mock.calls[0][2]).toMatchObject({
            linkContext: {},
        });
        expect(content[0].text).toContain('# [Input schema](https://console.apify.com/actors/actor-id-1)');
        expect(content.at(-1)?.text).toBe(VERBATIM_LINKS_NUDGE);
    });
});
