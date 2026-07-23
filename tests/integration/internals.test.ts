import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { beforeAll, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/index.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { addActor } from '../../src/tools/actors/add_actor.js';
import { getActorsAsTools } from '../../src/tools/index.js';
import type { Input } from '../../src/types.js';
import { SERVER_MODE } from '../../src/types.js';
import { AUTO_INJECTED_TOOLS, loadToolsFromInput } from '../../src/utils/tools_loader.js';
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

        const { tools: newTool } = await getActorsAsTools([ACTOR_NORMAL_MODE], apifyClient);
        actorsMcpServer.upsertTools(newTool);

        const names = actorsMcpServer.listAllToolNames();
        // enableAddingActors=true now seeds call-actor (add-actor substituted, PR 0) + 4
        // auto-injected helpers; then ACTOR_NORMAL_MODE is added on top.
        const expectedToolNames = [
            HELPER_TOOLS.ACTOR_CALL,
            'get-actor-run',
            'get-dataset-items',
            'get-key-value-store-record',
            'abort-actor-run',
            ACTOR_NORMAL_MODE,
        ];
        expectArrayWeakEquals(expectedToolNames, names);

        actorsMcpServer.tools.clear();
        expect(actorsMcpServer.listAllToolNames()).toEqual([]);

        // Restore purely from the persisted name list — the round-trip under test.
        await actorsMcpServer.loadToolsByName(names, apifyClient);
        expectArrayWeakEquals(actorsMcpServer.listAllToolNames(), expectedToolNames);
    });

    // PR 0 restore-path race: a pre-cutoff session's stored names can contain 'add-actor'. Restore
    // must resolve it to itself, not the add-actor→call-actor substitution a live selector gets.
    it("restores a pre-cutoff session's stored add-actor name to itself, not call-actor", async () => {
        const actorsMcpServer = new ActorsMcpServer({
            setupSigintHandler: false,
            taskStore: new InMemoryTaskStore(),
            serverMode: SERVER_MODE.DEFAULT,
        });
        const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });

        // Simulate a pre-cutoff session: seed add-actor directly, bypassing the loader (which would
        // now substitute call-actor for a live selector).
        actorsMcpServer.upsertTools([addActor]);
        const names = actorsMcpServer.listAllToolNames();
        expectArrayWeakEquals([addActor.name], names);

        // Simulate the session being restored from its stored tool name list (e.g. on another node).
        actorsMcpServer.tools.clear();
        expect(actorsMcpServer.listAllToolNames()).toEqual([]);

        await actorsMcpServer.loadToolsByName(names, apifyClient);

        // Resolves to itself, plus add-actor's usual auto-injected run/storage helpers (pre-existing,
        // unrelated to this PR) — not the call-actor substitution.
        const expectedToolNames = [addActor.name, ...AUTO_INJECTED_TOOLS.map((t) => t.name)];
        expectArrayWeakEquals(actorsMcpServer.listAllToolNames(), expectedToolNames);
    });

    it('should notify tools changed handler on tool modifications', async () => {
        let latestTools: string[] = [];
        // enableAddingActors=true seeds call-actor (add-actor substituted, PR 0) + 4 auto-injected helpers.
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
        expect(latestTools).toContain(HELPER_TOOLS.ACTOR_CALL);
        // No default actors are present when only call-actor (add-actor substituted) is enabled by default

        // Remove the Actor
        actorsMCPServer.removeToolsByName([actorNameToToolName(actor)], true);

        // Check if the notification was received with the correct tools
        expect(toolNotificationCount).toBe(2);
        expect(latestTools.length).toBe(numberOfTools);
        expect(latestTools).not.toContain(actor);
        expect(latestTools).toContain(HELPER_TOOLS.ACTOR_CALL);
        // No default actors are present by default in this mode
    });

    it('should stop notifying after unregistering tools changed handler', async () => {
        let latestTools: string[] = [];
        let notificationCount = 0;
        // enableAddingActors=true seeds call-actor (add-actor substituted, PR 0) + 4 auto-injected helpers.
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
