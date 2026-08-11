import { describe, expect, it } from 'vitest';

import { actorTaskOutputSchema } from '../../src/tools/structured_output_schemas.js';
import { createActorTask } from '../../src/tools/tasks/create_actor_task.js';
import { getActorTask } from '../../src/tools/tasks/get_actor_task.js';
import { updateActorTask } from '../../src/tools/tasks/update_actor_task.js';
import type { HelperTool } from '../../src/types.js';
import { mockTask, mockTaskApiClient } from './helpers/task_client.js';
import {
    expectSchemaConformingStructuredContent,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

type StructuredResult = TextToolResult & { structuredContent: Record<string, unknown> };

describe('get-actor-task', () => {
    it('returns the task subset with input field names but no input values', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        const result = (await (getActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'task-1' }, apifyClient),
        )) as StructuredResult;

        expect(calls).toEqual([{ fn: 'get' }]);
        expectSchemaConformingStructuredContent(result, actorTaskOutputSchema);
        expect(result.structuredContent).toMatchObject({
            taskId: 'task-1',
            actorId: 'actor-id-1',
            name: 'my-task',
            publishedAt: '2026-08-01T10:00:00.000Z',
            inputFields: ['query', 'apiKey'],
        });
        expect(result.structuredContent.publicConfig).toEqual({
            seoTitle: 'Seo title',
            datasetView: 'overview',
        });

        // Input values and internal fields must NOT leak.
        const dump = JSON.stringify(result);
        expect(dump).not.toContain('secret-input-value');
        expect(dump).not.toContain('user-secret');
    });

    it('normalizes a Date publishedAt into an ISO string', async () => {
        // The client's `parseDateFields` turns `publicConfig.publishedAt` into a Date, while the raw
        // publication call leaves a string. The declared output schema promises a string either way.
        const { apifyClient } = mockTaskApiClient(
            mockTask({ publicConfig: { publishedAt: new Date('2026-08-01T10:00:00.000Z') } }),
        );
        const result = (await (getActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'task-1' }, apifyClient),
        )) as StructuredResult;

        expect(result.structuredContent.publishedAt).toBe('2026-08-01T10:00:00.000Z');
        expectSchemaConformingStructuredContent(result, actorTaskOutputSchema);
    });

    it('reports a missing task without throwing', async () => {
        const { apifyClient } = mockTaskApiClient(undefined);
        const result = (await (getActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'nope' }, apifyClient),
        )) as TextToolResult;

        expect(result.content[0].text).toContain('not found');
    });
});

describe('create-actor-task', () => {
    it('maps the flat run options into the options object', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (createActorTask as HelperTool).call(
            stubToolCallContext(
                {
                    actorId: 'actor-id-1',
                    name: 'my-task',
                    input: { query: 'cats' },
                    title: 'My task',
                    build: 'latest',
                    memoryMbytes: 1024,
                },
                apifyClient,
            ),
        );

        expect(calls).toEqual([
            {
                fn: 'create',
                payload: {
                    actId: 'actor-id-1',
                    name: 'my-task',
                    input: { query: 'cats' },
                    title: 'My task',
                    options: { build: 'latest', timeoutSecs: undefined, memoryMbytes: 1024 },
                },
            },
        ]);
    });

    it('rejects a name the API would reject', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());

        // Too short, and an underscore is not DNS-safe — both must fail before the API call.
        for (const name of ['ab', 'my_task']) {
            await expect(
                (createActorTask as HelperTool).call(stubToolCallContext({ actorId: 'actor-id-1', name }, apifyClient)),
            ).rejects.toThrow();
        }
        expect(calls).toEqual([]);
    });

    it('omits options entirely when no run option is given', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (createActorTask as HelperTool).call(
            stubToolCallContext({ actorId: 'actor-id-1', name: 'my-task' }, apifyClient),
        );

        expect(calls[0].payload).toEqual({ actId: 'actor-id-1', name: 'my-task' });
    });

    it('passes publicConfig through so a task can be staged for publishing in one call', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (createActorTask as HelperTool).call(
            stubToolCallContext(
                {
                    actorId: 'actor-id-1',
                    name: 'my-task',
                    publicConfig: { inputSchemaFields: ['query'], datasetView: 'overview' },
                },
                apifyClient,
            ),
        );

        expect(calls[0].payload).toEqual({
            actId: 'actor-id-1',
            name: 'my-task',
            publicConfig: { inputSchemaFields: ['query'], datasetView: 'overview' },
        });
    });

    it('sends only actId when no name is given, letting the API generate one', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (createActorTask as HelperTool).call(stubToolCallContext({ actorId: 'actor-id-1' }, apifyClient));

        expect(calls[0].payload).toEqual({ actId: 'actor-id-1' });
    });
});

describe('update-actor-task', () => {
    it('passes publicConfig through so a task can be prepared for publishing', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        const result = (await (updateActorTask as HelperTool).call(
            stubToolCallContext(
                {
                    taskId: 'task-1',
                    publicConfig: { inputSchemaFields: ['query'], datasetView: 'overview' },
                },
                apifyClient,
            ),
        )) as StructuredResult;

        expect(calls).toEqual([
            {
                fn: 'update',
                payload: { publicConfig: { inputSchemaFields: ['query'], datasetView: 'overview' } },
            },
        ]);
        expectSchemaConformingStructuredContent(result, actorTaskOutputSchema);
    });

    it('sends only the provided fields', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (updateActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'task-1', title: 'Renamed' }, apifyClient),
        );

        expect(calls[0].payload).toEqual({ title: 'Renamed' });
    });
});
