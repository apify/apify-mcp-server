import { describe, expect, it } from 'vitest';

import { actorTaskOutputSchema } from '../../src/tools/structured_output_schemas.js';
import { publishActorTask } from '../../src/tools/tasks/publish_actor_task.js';
import type { HelperTool } from '../../src/types.js';
import { mockTask, mockTaskApiClient } from './helpers/task_client.js';
import {
    expectSchemaConformingStructuredContent,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

describe('publish-actor-task', () => {
    it('publishes the task and returns the publication subset only', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        const context = stubToolCallContext({ taskId: 'task-1' }, apifyClient);
        const result = (await (publishActorTask as HelperTool).call(context)) as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(calls).toEqual([{ fn: 'publish', taskId: '~task-1' }]);

        expectSchemaConformingStructuredContent(result, actorTaskOutputSchema);
        expect(result.structuredContent).toMatchObject({
            taskId: 'task-1',
            actorId: 'actor-id-1',
            name: 'my-task',
            publishedAt: '2026-08-01T10:00:00.000Z',
        });

        // content[0] is the JSON mirror; content[1] is the summary narrative.
        expect(result.content).toHaveLength(2);
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content[1].text).toContain('my-task');

        // Internal fields must NOT leak. Input values are returned by contract (the platform
        // encrypts fields declared as secret before they ever reach the client).
        const dump = JSON.stringify(result);
        expect(dump).not.toContain('user-secret');
    });

    it('resolves a 17-character name to its ID before publishing', async () => {
        // A bare 17-alnum value is shape-identical to an ID; publishing under the wrong reading
        // would 404 even though the task exists.
        const stored = mockTask({ id: 'realtaskid1234567', name: 'zzmcpcprobeseven1' });
        const { apifyClient, calls } = mockTaskApiClient((taskId: string) =>
            taskId === 'zzmcpcprobeseven1' ? undefined : stored,
        );
        await (publishActorTask as HelperTool).call(stubToolCallContext({ taskId: 'zzmcpcprobeseven1' }, apifyClient));

        expect(calls).toEqual([
            { fn: 'get', taskId: 'zzmcpcprobeseven1' },
            { fn: 'get', taskId: '~zzmcpcprobeseven1' },
            { fn: 'publish', taskId: 'realtaskid1234567' },
        ]);
    });
});
