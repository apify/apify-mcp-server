import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { SERVER_MODE } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getLegacyServer } from './helpers/mcp_server.js';
import { mockApifyClient } from './helpers/tool_context.js';

// Stub getActors so default-injection seeding needs no network.
// Default-resolves to [] so tests that never call loadSendFeedbackByDefault still get a valid array.
vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActors: vi.fn().mockResolvedValue([]) };
});

type InitHandler = (req: InitializeRequest, ctx: unknown) => Promise<unknown>;

function makeServer(telemetryEnabled = true, initializeRequestData?: InitializeRequest): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode: SERVER_MODE.DEFAULT,
        telemetry: { enabled: telemetryEnabled },
        initializeRequestData,
    });
}

function makeInitializeRequest(clientName: string): InitializeRequest {
    return {
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: clientName, version: '1.0.0' },
            capabilities: {},
        },
    } as InitializeRequest;
}

async function dispatchInitialize(server: ActorsMcpServer, clientName: string): Promise<void> {
    const handler = (
        getLegacyServer(server) as unknown as {
            // eslint-disable-next-line no-underscore-dangle
            _requestHandlers: Map<string, InitHandler>;
        }
    )._requestHandlers // eslint-disable-next-line no-underscore-dangle
        .get('initialize');
    if (!handler) throw new Error('initialize handler not registered');
    await handler(makeInitializeRequest(clientName), {});
}

// Restoring by name is explicit (toolNamesToInput builds {tools:[...]}) — bypasses the blocklist.
async function loadSendFeedbackByName(server: ActorsMcpServer): Promise<void> {
    await server.loadToolsByName([HELPER_TOOLS.FEEDBACK_SEND], mockApifyClient());
}

// Default (no tools=) injection — not an explicit opt-in, so the client blocklist still applies.
async function loadSendFeedbackByDefault(server: ActorsMcpServer): Promise<void> {
    await server.loadToolsFromInput({}, mockApifyClient());
}

describe('send-feedback client gating', () => {
    const servers: ActorsMcpServer[] = [];

    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            await server?.close();
        }
    });

    const track = (server: ActorsMcpServer): ActorsMcpServer => {
        servers.push(server);
        return server;
    };

    it('hides send-feedback from an Anthropic client when composed before initialize', async () => {
        const server = track(makeServer());
        // Default (non-explicit) seeding — blocklist still applies.
        await loadSendFeedbackByDefault(server);
        expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(false);

        await dispatchInitialize(server, 'claude-ai');

        expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(false);
    });

    it('serves send-feedback to a non-Anthropic client when composed before initialize', async () => {
        const server = track(makeServer());
        await loadSendFeedbackByName(server);

        await dispatchInitialize(server, 'test-client');

        expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(true);
    });

    it('serves send-feedback to an Anthropic client restored after initialize (recovery path)', async () => {
        // Recovery counts as explicit — the session already had this tool.
        const server = track(makeServer());
        await dispatchInitialize(server, 'claude-ai');

        await loadSendFeedbackByName(server);

        expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(true);
    });

    it('serves send-feedback to an Anthropic client that selects the old report-problem name', async () => {
        // Old ?tools= URLs, including the listed Claude connector URL, still select report-problem.
        const server = track(makeServer());
        await server.loadToolsFromInput({ tools: ['report-problem'] }, mockApifyClient());

        await dispatchInitialize(server, 'claude-ai');

        expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(true);
    });

    it('serves send-feedback to a non-Anthropic client loaded after initialize', async () => {
        const server = track(makeServer());
        await dispatchInitialize(server, 'test-client');

        await loadSendFeedbackByName(server);

        expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(true);
    });

    // Recovery is explicit — same reasoning as above.
    it.each([
        { clientName: 'test-client', isAvailable: true },
        { clientName: 'claude-ai', isAvailable: true },
    ])(
        'uses constructor recovery data for client gating: $clientName available=$isAvailable',
        async ({ clientName, isAvailable }) => {
            const server = track(makeServer(true, makeInitializeRequest(clientName)));

            await loadSendFeedbackByName(server);

            expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(isAvailable);
        },
    );

    it('hides send-feedback when telemetry is disabled, even for a non-blocked client', async () => {
        // The tool's only function is forwarding submissions via telemetry; with telemetry off it
        // would just fake an acknowledgement, so it must not be served.
        const server = track(makeServer(false));
        await loadSendFeedbackByName(server);

        await dispatchInitialize(server, 'test-client');

        expect(server.tools.has(HELPER_TOOLS.FEEDBACK_SEND)).toBe(false);
    });

    // Only client-gated tools wait for the client; everything else must load eagerly, or a
    // recovery/rehydration node that restores tools via loadToolsByName without ever receiving an
    // initialize would silently lose all its helper tools.
    it('restores client-agnostic helper tools loaded before any initialize', async () => {
        const server = track(makeServer());

        await server.loadToolsByName([HELPER_TOOLS.ACTOR_RUNS_GET, HELPER_TOOLS.DATASET_GET_ITEMS], mockApifyClient());

        expect(server.tools.has(HELPER_TOOLS.ACTOR_RUNS_GET)).toBe(true);
        expect(server.tools.has(HELPER_TOOLS.DATASET_GET_ITEMS)).toBe(true);
    });
});
