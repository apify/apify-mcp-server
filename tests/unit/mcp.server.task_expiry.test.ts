import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import type { InternalToolArgs, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';

/**
 * A long-running task whose TTL elapses before its result can be stored makes `storeTaskResult`
 * throw "Task with ID ... not found or expired" (the hosted RedisTaskStore message). This is a
 * benign terminal condition and must soft-fail, not surface as an error.
 */

type HandlerFn = (req: Record<string, unknown>, extra: Record<string, unknown>) => Promise<Record<string, unknown>>;

function getCallToolHandler(server: unknown): HandlerFn {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (server as { server: { _requestHandlers: Map<string, HandlerFn> } }).server._requestHandlers.get(
        'tools/call',
    );
    if (!handler) throw new Error('Handler "tools/call" not registered');
    return handler;
}

// Accepts the task but rejects result storage as if the task's TTL had already elapsed.
class ExpiringTaskStore extends InMemoryTaskStore {
    override async storeTaskResult(taskId: string): Promise<void> {
        throw new Error(`Task with ID ${taskId} not found or expired`);
    }
}

function makeTaskTool(name: string): ToolEntry {
    return {
        type: TOOL_TYPE.INTERNAL,
        name,
        description: 'tool that succeeds, used to test task-result storage failures',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        ajvValidate: Object.assign(() => true, { errors: null }) as unknown as ToolEntry['ajvValidate'],
        paymentRequired: false,
        annotations: {},
        execution: { taskSupport: 'optional' },
        call: async (_toolArgs: InternalToolArgs) => ({ content: [{ type: 'text', text: 'ok' }] }),
    } as ToolEntry;
}

describe('executeToolAndUpdateTask result storage on expired task', () => {
    afterEach(() => vi.restoreAllMocks());

    it('soft-fails instead of error-logging when the task expired before its result could be stored', async () => {
        const server = new ActorsMcpServer({
            taskStore: new ExpiringTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'fake-token',
        });
        try {
            const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
            const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);

            const toolName = 'task-recorder';
            server.upsertTools([makeTaskTool(toolName)]);
            const handler = getCallToolHandler(server as never);

            const response = await handler(
                {
                    method: 'tools/call',
                    params: { name: toolName, arguments: {}, task: { ttl: 60_000 }, _meta: { mcpSessionId: 'sess-1' } },
                },
                { sendNotification: vi.fn() },
            );
            // Task mode returns the task immediately; execution continues asynchronously.
            expect(response).toHaveProperty('task');

            await vi.waitFor(() => expect(softFail).toHaveBeenCalled());

            const errorMessages = errorLog.mock.calls.map((c) => c[0]);
            expect(errorMessages).not.toContain('executeToolAndUpdateTask failed unexpectedly');
            expect(errorMessages).not.toContain('Error executing tool for task');
        } finally {
            await server.close();
        }
    });
});
