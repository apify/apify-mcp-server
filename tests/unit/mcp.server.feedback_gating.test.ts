import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { shareFeedback } from '../../src/tools/feedback/share_feedback.js';
import { ServerMode } from '../../src/types.js';

type InitHandler = (req: InitializeRequest, ctx: unknown) => Promise<unknown>;

function makeServer(): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode: ServerMode.DEFAULT,
        telemetry: { enabled: false },
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
    )// eslint-disable-next-line no-underscore-dangle
    ._requestHandlers
        .get('initialize');
    if (!handler) throw new Error('initialize handler not registered');
    await handler(makeInitializeRequest(clientName), {});
}

describe('share-feedback client gating', () => {
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

    it('drops share-feedback for an Anthropic client even when it is explicitly added', async () => {
        const server = track(makeServer());
        await dispatchInitialize(server, 'claude-ai');

        server.upsertTools([shareFeedback]);

        expect(server.tools.has(HelperTools.FEEDBACK_SHARE)).toBe(false);
    });

    it('keeps share-feedback for a non-Anthropic client', async () => {
        const server = track(makeServer());
        await dispatchInitialize(server, 'test-client');

        server.upsertTools([shareFeedback]);

        expect(server.tools.has(HelperTools.FEEDBACK_SHARE)).toBe(true);
    });
});
