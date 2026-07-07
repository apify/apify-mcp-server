import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { beforeAll, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { ApifyClient } from '../../src/apify_client.js';
import { ActorsMcpServer } from '../../src/index.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { addActor } from '../../src/tools/actors/add_actor.js';
import { getActorsAsTools } from '../../src/tools/index.js';
import type { Input } from '../../src/types.js';
import { SERVER_MODE } from '../../src/types.js';
import { loadToolsFromInput } from '../../src/utils/tools_loader.js';
import { ACTOR_NORMAL_MODE } from '../const.js';
import { expectArrayWeakEquals } from '../helpers.js';

beforeAll(() => {
    log.setLevel(log.LEVELS.OFF);
});

describe('MCP server internals integration tests', () => {
    it('should load and restore tools from a tool list', async () => {
        const actorsMcpServer = new ActorsMcpServer({
            setupSigintHandler: false,
            taskStore: new InMemoryTaskStore(),
            serverMode: SERVER_MODE.DEFAULT,
        });
        const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });
        const initialTools = await loadToolsFromInput(
            {
                enableAddingActors: true,
            } as Input,
            apifyClient,
            'default',
        );
        actorsMcpServer.upsertTools(initialTools);

        // Load new tool
        const { tools: newTool } = await getActorsAsTools([ACTOR_NORMAL_MODE], apifyClient);
        actorsMcpServer.upsertTools(newTool);

        // Store the tool name list
        const names = actorsMcpServer.listAllToolNames();
        // enableAddingActors=true seeds add-actor + 4 auto-injected helpers (get-actor-run, dataset, kv, abort);
        // then ACTOR_NORMAL_MODE is added on top.
        const expectedToolNames = [
            addActor.name,
            'get-actor-run',
            'get-dataset-items',
            'get-key-value-store-record',
            'abort-actor-run',
            ACTOR_NORMAL_MODE,
        ];
        expectArrayWeakEquals(expectedToolNames, names);

        // Remove all tools
        actorsMcpServer.tools.clear();
        expect(actorsMcpServer.listAllToolNames()).toEqual([]);

        // Load the tool state from the tool name list
        await actorsMcpServer.loadToolsByName(names, apifyClient);

        // Check if the tool name list is restored
        expectArrayWeakEquals(actorsMcpServer.listAllToolNames(), expectedToolNames);
    });

    it('should notify tools changed handler on tool modifications', async () => {
        let latestTools: string[] = [];
        // enableAddingActors=true seeds add-actor + 4 auto-injected helpers (get-actor-run, dataset, kv, abort)
        const numberOfTools = 5;

        let toolNotificationCount = 0;
        const onToolsChanged = (tools: string[]) => {
            latestTools = tools;
            toolNotificationCount++;
        };

        const actorsMCPServer = new ActorsMcpServer({
            setupSigintHandler: false,
            taskStore: new InMemoryTaskStore(),
            serverMode: SERVER_MODE.DEFAULT,
        });
        const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });
        const seeded = await loadToolsFromInput({ enableAddingActors: true } as Input, apifyClient, 'default');
        actorsMCPServer.upsertTools(seeded);
        actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

        // Add a new Actor
        const actor = ACTOR_NORMAL_MODE;
        const { tools: newTool } = await getActorsAsTools([actor], apifyClient);
        actorsMCPServer.upsertTools(newTool, true);

        // Check if the notification was received with the correct tools
        expect(toolNotificationCount).toBe(1);
        expect(latestTools.length).toBe(numberOfTools + 1);
        expect(latestTools).toContain(actor);
        expect(latestTools).toContain(addActor.name);
        // No default actors are present when only add-actor is enabled by default

        // Remove the Actor
        actorsMCPServer.removeToolsByName([actorNameToToolName(actor)], true);

        // Check if the notification was received with the correct tools
        expect(toolNotificationCount).toBe(2);
        expect(latestTools.length).toBe(numberOfTools);
        expect(latestTools).not.toContain(actor);
        expect(latestTools).toContain(addActor.name);
        // No default actors are present by default in this mode
    });

    it('should stop notifying after unregistering tools changed handler', async () => {
        let latestTools: string[] = [];
        let notificationCount = 0;
        // enableAddingActors=true seeds add-actor + 4 auto-injected helpers (get-actor-run, dataset, kv, abort)
        const numberOfTools = 5;
        const onToolsChanged = (tools: string[]) => {
            latestTools = tools;
            notificationCount++;
        };

        const actorsMCPServer = new ActorsMcpServer({
            setupSigintHandler: false,
            taskStore: new InMemoryTaskStore(),
            serverMode: SERVER_MODE.DEFAULT,
        });
        const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });
        const seeded = await loadToolsFromInput({ enableAddingActors: true } as Input, apifyClient, 'default');
        actorsMCPServer.upsertTools(seeded);
        actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

        // Add a new Actor
        const actor = ACTOR_NORMAL_MODE;
        const { tools: newTool } = await getActorsAsTools([actor], apifyClient);
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
