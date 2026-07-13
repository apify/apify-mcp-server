import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import {
    REPORT_PROBLEM_INVALID_INPUT_NUDGE,
    REPORT_PROBLEM_NUDGE,
    reportProblem,
} from '../../src/tools/dev/report_problem.js';
import type { ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { respondUserError } from '../../src/utils/mcp.js';

// The ACTOR branch of the tools/call handler runs actorExecutor.executeActorTool (a module
// singleton), not the tool's own call(). Mock it so we can return an isError result without a network.
vi.mock('../../src/tools/actors/actor_executor.js', () => ({
    actorExecutor: { executeActorTool: vi.fn() },
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
    const handler = (
        server as unknown as { server: { _requestHandlers: Map<string, HandlerFn> } }
    ).server._requestHandlers // eslint-disable-next-line no-underscore-dangle
        .get('tools/call');
    if (!handler) throw new Error('tools/call handler not registered');
    return handler;
}

// Dispatch a sync tools/call for the direct actor tool, with report-problem served and the
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
        // Spread the frozen reportProblem so server.close() can null its ajvValidate on teardown.
        server.upsertTools([{ ...reportProblem }, makeActorTool()]);
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

describe('report-problem nudge on the direct ACTOR path', () => {
    afterEach(() => vi.clearAllMocks());

    it('appends the softer INVALID_INPUT nudge and strips internal toolTelemetry on dispatch', async () => {
        const result = await dispatchActorCall(respondUserError("Run with ID 'x' not found."));

        const texts = nudgeTexts(result);
        expect(result.isError).toBe(true);
        expect(texts).toContain(REPORT_PROBLEM_INVALID_INPUT_NUDGE);
        expect(texts).not.toContain(REPORT_PROBLEM_NUDGE);
        expect(result.toolTelemetry).toBeUndefined();
    });
});
