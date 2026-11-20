import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { buildServerActorToolInfo } from '../../src/tools/actors/server_interface_details.js';
import type { ActorDefinitionWithInfo, ToolEntry } from '../../src/types.js';
import { SERVER_MODE, TOOL_TYPE } from '../../src/types.js';
import type * as ActorModule from '../../src/utils/actor.js';
import { getActorDefinitionCached } from '../../src/utils/actor.js';
import { getActors, withoutCollidingActorTools } from '../../src/utils/tools_loader.js';

// Definitions come from the stub, so loading runs without the Apify API.
vi.mock('../../src/utils/actor.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ActorModule>();
    return { ...actual, getActorDefinitionCached: vi.fn() };
});

const DOTTED = 'john.doe/scraper';
const ESCAPED = 'john-dot-doe/scraper';
const SHARED_TOOL_NAME = actorNameToToolName(DOTTED);

/** A run Actor, or with `isServer` a Standby Actor with a server interface. */
function actorDefinition(actorFullName: string, isServer: boolean): ActorDefinitionWithInfo {
    const [username, name] = actorFullName.split('/');
    const httpSchema = { openapi: '3.0.0', paths: { '/': { get: { responses: { 200: { description: 'OK' } } } } } };
    return {
        definition: {
            id: `${name}-id`,
            actorFullName,
            description: `Scraper by ${username}`,
            input: { type: 'object', properties: { url: { type: 'string', title: 'URL', description: 'URL' } } },
            hasWebServerSchema: isServer,
            webServerToolInfo: isServer ? buildServerActorToolInfo(httpSchema, actorFullName) : undefined,
        },
        info: { id: `${name}-id`, username, name, actorStandby: isServer ? { isEnabled: true } : undefined },
    } as unknown as ActorDefinitionWithInfo;
}

function stubActors(serverActorNames: string[] = []) {
    vi.mocked(getActorDefinitionCached).mockImplementation(async (actorFullName) =>
        actorDefinition(actorFullName, serverActorNames.includes(actorFullName)),
    );
}

const apifyClient = () => new ApifyClient({ token: 'test-token' });
const actorsServedAs = (tools: ToolEntry[], toolName: string) =>
    tools.flatMap((tool) => (tool.name === toolName && 'actorFullName' in tool ? [tool.actorFullName] : []));

afterEach(() => vi.restoreAllMocks());

