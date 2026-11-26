import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApifyClientModule from '../../src/apify_client.js';
import { TOOL_STATUS } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import * as telemetry from '../../src/telemetry.js';
import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import type { ActorsMcpServerOptions } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActors } from '../../src/utils/tools_loader.js';
import {
    getRequestHandler,
    getTaskStore,
    makeActorTool,
    withServer,
    withStatelessServer,
} from './helpers/mcp_server.js';
import { mockApifyClient } from './helpers/tool_context.js';

vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActors: vi.fn() };
});

// Every API request a tool call sends, the usage notice request included, goes through this axios stub.
const { requestApi } = vi.hoisted(() => ({ requestApi: vi.fn() }));
vi.mock('../../src/apify_client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ApifyClientModule>();
    return {
        ...actual,
        ApifyClient: class {
            httpClient = { axios: { request: requestApi } };

            user() {
                return { get: async () => ({ id: 'user-1' }) };
            }
        },
    };
});

const ACTOR_RESULT = { content: [{ type: 'text', text: 'Run finished.' }], structuredContent: { runId: 'run-1' } };
const NOTICE =
    '**Apify account notice:** This account has used $4.10 of the $5.00 monthly usage included in the Free plan.';
const NOTICE_RESPONSE = { status: 200, data: { data: { notice: NOTICE } } };

function serverOptions(): Partial<ActorsMcpServerOptions> {
    // A fresh token per test: "no notice" answers are cached by token. The notice is asked only with telemetry on.
    return { token: `token-${Math.random()}`, telemetry: { enabled: true, env: 'DEV' } };
}

async function loadActorTool(server: ActorsMcpServer) {
    vi.mocked(getActors).mockResolvedValue([{ ...makeActorTool(), execution: { taskSupport: 'optional' } }]);
    await server.loadToolsFromInput({ tools: [] }, mockApifyClient());
}

describe('usage notice on an Actor tool result', () => {
    beforeEach(() => {
        vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
        requestApi.mockReset();
        requestApi.mockResolvedValue(NOTICE_RESPONSE);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('comes last in a 2026-07-28 stateless result, which keeps its structured content', async () => {
        vi.spyOn(actorExecutor, 'executeActorTool').mockResolvedValue(ACTOR_RESULT as never);

        await withStatelessServer(async ({ server, call }) => {
            await loadActorTool(server);

            const response = await call('tools/call', { name: 'test-actor-tool', arguments: {} });

            expect(response.result).toMatchObject({
                content: [...ACTOR_RESULT.content, { type: 'text', text: NOTICE }],
                structuredContent: ACTOR_RESULT.structuredContent,
            });
        }, serverOptions());
    });

    it('comes last in a 2025-11-25 session result', async () => {
        vi.spyOn(actorExecutor, 'executeActorTool').mockResolvedValue(ACTOR_RESULT as never);

        await withServer(async (server) => {
            await loadActorTool(server);
            const initialize = { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code', version: '1' } };
            await getRequestHandler(server, 'initialize')(
                { method: 'initialize', params: { ...initialize, capabilities: {} } },
                {},
            );

            const result = await getRequestHandler(server, 'tools/call')(
                {
                    method: 'tools/call',
                    params: { name: 'test-actor-tool', arguments: {}, _meta: { mcpSessionId: 's1' } },
                },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            );

            expect(result.content).toEqual([...ACTOR_RESULT.content, { type: 'text', text: NOTICE }]);
            expect(requestApi).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: { toolName: 'test/actor', mcpClientName: initialize.clientInfo.name },
                }),
            );
        }, serverOptions());
    });

    it('comes last in a task result', async () => {
        vi.spyOn(actorExecutor, 'executeActorTool').mockResolvedValue(ACTOR_RESULT as never);

        await withServer(async (server) => {
            await loadActorTool(server);
            const params = {
                name: 'test-actor-tool',
                arguments: {},
                _meta: { mcpSessionId: 's1' },
                task: { ttl: 60_000 },
            };

            const { task } = (await getRequestHandler(server, 'tools/call')(
                { method: 'tools/call', params },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            )) as { task: { taskId: string } };
            const result = await vi.waitFor(async () => {
                const stored = await getTaskStore(server).getTaskResult(task.taskId);
                if (!stored) throw new Error('Task has no result yet');
                return stored;
            });

            expect(result.content).toEqual([...ACTOR_RESULT.content, { type: 'text', text: NOTICE }]);
        }, serverOptions());
    });

    it('records a task cancelled while the notice is requested as a finished run', async () => {
        vi.spyOn(actorExecutor, 'executeActorTool').mockResolvedValue(ACTOR_RESULT as never);
        let resolveTaskId!: (taskId: string) => void;
        const taskIdPromise = new Promise<string>((resolve) => {
            resolveTaskId = resolve;
        });
        let taskStore!: ReturnType<typeof getTaskStore>;
        // `tasks/cancel` lands while the API answers the notice request.
        requestApi.mockImplementation(async () => {
            await taskStore.updateTaskStatus(await taskIdPromise, 'cancelled', undefined, 's1');
            return NOTICE_RESPONSE;
        });

        await withServer(async (server) => {
            taskStore = getTaskStore(server);
            await loadActorTool(server);
            const params = {
                name: 'test-actor-tool',
                arguments: {},
                _meta: { mcpSessionId: 's1' },
                task: { ttl: 60_000 },
            };

            const { task } = (await getRequestHandler(server, 'tools/call')(
                { method: 'tools/call', params },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            )) as { task: { taskId: string } };
            resolveTaskId(task.taskId);

            await vi.waitFor(() =>
                expect(telemetry.trackToolCall).toHaveBeenCalledWith(
                    'user-1',
                    'DEV',
                    expect.objectContaining({ tool_status: TOOL_STATUS.SUCCEEDED }),
                ),
            );
            expect((await taskStore.getTask(task.taskId, 's1'))?.status).toBe('cancelled');
        }, serverOptions());
    });
});
