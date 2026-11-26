import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApifyClientModule from '../../src/apify_client.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import * as telemetry from '../../src/telemetry.js';
import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import type { ActorsMcpServerOptions, UsageThresholdDecision } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActors } from '../../src/utils/tools_loader.js';
import { buildUsageNoticeText } from '../../src/utils/usage_notice.js';
import { CYCLE_END_AT } from './helpers/account_limits.js';
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

// Every client the tool call creates reads an account at $4.10 of its $5 limit.
vi.mock('../../src/apify_client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ApifyClientModule>();
    const { limitsResponse } = await import('./helpers/account_limits.js');
    return {
        ...actual,
        ApifyClient: class {
            user() {
                return { get: async () => ({ id: 'user-1' }), limits: async () => limitsResponse(4.1) };
            }
        },
    };
});

const ACTOR_RESULT = { content: [{ type: 'text', text: 'Run finished.' }], structuredContent: { runId: 'run-1' } };
const NOTICE = buildUsageNoticeText('FREE', 0.8, { usedUsd: 4.1, limitUsd: 5, cycleEndAt: CYCLE_END_AT });

function serverOptions(): Partial<ActorsMcpServerOptions> {
    const decision: UsageThresholdDecision = { variant: 'notice', planType: 'FREE', isNoticeShown: true };
    // A fresh token per test: the usage cache is keyed by token. The check runs only with telemetry on.
    return {
        token: `token-${Math.random()}`,
        telemetry: { enabled: true, env: 'DEV' },
        onUsageThresholdCrossed: async () => decision,
    };
}

async function loadActorTool(server: ActorsMcpServer) {
    vi.mocked(getActors).mockResolvedValue([{ ...makeActorTool(), execution: { taskSupport: 'optional' } }]);
    await server.loadToolsFromInput({ tools: [] }, mockApifyClient());
}

describe('usage notice on an Actor tool result', () => {
    beforeEach(() => {
        vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
        vi.spyOn(telemetry, 'trackUsageThresholdCrossed').mockImplementation(() => {});
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
});
