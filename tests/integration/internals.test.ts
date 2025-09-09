import { beforeAll, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { actorNameToToolName } from '../../dist/tools/utils.js';
import { ActorsMcpServer } from '../../src/index.js';
import { addTool } from '../../src/tools/helpers.js';
import { getActorsAsTools } from '../../src/tools/index.js';
import type { Input } from '../../src/types.js';
import { loadToolsFromInput } from '../../src/utils/tools-loader.js';
import { ACTOR_PYTHON_EXAMPLE } from '../const.js';
import { expectArrayWeakEquals } from '../helpers.js';

beforeAll(() => {
    log.setLevel(log.LEVELS.OFF);
});

describe('MCP server internals integration tests', () => {
    it('should load and restore tools from a tool list', async () => {
        const actorsMcpServer = new ActorsMcpServer(false);
        const initialTools = await loadToolsFromInput({
            enableAddingActors: true,
        } as Input, process.env.APIFY_TOKEN as string);
        actorsMcpServer.upsertTools(initialTools);

        // Load new tool
        const newTool = await getActorsAsTools([ACTOR_PYTHON_EXAMPLE], process.env.APIFY_TOKEN as string);
        actorsMcpServer.upsertTools(newTool);

        // Store the tool name list
        const names = actorsMcpServer.listAllToolNames();
        // With enableAddingActors=true and no tools/actors, we should only have add-actor initially
        const expectedToolNames = [
            addTool.tool.name,
            ACTOR_PYTHON_EXAMPLE,
            'get-actor-output',
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

    it('should notify tools changed handler on tool modifications', async () => {
        let latestTools: string[] = [];
        // With enableAddingActors=true and no tools/actors, seeded set contains only add-actor
        const numberOfTools = 2;

        let toolNotificationCount = 0;
        const onToolsChanged = (tools: string[]) => {
            latestTools = tools;
            toolNotificationCount++;
        };

        const actorsMCPServer = new ActorsMcpServer(false);
        const seeded = await loadToolsFromInput({ enableAddingActors: true } as Input, process.env.APIFY_TOKEN as string);
        actorsMCPServer.upsertTools(seeded);
        actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

        // Add a new Actor
        const actor = ACTOR_PYTHON_EXAMPLE;
        const newTool = await getActorsAsTools([actor], process.env.APIFY_TOKEN as string);
        actorsMCPServer.upsertTools(newTool, true);

        // Check if the notification was received with the correct tools
        expect(toolNotificationCount).toBe(1);
        expect(latestTools.length).toBe(numberOfTools + 1);
        expect(latestTools).toContain(actor);
        expect(latestTools).toContain(addTool.tool.name);
        // No default actors are present when only add-actor is enabled by default

        // Remove the Actor
        actorsMCPServer.removeToolsByName([actorNameToToolName(actor)], true);

        // Check if the notification was received with the correct tools
        expect(toolNotificationCount).toBe(2);
        expect(latestTools.length).toBe(numberOfTools);
        expect(latestTools).not.toContain(actor);
        expect(latestTools).toContain(addTool.tool.name);
        // No default actors are present by default in this mode
    });

    it('should stop notifying after unregistering tools changed handler', async () => {
        let latestTools: string[] = [];
        let notificationCount = 0;
        const numberOfTools = 2;
        const onToolsChanged = (tools: string[]) => {
            latestTools = tools;
            notificationCount++;
        };

        const actorsMCPServer = new ActorsMcpServer(false);
        const seeded = await loadToolsFromInput({ enableAddingActors: true } as Input, process.env.APIFY_TOKEN as string);
        actorsMCPServer.upsertTools(seeded);
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
