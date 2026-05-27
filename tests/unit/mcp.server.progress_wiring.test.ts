import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import type { InternalToolArgs, ToolEntry } from '../../src/types.js';
import { ProgressTracker } from '../../src/utils/progress.js';

/**
 * Covers the request-metadata → `createProgressTracker` wiring in `tools/call`. The unit tests
 * for `get-actor-run` itself inject a fake tracker directly into the tool, so they would not
 * catch a regression in the server-level opt-in.
 *
 * TODO(followup): lift `withServer`, `getCallToolHandler`, and `makeRecorderTool` to
 * `tests/unit/_helpers/` and reuse from `mcp.task_notifications.test.ts` and
 * `mcp.server.capability_gating.test.ts` (both already duplicate the same server bootstrap and
 * `_requestHandlers.get(...)` getter). The recorder pattern generalizes to any "did the server
 * pass X to the tool?" assertion (apifyClient, extra.signal, userRentedActorIds, future opt-ins).
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

function makeRecorderTool(name: string): {
    tool: ToolEntry;
    received: { progressTracker: InternalToolArgs['progressTracker'] | undefined };
} {
    const received: { progressTracker: InternalToolArgs['progressTracker'] | undefined } = {
        progressTracker: undefined,
    };
    const tool: ToolEntry = {
        type: 'internal',
        name,
        description: 'recorder tool for progress wiring tests',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        ajvValidate: Object.assign(() => true, { errors: null }) as unknown as ToolEntry['ajvValidate'],
        paymentRequired: false,
        annotations: {},
        call: async (toolArgs: InternalToolArgs) => {
            received.progressTracker = toolArgs.progressTracker;
            return { content: [{ type: 'text', text: 'ok' }] };
        },
    } as ToolEntry;
    return { tool, received };
}

async function withServer<T>(run: (server: ActorsMcpServer) => Promise<T>): Promise<T> {
    const { ActorsMcpServer: ActorsMcpServerClass } = await import('../../src/mcp/server.js');
    const taskStore = new InMemoryTaskStore();
    const server = new ActorsMcpServerClass({
        taskStore,
        setupSigintHandler: false,
        telemetry: { enabled: false },
        token: 'fake-token',
    });
    try {
        return await run(server);
    } finally {
        await server.close();
    }
}

async function runRecorder(toolName: string, meta: Record<string, unknown>) {
    return withServer(async (server) => {
        const { tool, received } = makeRecorderTool(toolName);
        server.upsertTools([tool]);
        const handler = getCallToolHandler(server as never);
        await handler(
            { method: 'tools/call', params: { name: toolName, arguments: {}, _meta: meta } },
            { sendNotification: vi.fn() },
        );
        return received;
    });
}

describe('tools/call progressToken wiring', () => {
    it('creates a ProgressTracker for get-actor-run when _meta.progressToken is provided', async () => {
        const received = await runRecorder(HelperTools.ACTOR_RUNS_GET, {
            progressToken: 'tok-1',
            mcpSessionId: 'sess-1',
        });
        expect(received.progressTracker).toBeInstanceOf(ProgressTracker);
    });

    it('passes null progressTracker for get-actor-run when no progressToken is provided', async () => {
        const received = await runRecorder(HelperTools.ACTOR_RUNS_GET, { mcpSessionId: 'sess-1' });
        expect(received.progressTracker).toBeNull();
    });

    it('does NOT create a ProgressTracker for an internal tool outside the opt-in set, even with a progressToken', async () => {
        // Opt-in is intentional: progress trackers cost notifications + bookkeeping and only make
        // sense for tools that emit during a sync wait. A future tool added to the opt-in set
        // should land here, not by accident.
        const received = await runRecorder('recorder-not-opted-in', { progressToken: 'tok-1', mcpSessionId: 'sess-1' });
        expect(received.progressTracker).toBeNull();
    });
});
