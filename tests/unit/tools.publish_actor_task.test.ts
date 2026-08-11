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

        expect(calls).toEqual([{ fn: 'publish' }]);

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

        // Task input and internal fields must NOT leak.
        const dump = JSON.stringify(result);
        expect(dump).not.toContain('secret-input-value');
        expect(dump).not.toContain('user-secret');
    });
});
