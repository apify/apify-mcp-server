/**
 * Regression guard: `resources/read` (the widget HTML / API-resource proxy) must tag its
 * ApifyClient with the same request-origin the `tools/call` path uses, not silently default
 * to MCP. `resolveApifyClient()` builds this client fresh per request from `initializeRequestData`,
 * which is already populated by the time `resources/read` can be reached (set synchronously in the
 * `initialize` handler, which completes before `notifications/initialized`/`resources/read` fire).
 */
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApifyClientModule from '../../src/apify_client.js';
import { APIFY_AI_CLIENT_NAME } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { getRequestHandler, makeRecorderTool } from './helpers/mcp_server.js';

const { capturedClientOptions } = vi.hoisted(() => ({ capturedClientOptions: [] as unknown[] }));

vi.mock('../../src/apify_client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ApifyClientModule>();
    return {
        ...actual,
        ApifyClient: class {
            constructor(options: unknown) {
                capturedClientOptions.push(options);
            }
        },
    };
});

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

beforeEach(() => {
    capturedClientOptions.length = 0;
});

describe('ActorsMcpServer resources/read — request-origin tagging', () => {
    it('tags the client APIFY_AI for an Apify AI client', async () => {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'test-token',
        });
        try {
            await getRequestHandler(server, 'initialize')(
                makeInitializeRequest(APIFY_AI_CLIENT_NAME) as unknown as Record<string, unknown>,
                {},
            );

            await getRequestHandler(server, 'resources/read')(
                { method: 'resources/read', params: { uri: 'ui://widget/unknown.html' } },
                {},
            ).catch(() => undefined);

            expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'APIFY_AI' });
        } finally {
            await server.close();
        }
    });

    it('tags the client MCP for any other client', async () => {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'test-token',
        });
        try {
            await getRequestHandler(server, 'initialize')(
                makeInitializeRequest('some-other-client') as unknown as Record<string, unknown>,
                {},
            );

            await getRequestHandler(server, 'resources/read')(
                { method: 'resources/read', params: { uri: 'ui://widget/unknown.html' } },
                {},
            ).catch(() => undefined);

            expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'MCP' });
        } finally {
            await server.close();
        }
    });
});

describe('ActorsMcpServer tools/call — request-origin tagging', () => {
    it.each([
        { isTaskRequest: false, toolName: 'sync-origin-tool' },
        { isTaskRequest: true, toolName: 'task-origin-tool' },
    ])('tags a $toolName client APIFY_AI', async ({ isTaskRequest, toolName }) => {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'test-token',
            initializeRequestData: makeInitializeRequest(APIFY_AI_CLIENT_NAME),
        });
        try {
            const { tool } = makeRecorderTool(toolName, {
                taskSupport: isTaskRequest ? 'optional' : undefined,
            });
            server.upsertTools([tool]);

            const result = await getRequestHandler(server, 'tools/call')(
                {
                    method: 'tools/call',
                    params: {
                        name: toolName,
                        arguments: {},
                        _meta: { mcpSessionId: 'session-id' },
                        ...(isTaskRequest && { task: { ttl: 60_000 } }),
                    },
                },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            );

            expect(capturedClientOptions.at(-1)).toMatchObject({ requestOrigin: 'APIFY_AI' });
            if (isTaskRequest) {
                await vi.waitFor(async () => {
                    const task = await server.taskStore.getTask((result.task as { taskId: string }).taskId);
                    if (task?.status !== 'completed') throw new Error('task did not complete');
                });
            }
        } finally {
            await server.close();
        }
    });
});
