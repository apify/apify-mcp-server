import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpError } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { validateAndPrepareToolCall } from '../../src/mcp/tool_call_validation.js';
import type { ActorsMcpServerOptions, ToolEntry } from '../../src/types.js';

type ToolCallRequest = {
    params: {
        name: string;
        arguments?: Record<string, unknown>;
        task?: { ttl?: number };
        _meta?: {
            apifyToken?: string;
            mcpSessionId?: string;
            progressToken?: string | number;
            userRentedActorIds?: string[];
        };
    };
};

function createMockTool(overrides: Partial<ToolEntry> = {}): ToolEntry {
    const ajvValidate = vi.fn(() => true) as unknown as ToolEntry['ajvValidate'];
    (ajvValidate as { errors?: unknown[] }).errors = [];

    return {
        type: 'internal',
        name: 'mock-tool',
        title: 'Mock Tool',
        description: 'Mock Tool Description',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        ajvValidate,
        call: vi.fn(async () => ({})),
        ...overrides,
    } as ToolEntry;
}

function createMockServer(sendLoggingMessage: ReturnType<typeof vi.fn>): Server {
    return { sendLoggingMessage } as unknown as Server;
}

function createBaseRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
    return {
        params: {
            name: 'mock-tool',
            arguments: {},
            _meta: {
                apifyToken: 'token',
                mcpSessionId: 'session-id',
            },
        },
        ...overrides,
    };
}

describe('validateAndPrepareToolCall', () => {
    it('should normalize local tool name prefix and decode dot-encoded argument keys', async () => {
        const tool = createMockTool();
        const tools = new Map<string, ToolEntry>([['mock-tool', tool]]);
        const sendLoggingMessage = vi.fn(async () => undefined);
        const request = createBaseRequest({
            params: {
                name: 'local__apify-actors__mock-tool',
                arguments: {
                    'input-dot-field': 'value',
                },
                _meta: {
                    apifyToken: 'token',
                    mcpSessionId: 'session-id',
                },
            },
        });

        const result = await validateAndPrepareToolCall({
            request,
            options: {} as ActorsMcpServerOptions,
            tools,
            server: createMockServer(sendLoggingMessage),
            listToolNames: () => ['mock-tool'],
        });

        expect(result.name).toBe('mock-tool');
        expect(result.args).toEqual({ 'input.field': 'value' });
        expect(result.tool).toBe(tool);
    });

    it('should throw McpError when arguments are missing', async () => {
        const tool = createMockTool();
        const tools = new Map<string, ToolEntry>([['mock-tool', tool]]);
        const sendLoggingMessage = vi.fn(async () => undefined);
        const request = createBaseRequest({
            params: {
                name: 'mock-tool',
                _meta: {
                    apifyToken: 'token',
                    mcpSessionId: 'session-id',
                },
            },
        });

        await expect(validateAndPrepareToolCall({
            request,
            options: {} as ActorsMcpServerOptions,
            tools,
            server: createMockServer(sendLoggingMessage),
            listToolNames: () => ['mock-tool'],
        })).rejects.toMatchObject({
            code: ErrorCode.InvalidParams,
        } satisfies Partial<McpError>);
        expect(sendLoggingMessage).toHaveBeenCalledOnce();
    });

    it('should throw McpError when task mode is requested for a non-task tool', async () => {
        const tool = createMockTool({
            execution: {
                taskSupport: 'forbidden',
            },
        });
        const tools = new Map<string, ToolEntry>([['mock-tool', tool]]);
        const sendLoggingMessage = vi.fn(async () => undefined);
        const request = createBaseRequest({
            params: {
                name: 'mock-tool',
                arguments: { input: true },
                task: { ttl: 60 },
                _meta: {
                    apifyToken: 'token',
                    mcpSessionId: 'session-id',
                },
            },
        });

        await expect(validateAndPrepareToolCall({
            request,
            options: {} as ActorsMcpServerOptions,
            tools,
            server: createMockServer(sendLoggingMessage),
            listToolNames: () => ['mock-tool'],
        })).rejects.toMatchObject({
            code: ErrorCode.InvalidParams,
        } satisfies Partial<McpError>);
        expect(sendLoggingMessage).toHaveBeenCalledOnce();
    });
});
