import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import type { ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { ProgressTracker } from '../../src/utils/progress.js';
import { getRequestHandler, makeRecorderTool, withServer } from './helpers/mcp_server.js';

/**
 * Covers the request-metadata → `createProgressTracker` wiring in `tools/call`. The unit tests
 * for `get-actor-run` itself inject a fake tracker directly into the tool, so they would not
 * catch a regression in the server-level opt-in.
 */

async function runRecorder(toolName: string, meta: Record<string, unknown>) {
    return withServer(async (server) => {
        const { tool, received } = makeRecorderTool(toolName);
        server.upsertTools([tool]);
        const handler = getRequestHandler(server, 'tools/call');
        await handler(
            { method: 'tools/call', params: { name: toolName, arguments: {}, _meta: meta } },
            { sendNotification: vi.fn() },
        );
        return received;
    });
}

/** A minimal ACTOR tool; its executor is spied so the test can read the progressTracker it receives. */
function makeActorTool(): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR,
        name: 'test-actor-tool',
        description: 'actor',
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        actorId: 'test/actor',
        actorFullName: 'test/actor',
    } as ToolEntry;
}

describe('tools/call progressToken wiring', () => {
    afterEach(() => vi.restoreAllMocks());

    it('creates a ProgressTracker for get-actor-run when _meta.progressToken is provided', async () => {
        const received = await runRecorder(HELPER_TOOLS.ACTOR_RUNS_GET, {
            progressToken: 'tok-1',
            mcpSessionId: 'sess-1',
        });
        expect(received.progressTracker).toBeInstanceOf(ProgressTracker);
    });

    it('passes null progressTracker for get-actor-run when no progressToken is provided', async () => {
        const received = await runRecorder(HELPER_TOOLS.ACTOR_RUNS_GET, { mcpSessionId: 'sess-1' });
        expect(received.progressTracker).toBeNull();
    });

    it('does NOT create a ProgressTracker for an internal tool outside the opt-in set, even with a progressToken', async () => {
        // Opt-in is intentional: progress trackers cost notifications + bookkeeping and only make
        // sense for tools that emit during a sync wait. A future tool added to the opt-in set
        // should land here, not by accident.
        const received = await runRecorder('recorder-not-opted-in', { progressToken: 'tok-1', mcpSessionId: 'sess-1' });
        expect(received.progressTracker).toBeNull();
    });

    it('creates a ProgressTracker for a sync ACTOR tool unconditionally (not gated by the opt-in set)', async () => {
        // ACTOR tools always get a tracker in sync mode — unlike INTERNAL tools, which opt in by name.
        await withServer(async (server) => {
            let capturedTracker: ProgressTracker | null | undefined;
            vi.spyOn(actorExecutor, 'executeActorTool').mockImplementation(async (params) => {
                capturedTracker = params.progressTracker;
                return { content: [{ type: 'text', text: 'ok' }] };
            });
            server.upsertTools([makeActorTool()]);
            const handler = getRequestHandler(server, 'tools/call');
            await handler(
                {
                    method: 'tools/call',
                    params: {
                        name: 'test-actor-tool',
                        arguments: {},
                        _meta: { progressToken: 'tok-1', mcpSessionId: 'sess-1' },
                    },
                },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            );
            expect(capturedTracker).toBeInstanceOf(ProgressTracker);
        });
    });

    it('creates a ProgressTracker for a task-mode internal tool even without a progressToken', async () => {
        // Task mode always constructs a tracker (taskId + onStatusMessage); a tool outside the sync
        // opt-in set still receives one when run as a task, with no progressToken supplied.
        await withServer(async (server) => {
            const { tool, received } = makeRecorderTool('recorder-not-opted-in', { taskSupport: 'optional' });
            server.upsertTools([tool]);
            const handler = getRequestHandler(server, 'tools/call');
            await handler(
                {
                    method: 'tools/call',
                    params: {
                        name: 'recorder-not-opted-in',
                        arguments: {},
                        _meta: { mcpSessionId: 'sess-1' },
                        task: { ttl: 60_000 },
                    },
                },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            );
            await vi.waitFor(() => {
                if (!received.called) throw new Error('recorder tool was not called');
            });
            expect(received.progressTracker).toBeInstanceOf(ProgressTracker);
        });
    });
});
