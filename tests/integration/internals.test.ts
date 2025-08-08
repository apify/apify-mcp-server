import { beforeAll, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { actorNameToToolName } from '../../dist/tools/utils.js';
import { defaults } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/index.js';
import { addRemoveTools, defaultTools, getActorsAsTools } from '../../src/tools/index.js';
import { ACTOR_PYTHON_EXAMPLE, DEFAULT_TOOL_NAMES } from '../const.js';
import { expectArrayWeakEquals } from '../helpers.js';

beforeAll(() => {
    log.setLevel(log.LEVELS.OFF);
});

describe('MCP server internals integration tests', () => {
    it('should load and restore tools from a tool list', async () => {
        const actorsMcpServer = new ActorsMcpServer({
            actors: [],
            tools: [],
            fullActorSchema: false,
            enableAddingActors: true,
            enableDefaultActors: true,
        }, false);
        await actorsMcpServer.initialize();

        // Load new tool
        const newTool = await getActorsAsTools([ACTOR_PYTHON_EXAMPLE], process.env.APIFY_TOKEN as string);
        actorsMcpServer.upsertTools(newTool);

        // Store the tool name list
        const names = actorsMcpServer.listAllToolNames();
        const expectedToolNames = [
            ...DEFAULT_TOOL_NAMES,
            ...defaults.actors,
            ...addRemoveTools.map((tool) => tool.tool.name),
            ...[ACTOR_PYTHON_EXAMPLE],
        ];
        expectArrayWeakEquals(expectedToolNames, names);

        // Remove all tools
        actorsMcpServer.tools.clear();
        expect(actorsMcpServer.listAllToolNames()).toEqual([]);

        // Load the tool state from the tool name list
        await actorsMcpServer.loadToolsByName(names, process.env.APIFY_TOKEN as string);

        // Check if the tool name list is restored
        expectArrayWeakEquals(actorsMcpServer.listAllToolNames(), expectedToolNames);
    });

    it('should reset and restore tool state with default tools', async () => {
        const actorsMCPServer = new ActorsMcpServer({
            actors: [],
            tools: [],
            fullActorSchema: false,
            enableAddingActors: true,
            enableDefaultActors: true,
        }, false);
        await actorsMCPServer.initialize();

        const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;
        const toolList = actorsMCPServer.listAllToolNames();
        expect(toolList.length).toEqual(numberOfTools);
        // Add a new Actor
        const newTool = await getActorsAsTools([ACTOR_PYTHON_EXAMPLE], process.env.APIFY_TOKEN as string);
        actorsMCPServer.upsertTools(newTool);

        // Store the tool name list
        const toolListWithActor = actorsMCPServer.listAllToolNames();
        expect(toolListWithActor.length).toEqual(numberOfTools + 1); // + 1 for the added Actor

        // Remove all tools
        await actorsMCPServer.reset();
        // We connect second client so that the default tools are loaded
        // if no specific list of Actors is provided
        const toolListAfterReset = actorsMCPServer.listAllToolNames();
        expect(toolListAfterReset.length).toEqual(numberOfTools);
    });

    it('should notify tools changed handler on tool modifications', async () => {
        let latestTools: string[] = [];
        const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;

        let toolNotificationCount = 0;
        const onToolsChanged = (tools: string[]) => {
            latestTools = tools;
            toolNotificationCount++;
        };

        const actorsMCPServer = new ActorsMcpServer({
            actors: [],
            tools: [],
            fullActorSchema: false,
            enableAddingActors: true,
            enableDefaultActors: true,
        }, false);
        await actorsMCPServer.initialize();
        actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

        // Add a new Actor
        const actor = ACTOR_PYTHON_EXAMPLE;
        const newTool = await getActorsAsTools([actor], process.env.APIFY_TOKEN as string);
        actorsMCPServer.upsertTools(newTool, true);

        // Check if the notification was received with the correct tools
        expect(toolNotificationCount).toBe(1);
        expect(latestTools.length).toBe(numberOfTools + 1);
        expect(latestTools).toContain(actor);
        for (const tool of [...defaultTools, ...addRemoveTools]) {
            expect(latestTools).toContain(tool.tool.name);
        }
        for (const tool of defaults.actors) {
            expect(latestTools).toContain(tool);
        }

        // Remove the Actor
        actorsMCPServer.removeToolsByName([actorNameToToolName(actor)], true);

        // Check if the notification was received with the correct tools
        expect(toolNotificationCount).toBe(2);
        expect(latestTools.length).toBe(numberOfTools);
        expect(latestTools).not.toContain(actor);
        for (const tool of [...defaultTools, ...addRemoveTools]) {
            expect(latestTools).toContain(tool.tool.name);
        }
        for (const tool of defaults.actors) {
            expect(latestTools).toContain(tool);
        }
    });

    it('should stop notifying after unregistering tools changed handler', async () => {
        let latestTools: string[] = [];
        let notificationCount = 0;
        const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;
        const onToolsChanged = (tools: string[]) => {
            latestTools = tools;
            notificationCount++;
        };

        const actorsMCPServer = new ActorsMcpServer({
            actors: [],
            tools: [],
            fullActorSchema: false,
            enableAddingActors: true,
            enableDefaultActors: true,
        }, false);
        await actorsMCPServer.initialize();
        actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

        // Add a new Actor
        const actor = ACTOR_PYTHON_EXAMPLE;
        const newTool = await getActorsAsTools([actor], process.env.APIFY_TOKEN as string);
        actorsMCPServer.upsertTools(newTool, true);

        // Check if the notification was received
        expect(notificationCount).toBe(1);
        expect(latestTools.length).toBe(numberOfTools + 1);
        expect(latestTools).toContain(actor);

        actorsMCPServer.unregisterToolsChangedHandler();

        // Remove the Actor
        actorsMCPServer.removeToolsByName([actorNameToToolName(actor)], true);

        // Check if the notification was NOT received
        expect(notificationCount).toBe(1);
    });
});
