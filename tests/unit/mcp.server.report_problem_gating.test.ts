import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { SERVER_MODE } from '../../src/types.js';

type InitHandler = (req: InitializeRequest, ctx: unknown) => Promise<unknown>;

function makeServer(telemetryEnabled = true): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode: SERVER_MODE.DEFAULT,
        telemetry: { enabled: telemetryEnabled },
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
        server.server as unknown as {
            // eslint-disable-next-line no-underscore-dangle
            _requestHandlers: Map<string, InitHandler>;
        }
    )._requestHandlers // eslint-disable-next-line no-underscore-dangle
        .get('initialize');
    if (!handler) throw new Error('initialize handler not registered');
    await handler(makeInitializeRequest(clientName), {});
}

// report-problem carries no actor name, so getActors short-circuits and never touches the client —
// this drives the real compose path (getToolsForServerMode + blocklist filter) without any network.
async function loadReportProblemByName(server: ActorsMcpServer): Promise<void> {
    await server.loadToolsByName([HELPER_TOOLS.PROBLEM_REPORT], {} as never);
}

describe('report-problem client gating', () => {
    const servers: ActorsMcpServer[] = [];

    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            server?.tools.clear();
            await server?.close();
        }
    });

    const track = (server: ActorsMcpServer): ActorsMcpServer => {
        servers.push(server);
        return server;
    };

    it('hides report-problem from an Anthropic client when composed before initialize', async () => {
        const server = track(makeServer());
        // Fixed mode: tools are requested before the client is known — they must wait for initialize.
        await loadReportProblemByName(server);
        expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);

        await dispatchInitialize(server, 'claude-ai');

        expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);
    });

    it('serves report-problem to a non-Anthropic client when composed before initialize', async () => {
        const server = track(makeServer());
        await loadReportProblemByName(server);

        await dispatchInitialize(server, 'test-client');

        expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(true);
    });

    it('hides report-problem from an Anthropic client loaded after initialize (recovery path)', async () => {
        const server = track(makeServer());
        await dispatchInitialize(server, 'claude-ai');

        await loadReportProblemByName(server);

        expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);
    });

    it('serves report-problem to a non-Anthropic client loaded after initialize', async () => {
        const server = track(makeServer());
        await dispatchInitialize(server, 'test-client');

        await loadReportProblemByName(server);

        expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(true);
    });

    it('hides report-problem when telemetry is disabled, even for a non-blocked client', async () => {
        // The tool's only function is forwarding submissions via telemetry; with telemetry off it
        // would just fake an acknowledgement, so it must not be served.
        const server = track(makeServer(false));
        await loadReportProblemByName(server);

        await dispatchInitialize(server, 'test-client');

        expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(false);
    });

    // Only client-gated tools wait for the client; everything else must load eagerly, or a
    // recovery/rehydration node that restores tools via loadToolsByName without ever receiving an
    // initialize would silently lose all its helper tools.
    it('restores client-agnostic helper tools loaded before any initialize', async () => {
        const server = track(makeServer());

        await server.loadToolsByName([HELPER_TOOLS.ACTOR_RUNS_GET, HELPER_TOOLS.DATASET_GET_ITEMS], {} as never);

        expect(server.tools.has(HELPER_TOOLS.ACTOR_RUNS_GET)).toBe(true);
        expect(server.tools.has(HELPER_TOOLS.DATASET_GET_ITEMS)).toBe(true);
    });
});
