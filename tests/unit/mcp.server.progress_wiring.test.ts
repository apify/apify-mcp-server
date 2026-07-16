import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
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

describe('tools/call progressToken wiring', () => {
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
});
