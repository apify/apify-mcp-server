import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import type { ToolEntry } from '../../src/types.js';

describe('ActorsMcpServer task execution', () => {
    it('stores non-throwing soft-fail results for task-supporting tools like call-actor', async () => {
        const taskStore = new InMemoryTaskStore();
        const server = new ActorsMcpServer({
            taskStore,
            telemetry: { enabled: false },
            transportType: 'stdio',
        });

        const task = await taskStore.createTask(
            { ttl: 60_000 },
            'req-1',
            { method: 'tools/call', params: { name: 'call-actor' } },
        );

        const tool = {
            type: 'internal',
            name: 'call-actor',
            description: 'Call Actor',
            inputSchema: { type: 'object', properties: {} },
            ajvValidate: vi.fn(),
            execution: {
                taskSupport: 'optional',
            },
            call: vi.fn().mockResolvedValue({
                content: [{
                    type: 'text',
                    text: 'Actor \'missing/actor\' was not found.',
                }],
                isError: true,
                toolTelemetry: {
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                },
            }),
        } as unknown as ToolEntry;

        await (server as unknown as {
            executeToolAndUpdateTask: (params: Record<string, unknown>) => Promise<void>;
        }).executeToolAndUpdateTask({
            taskId: task.taskId,
            tool,
            toolArgs: {},
            logSafeArgs: {},
            apifyClient: {} as never,
            apifyToken: '',
            progressToken: undefined,
            extra: {
                signal: new AbortController().signal,
            },
            mcpSessionId: undefined,
        });

        // Stored as 'completed' because the SDK's requestStream() only delivers getTaskResult()
        // for 'completed' tasks. Error details are in the result payload (isError: true).
        const storedTask = await taskStore.getTask(task.taskId);
        expect(storedTask?.status).toBe('completed');

        const storedResult = await taskStore.getTaskResult(task.taskId);
        expect(storedResult).toMatchObject({
            isError: true,
            content: [{
                type: 'text',
                text: 'Actor \'missing/actor\' was not found.',
            }],
        });
    });
});
