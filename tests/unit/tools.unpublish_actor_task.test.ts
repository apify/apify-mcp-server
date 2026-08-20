import { describe, expect, it } from 'vitest';

import { actorTaskOutputSchema } from '../../src/tools/structured_output_schemas.js';
import { unpublishActorTask } from '../../src/tools/tasks/unpublish_actor_task.js';
import type { HelperTool } from '../../src/types.js';
import { mockTask, mockTaskApiClient } from './helpers/task_client.js';
import {
    expectSchemaConformingStructuredContent,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

describe('unpublish-actor-task', () => {
    it('unpublishes the task and reports a null publishedAt', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask({ publicConfig: { publishedAt: null } }));
        const context = stubToolCallContext({ taskId: 'task-1' }, apifyClient);
        const result = (await (unpublishActorTask as HelperTool).call(context)) as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(calls).toEqual([{ fn: 'unpublish', taskId: '~task-1' }]);
        expectSchemaConformingStructuredContent(result, actorTaskOutputSchema);
        expect(result.structuredContent).toMatchObject({
            taskId: 'task-1',
            actorId: 'actor-id-1',
            name: 'my-task',
            publishedAt: null,
        });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    });
});