describe('Actors whose tools share a name are not served', () => {
    it.each([
        ['run', 'run', []],
        ['Server', 'Server', [DOTTED, ESCAPED]],
        ['Server', 'run', [DOTTED]],
        ['run', 'Server', [ESCAPED]],
    ])('serves neither when the dotted Actor is a %s Actor and the other a %s Actor', async (_a, _b, servers) => {
        vi.spyOn(log, 'warning').mockImplementation(() => undefined);
        stubActors(servers);

        for (const actors of [
            [DOTTED, ESCAPED],
            [ESCAPED, DOTTED],
        ]) {
            const tools = await getActors({ actors }, apifyClient());
            expect(actorsServedAs(tools, SHARED_TOOL_NAME)).toEqual([]);
        }
    });

    it('serves none of three Actors that share a name and keeps the other Actors', async () => {
        vi.spyOn(log, 'warning').mockImplementation(() => undefined);
        const actors = ['john.doe--dev/scraper', 'john-dot-doe--dev/scraper', 'john.doe/dev--scraper'];
        stubActors([actors[1]]);

        const tools = await getActors(
            { actors: [actors[0], 'apify/rag-web-browser', ...actors.slice(1)] },
            apifyClient(),
        );

        expect(tools.map((tool) => tool.name)).toEqual([actorNameToToolName('apify/rag-web-browser')]);
    });

    it.each([
        ['the first fails to load', DOTTED, 'error'],
        ['the first is not found', DOTTED, 'not found'],
        ['the second fails to load', ESCAPED, 'error'],
    ])('serves neither when %s', async (_case, unloaded, failure) => {
        vi.spyOn(log, 'warning').mockImplementation(() => undefined);
        vi.mocked(getActorDefinitionCached).mockImplementation(async (actorFullName) => {
            if (actorFullName !== unloaded) return actorDefinition(actorFullName, false);
            if (failure === 'error') throw new Error('Service unavailable');
            return null;
        });

        const tools = await getActors({ actors: [DOTTED, ESCAPED] }, apifyClient());

        expect(actorsServedAs(tools, SHARED_TOOL_NAME)).toEqual([]);
    });

    it('keeps the other Actors when an Actor that shares no tool name fails to load', async () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);
        vi.mocked(getActorDefinitionCached).mockImplementation(async (actorFullName) => {
            if (actorFullName === 'apify/website-content-crawler') throw new Error('Service unavailable');
            return actorDefinition(actorFullName, false);
        });

        const tools = await getActors(
            { actors: ['apify/website-content-crawler', 'apify/rag-web-browser', DOTTED] },
            apifyClient(),
        );

        expect(tools.map((tool) => tool.name)).toEqual([
            actorNameToToolName('apify/rag-web-browser'),
            SHARED_TOOL_NAME,
        ]);
        expect(warning).not.toHaveBeenCalled();
    });

    it('logs one warning naming the tool and every Actor involved', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);
        const tool = (actorFullName: string) =>
            ({ type: TOOL_TYPE.ACTOR, name: SHARED_TOOL_NAME, actorFullName }) as unknown as ToolEntry;

        withoutCollidingActorTools([tool(DOTTED), tool(ESCAPED), tool(DOTTED)]);

        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(expect.any(String), {
            toolName: SHARED_TOOL_NAME,
            actorNames: [ESCAPED, DOTTED].sort(),
        });
    });

    it("serves neither an Actor's tool nor another Actor's MCP server tool of the same name", () => {
        vi.spyOn(log, 'warning').mockImplementation(() => undefined);
        const actorTool = { type: TOOL_TYPE.ACTOR, name: 'foo--bar--baz', actorFullName: 'foo--bar/baz' };
        const mcpTool = { type: TOOL_TYPE.ACTOR_MCP, name: 'foo--bar--baz', actorFullName: 'foo/bar' };

        expect(withoutCollidingActorTools([mcpTool, actorTool] as unknown as ToolEntry[])).toEqual([]);
        expect(withoutCollidingActorTools([actorTool, mcpTool] as unknown as ToolEntry[])).toEqual([]);
    });

    it('keeps an Actor listed twice and an internal tool, without a warning', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);
        const actorTool = {
            type: TOOL_TYPE.ACTOR,
            name: 'apify--rag-web-browser',
            actorFullName: 'apify/rag-web-browser',
        };
        const internalTool = { type: TOOL_TYPE.INTERNAL, name: HELPER_TOOLS.ACTOR_CALL };
        const tools = [actorTool, internalTool, actorTool] as unknown as ToolEntry[];

        expect(withoutCollidingActorTools(tools)).toEqual(tools);
        expect(warning).not.toHaveBeenCalled();
    });
});

describe('a session that selects Actors whose tools share a name', () => {
    const servers: ActorsMcpServer[] = [];
    afterEach(async () => {
        while (servers.length > 0) await servers.pop()?.close();
    });

    it.each([SERVER_MODE.DEFAULT, 'auto' as const])(
        'serves neither before or after initialize, nor in a request snapshot (%s mode)',
        async (serverMode) => {
            vi.spyOn(log, 'warning').mockImplementation(() => undefined);
            stubActors([DOTTED]);
            const server = new ActorsMcpServer({
                taskStore: new InMemoryTaskStore(),
                setupSigintHandler: false,
                serverMode,
                telemetry: { enabled: false },
            });
            servers.push(server);

            await server.loadToolsFromUrl(`/?actors=${DOTTED},${ESCAPED}`, apifyClient());
            expect(server.listToolNames()).not.toContain(SHARED_TOOL_NAME);

            await server.applyInitialize({
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'client', version: '1' },
                },
            } as never);
            expect(server.listToolNames()).not.toContain(SHARED_TOOL_NAME);
            expect(server.listAllToolNames()).not.toContain(DOTTED);
            expect(server.listAllToolNames()).not.toContain(ESCAPED);

            const snapshot = await server.createRequestSnapshot(undefined);
            expect(snapshot.tools.has(SHARED_TOOL_NAME)).toBe(false);
        },
    );
});
