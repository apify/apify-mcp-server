import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
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
    loadedActorIds?: readonly string[],
) {
    const { apifyClient } = mockActorBuildClient({ actor, defaultBuild: mockBuild(DEFAULT_BUILD_ID, definition) });
    // inputSchema only: no pricing, so no users/me lookup.
    const result = await (fetchActorDetails as HelperTool).call(
        stubToolCallContext({ actor: `${actor.username}/${actor.name}`, output: { inputSchema: true } }, apifyClient, {
            loadedToolNames,
            loadedActorIds,
        }),
    );
    return {
        result,
        text: (result.content ?? []).map(textOf).join('\n'),
        structuredContent: result.structuredContent as Record<string, unknown>,
    };
}

describe('identifying an MCP server Actor in fetch-actor-details', () => {
    it('names the list tool when the session can list and call MCP tools', async () => {
        const { result, text, structuredContent } = await callDetails(MCP_SERVER_ACTOR, { webServerMcpPath: '/mcp' });

        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(structuredContent.nextStep).not.toContain(getOwnServerRemedy());
        expect(text).toContain(structuredContent.nextStep);
        expectSchemaConformingStructuredContent(result, actorDetailsOutputSchema);
        // The schema allows extra keys, so conformance alone would not catch nextStep missing from it.
        expect(actorDetailsOutputSchema.properties).toHaveProperty('nextStep');
    });

    // The next step replaces the not-runnable guidance, so the remedy must not appear twice.
    it('names the list tool and gives the remedy once when the session cannot call MCP tools', async () => {
        const { text, structuredContent } = await callDetails(MCP_SERVER_ACTOR, { webServerMcpPath: '/mcp' }, [
            HELPER_TOOLS.ACTOR_GET_DETAILS,
            HELPER_TOOLS.ACTOR_MCP_TOOL_LIST,
        ]);

        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(structuredContent.nextStep).toContain(getOwnServerRemedy());
        expect(text.split(getOwnServerRemedy())).toHaveLength(2);
    });

    it('names the call tool without the remedy when the session can call but not list MCP tools', async () => {
        const { text, structuredContent } = await callDetails(MCP_SERVER_ACTOR, { webServerMcpPath: '/mcp' }, [
            HELPER_TOOLS.ACTOR_GET_DETAILS,
            HELPER_TOOLS.ACTOR_MCP_TOOL_CALL,
        ]);

        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        expect(structuredContent.nextStep).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(text).not.toContain(getOwnServerRemedy());
    });

    it('gives the remedy once without naming a tool when the session can neither list nor call MCP tools', async () => {
        const { text, structuredContent } = await callDetails(MCP_SERVER_ACTOR, { webServerMcpPath: '/mcp' }, [
            HELPER_TOOLS.ACTOR_GET_DETAILS,
        ]);

        expect(structuredContent.nextStep).toContain(getOwnServerRemedy());
        expect(structuredContent.nextStep).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_LIST);
        expect(structuredContent.nextStep).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        expect(text.split(getOwnServerRemedy())).toHaveLength(2);
    });

    // The session already serves the Actor's own MCP tools, so the own-server remedy would be false.
    it("adds no MCP sentence when the session serves the Actor's own tools", async () => {
        const { text, structuredContent } = await callDetails(
            MCP_SERVER_ACTOR,
            { webServerMcpPath: '/mcp' },
            [HELPER_TOOLS.ACTOR_GET_DETAILS],
            [MCP_SERVER_ACTOR.id],
        );

        expect(structuredContent).not.toHaveProperty('nextStep');
        expect(text).not.toContain(getOwnServerRemedy());
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
});
