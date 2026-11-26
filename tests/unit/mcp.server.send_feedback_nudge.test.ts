import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import {
    SEND_FEEDBACK_INVALID_INPUT_NUDGE,
    SEND_FEEDBACK_NUDGE,
    sendFeedback,
} from '../../src/tools/dev/send_feedback.js';
import type { ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { respondServerError, respondUserError } from '../../src/utils/mcp.js';
import { getRequestHandler } from './helpers/mcp_server.js';

// The ACTOR branch of the tools/call handler runs actorExecutor.executeActorTool (a module
// singleton), not the tool's own call(). Mock it so we can return an isError result without a network.
vi.mock('../../src/tools/actors/actor_executor.js', () => ({
    actorExecutor: { executeActorTool: vi.fn() },
}));

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(async () => ({ userId: 'test-user', userPlanTier: 'FREE', isOrganization: false })),
}));

type HandlerFn = (req: Record<string, unknown>, extra: Record<string, unknown>) => Promise<Record<string, unknown>>;

const emptySchema = { type: 'object', properties: {} };

// Direct actor tool (TOOL_TYPE.ACTOR) with an always-passing input schema.
function makeActorTool(): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR,
        name: 'test-actor-tool',
        actorId: 'abc123',
        actorFullName: 'test/scraper',
        description: 'a scraper',
        inputSchema: emptySchema as ToolInputSchema,
        ajvValidate: compileSchema(emptySchema),
    } as ToolEntry;
}

function getToolCallHandler(server: ActorsMcpServer): HandlerFn {
    return getRequestHandler(server, 'tools/call');
}

// Dispatch a sync tools/call for the direct actor tool, with send-feedback served and the
// executor returning `executorResult`.
async function dispatchActorCall(executorResult: object): Promise<Record<string, unknown>> {
    vi.mocked(actorExecutor.executeActorTool).mockResolvedValue(executorResult as never);
    const server = new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        telemetry: { enabled: true },
        token: 'fake-token',
    });
    try {
        // Spread the frozen sendFeedback so server.close() can null its ajvValidate on teardown.
        server.upsertTools([{ ...sendFeedback }, makeActorTool()]);
        const handler = getToolCallHandler(server);
        return await handler(
            { method: 'tools/call', params: { name: 'test-actor-tool', arguments: {}, _meta: { mcpSessionId: 's1' } } },
            { signal: { aborted: false }, sendNotification: vi.fn() },
        );
    } finally {
        await server.close();
    }
}

const nudgeTexts = (r: Record<string, unknown>): string[] => (r.content as { text: string }[]).map((c) => c.text);

describe('send-feedback nudge on the direct ACTOR path', () => {
    afterEach(() => vi.clearAllMocks());

    it('appends the send-feedback sentence once to an internal error and strips internal toolTelemetry', async () => {
        const result = await dispatchActorCall(respondServerError('The Actor run failed.'));

        expect(result.isError).toBe(true);
        expect(nudgeTexts(result)).toEqual(['The Actor run failed.', SEND_FEEDBACK_NUDGE]);
        expect(result.toolTelemetry).toBeUndefined();
    });

    it('appends the friction sentence to a not-found failure', async () => {
        const result = await dispatchActorCall(respondUserError("Run with ID 'x' not found."));

        expect(result.isError).toBe(true);
        expect(nudgeTexts(result)).toEqual(["Run with ID 'x' not found.", SEND_FEEDBACK_INVALID_INPUT_NUDGE]);
    });
});
