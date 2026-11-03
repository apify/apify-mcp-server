import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER } from '../../src/const.js';
import { getOwnServerRemedy } from '../../src/tools/actor_tool_naming.js';
import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { actorDetailsOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { Actor, ActorDefinitionWithServerInterface, HelperTool } from '../../src/types.js';
import {
    DEFAULT_BUILD_ID,
    mockActor,
    mockActorBuildClient,
    mockBuild,
    mockStandbyActor,
} from './helpers/actor_build_client.js';
import { expectSchemaConformingStructuredContent, stubToolCallContext, textOf } from './helpers/tool_context.js';

const MCP_SERVER_ACTOR = mockStandbyActor(undefined, { username: 'apify', name: 'example-mcp-server' });

async function callDetails(
    actor: Actor,
    definition: Partial<ActorDefinitionWithServerInterface>,
    loadedToolNames?: readonly string[],
) {
    const { apifyClient } = mockActorBuildClient({ actor, defaultBuild: mockBuild(DEFAULT_BUILD_ID, definition) });
    // inputSchema only: no pricing, so no users/me lookup.
    const result = await (fetchActorDetails as HelperTool).call(
        stubToolCallContext({ actor: `${actor.username}/${actor.name}`, output: { inputSchema: true } }, apifyClient, {
            loadedToolNames,
        }),
    );
    return {
        result,
        text: (result.content ?? []).map(textOf).join('\n'),
        structuredContent: result.structuredContent as Record<string, unknown>,
    };
}

describe('identifying an MCP server Actor in fetch-actor-details', () => {
    it('names the MCP tool list tool when the session has it', async () => {
        const { result, text, structuredContent } = await callDetails(MCP_SERVER_ACTOR, { webServerMcpPath: '/mcp' });

        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(text).toContain(structuredContent.nextStep);
        expectSchemaConformingStructuredContent(result, actorDetailsOutputSchema);
    });

    it('gives the own-server remedy without naming the list tool when the session lacks it', async () => {
        const { text, structuredContent } = await callDetails(
            MCP_SERVER_ACTOR,
            { webServerMcpPath: '/mcp' },
            Object.values(HELPER_TOOLS).filter((name) => name !== HELPER_TOOLS.ACTOR_MCP_TOOL_LIST),
        );

        expect(structuredContent.nextStep).toContain(getOwnServerRemedy());
        expect(structuredContent.nextStep).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(text).toContain(structuredContent.nextStep);
    });

    it('gives the own-server remedy once when the session has no list tool and no run tool', async () => {
        const { text } = await callDetails(MCP_SERVER_ACTOR, { webServerMcpPath: '/mcp' }, [
            HELPER_TOOLS.ACTOR_GET_DETAILS,
        ]);

        expect(text.split(getOwnServerRemedy())).toHaveLength(2);
    });

    it('adds no MCP sentence for an Actor without an MCP path', async () => {
        const { text, structuredContent } = await callDetails(MCP_SERVER_ACTOR, {});

        expect(structuredContent).not.toHaveProperty('nextStep');
        expect(text).not.toContain('This Actor is an MCP server');
    });

    // fetch-actor-mcp-tool-list refuses an Actor without Actor Standby, so the details must not offer it.
    it('adds no MCP sentence for an Actor with standby off that declares an MCP path', async () => {
        const actor = mockActor({ username: 'apify', name: 'example-mcp-server' });
        const { text, structuredContent } = await callDetails(actor, { webServerMcpPath: '/mcp' });

        expect(structuredContent).not.toHaveProperty('nextStep');
        expect(text).not.toContain('This Actor is an MCP server');
    });

    // Served as run tools although they declare an MCP path (INPUT_INTERFACE_ACTORS).
    it('adds no MCP sentence for an input-interface Actor that declares an MCP path', async () => {
        const [username, name] = RAG_WEB_BROWSER.split('/');
        const { text, structuredContent } = await callDetails(mockStandbyActor(undefined, { username, name }), {
            webServerMcpPath: '/mcp',
        });

        expect(structuredContent).not.toHaveProperty('nextStep');
        expect(text).not.toContain('This Actor is an MCP server');
    });
});
