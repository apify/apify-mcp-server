import { describe, expect, it, vi } from 'vitest';

import { TOOL_STATUS } from '../../src/const.js';
import { executeToolForCall, executeToolForTask } from '../../src/mcp/tool_execution.js';
import type { ToolEntry } from '../../src/types.js';

function createInternalTool(
    callResult: object,
    name = 'mock-internal-tool',
): ToolEntry {
    return {
        type: 'internal',
        name,
        title: 'Mock Internal Tool',
        description: 'Mock Internal Tool Description',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        ajvValidate: vi.fn(() => true) as unknown as ToolEntry['ajvValidate'],
        call: vi.fn(async () => callResult),
    } as ToolEntry;
}

function createBaseCallParams(tool: ToolEntry): Parameters<typeof executeToolForCall>[0] {
    return {
        tool,
        args: { input: true },
        apifyToken: 'token',
        progressToken: undefined,
        extra: {
            requestId: 1,
            sendRequest: vi.fn(async () => ({})),
            sendNotification: vi.fn(async () => undefined),
            signal: new AbortController().signal,
        } as unknown as Parameters<typeof executeToolForCall>[0]['extra'],
        mcpSessionId: 'session-id',
        userRentedActorIds: undefined,
        apifyMcpServer: {} as never,
        mcpServer: {
            sendLoggingMessage: vi.fn(async () => undefined),
        } as never,
    };
}

function createBaseTaskParams(tool: ToolEntry): Parameters<typeof executeToolForTask>[0] {
    return {
        ...createBaseCallParams(tool),
        taskId: 'task-id',
    };
}

describe('executeToolForCall', () => {
    it('should return internalToolStatus from internal tool output', async () => {
        const tool = createInternalTool({
            content: [],
            internalToolStatus: TOOL_STATUS.SOFT_FAIL,
        });

        const result = await executeToolForCall(createBaseCallParams(tool));

        expect(result.handled).toBe(true);
        expect(result.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
        expect(result.response).toEqual({ content: [] });
    });

    it('should infer failed status from isError for internal tools', async () => {
        const tool = createInternalTool({
            content: [],
            isError: true,
        });

        const result = await executeToolForCall(createBaseCallParams(tool));

        expect(result.handled).toBe(true);
        expect(result.toolStatus).toBe(TOOL_STATUS.FAILED);
    });
});

describe('executeToolForTask', () => {
    it('should return response and status for internal task execution', async () => {
        const tool = createInternalTool({
            content: [{ type: 'text', text: 'ok' }],
            internalToolStatus: TOOL_STATUS.SOFT_FAIL,
        });

        const result = await executeToolForTask(createBaseTaskParams(tool));

        expect(result.toolStatus).toBe(TOOL_STATUS.SOFT_FAIL);
        expect(result.response).toEqual({
            content: [{ type: 'text', text: 'ok' }],
        });
    });
});
