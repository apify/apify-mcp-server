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

    describe('loadToolsFromInput()', () => {
        it('resolves the Claude connector selection to exactly the reviewed apps-mode tools', async () => {
            // Pins the `tools=` selection of the candidate Claude connector URL (apify/ai-team#229):
            // https://mcp.apify.com/?tools=search-actors,search-actors-widget,fetch-actor-details,fetch-actor-details-widget,search-apify-docs,fetch-apify-docs,get-actor-run,get-actor-run-widget,get-actor-run-list,get-actor-log,abort-actor-run,get-dataset-list,get-dataset,get-dataset-items,get-key-value-store-list,get-key-value-store,get-key-value-store-record,apify/rag-web-browser&client=claude
            // That URL is submitted to Anthropic and frozen; the loader is not. If this test fails,
            // the loader widened or reordered what the submitted URL serves — the URL itself has to
            // be revisited and resubmitted. Do not just edit the expected array to make it pass.
            // apify/web-fetch is not listed: it is an MCP-server Actor (webServerMcpPath + standby),
            // so getActorsAsTools routes it through getMCPServersAsTools, which yields hash-prefixed
            // proxy tool names — never apify--web-fetch.
            const candidateSelectors = [
                'search-actors',
                'search-actors-widget',
                'fetch-actor-details',
                'fetch-actor-details-widget',
                'search-apify-docs',
                'fetch-apify-docs',
                'get-actor-run',
                'get-actor-run-widget',
                'get-actor-run-list',
                'get-actor-log',
                'abort-actor-run',
                'get-dataset-list',
                'get-dataset',
                'get-dataset-items',
                'get-key-value-store-list',
                'get-key-value-store',
                'get-key-value-store-record',
                'apify/rag-web-browser',
            ];

            const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });
            const tools = await loadToolsFromInput({ tools: candidateSelectors }, apifyClient, SERVER_MODE.APPS);

            // Order matters: it is the order a reviewer of the submitted URL reads.
            expect(tools.map((tool) => tool.name)).toEqual([
                'search-actors',
                'search-actors-widget',
                'fetch-actor-details',
                'fetch-actor-details-widget',
                'search-apify-docs',
                'fetch-apify-docs',
                'get-actor-run',
                'get-actor-run-widget',
                'get-actor-run-list',
                'get-actor-log',
                'abort-actor-run',
                'get-dataset-list',
                'get-dataset',
                'get-dataset-items',
                'get-key-value-store-list',
                'get-key-value-store',
                'get-key-value-store-record',
                'apify--rag-web-browser',
            ]);

            // Every auto-injected helper must be named in the URL itself, not arrive via injection.
            for (const tool of AUTO_INJECTED_TOOLS) {
                expect(candidateSelectors).toContain(tool.name);
            }
        });
    });
});
