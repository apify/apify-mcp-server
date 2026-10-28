import { afterEach, describe, expect, it, vi } from 'vitest';

import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import type { ActorExecutionParams, ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { getRequestHandler, withServer } from './helpers/mcp_server.js';

const WEB_FETCH_ACTOR_ID = 'shu8hvrXbJbY3Eb9W';

function makeActorTool(actorFullName: string, actorId: string): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR,
        name: actorFullName.replace('/', '--'),
        description: 'actor',
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        actorId,
        actorFullName,
    } as ToolEntry;
}

describe('tip caveat on a direct Actor tool response', () => {
    afterEach(() => vi.restoreAllMocks());

    it('counts a loaded Actor tool as a way to run the Actor the tip recommends', async () => {
        await withServer(async (server) => {
            let canRunTipActor: ActorExecutionParams['canRunTipActor'];
            vi.spyOn(actorExecutor, 'executeActorTool').mockImplementation(async (params) => {
                canRunTipActor = params.canRunTipActor;
                return { content: [{ type: 'text', text: 'ok' }] };
            });
            server.upsertTools([
                makeActorTool('apify/rag-web-browser', '3ox4R101TgZz67sLr'),
                makeActorTool('apify/web-fetch', WEB_FETCH_ACTOR_ID),
            ]);

            await getRequestHandler(server, 'tools/call')(
                {
                    method: 'tools/call',
                    params: { name: 'apify--rag-web-browser', arguments: {}, _meta: { mcpSessionId: 'sess-1' } },
                },
                { signal: { aborted: false }, sendNotification: vi.fn() },
            );

            expect(canRunTipActor?.(WEB_FETCH_ACTOR_ID)).toBe(true);
            // No tool in the session runs an arbitrary Actor, so another Actor keeps the caveat.
            expect(canRunTipActor?.('aYG0l9s7dbB7j3gbS')).toBe(false);
        });
    });
});
