import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { beforeAll, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/index.js';
import { getActorsAsTools } from '../../src/tools/index.js';
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
                tools: ['call-actor'],
            },
            apifyClient,
            'default',
        );
        actorsMcpServer.upsertTools(initialTools);

        const { tools: newTool } = await getActorsAsTools([ACTOR_NORMAL_MODE], apifyClient);
        actorsMcpServer.upsertTools(newTool);

        const names = actorsMcpServer.listAllToolNames();
        // call-actor seeds the 4 auto-injected helpers; then ACTOR_NORMAL_MODE is added on top.
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

    // Restore round-trip coverage for a plain actor tool, kept after add-actor's removal (PR 2) —
    // previously exercised via a stored 'add-actor' name, now via a real Actor fixture instead.
    it("restores a session's stored actor tool name to itself via loadToolsByName", async () => {
        const actorsMcpServer = new ActorsMcpServer({
            setupSigintHandler: false,
            taskStore: new InMemoryTaskStore(),
            serverMode: SERVER_MODE.DEFAULT,
        });
        const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });

        // Simulate a session that already has an actor tool loaded, bypassing the loader.
        const { tools } = await getActorsAsTools([ACTOR_NORMAL_MODE], apifyClient);
        actorsMcpServer.upsertTools(tools);
        const names = actorsMcpServer.listAllToolNames();
        expectArrayWeakEquals([ACTOR_NORMAL_MODE], names);

        // Simulate the session being restored from its stored tool name list (e.g. on another node).
        actorsMcpServer.tools.clear();
        expect(actorsMcpServer.listAllToolNames()).toEqual([]);

        await actorsMcpServer.loadToolsByName(names, apifyClient);
        // Restore auto-injects the run/storage/abort helpers alongside any actor tool (pre-existing,
        // unrelated to add-actor's removal) — not just the actor tool itself.
        expectArrayWeakEquals(actorsMcpServer.listAllToolNames(), [
            ACTOR_NORMAL_MODE,
            ...AUTO_INJECTED_TOOLS.map((t) => t.name),
        ]);
    });
});
