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
    it('returns the task subset including the stored input', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        const result = (await (getActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'task-1' }, apifyClient),
        )) as StructuredResult;

        expect(calls).toEqual([{ fn: 'get', taskId: '~task-1' }]);
        expectSchemaConformingStructuredContent(result, actorTaskOutputSchema);
        expect(result.structuredContent).toMatchObject({
            taskId: 'task-1',
            actorId: 'actor-id-1',
            name: 'my-task',
            publishedAt: '2026-08-01T10:00:00.000Z',
            input: { query: 'cats', apiKey: 'secret-input-value' },
        });
        expect(result.structuredContent.publicConfig).toEqual({
            seoTitle: 'Seo title',
            datasetView: 'overview',
        });

        // Internal fields must NOT leak. Input values are returned by contract (the platform
        // encrypts fields declared as secret before they ever reach the client).
        const dump = JSON.stringify(result);
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

    // The API reads an unqualified taskId as an ID, so a bare name must go out as `~name` or the
    // lookup 404s. Anything that already names an owner, or is shaped like an ID, must survive
    // untouched.
    it.each([
        ['a bare name', 'insta-daily', '~insta-daily'],
        ['an already tilde-prefixed name', '~insta-daily', '~insta-daily'],
        ['a username and name', 'janjiran/insta-daily', 'janjiran/insta-daily'],
        ['a username and name in tilde form', 'janjiran~insta-daily', 'janjiran~insta-daily'],
        ['a 17-character ID', 'E2jjCZBezvAZnX8Rb', 'E2jjCZBezvAZnX8Rb'],
    ])('sends %s as "%s"', async (_label, given, expected) => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (getActorTask as HelperTool).call(stubToolCallContext({ taskId: given }, apifyClient));

        expect(calls).toEqual([{ fn: 'get', taskId: expected }]);
    });

    it('retries a 17-character value as a name when the ID lookup misses', async () => {
        // A bare 17-alnum value is shape-identical to an ID and to a legal task name, so a miss
        // under the ID reading must fall back to the name reading instead of reporting not-found.
        const stored = mockTask({ id: 'realtaskid1234567', name: 'zzmcpcprobeseven1' });
        const { apifyClient, calls } = mockTaskApiClient((taskId: string) =>
            taskId === '~zzmcpcprobeseven1' ? stored : undefined,
        );
        const result = (await (getActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'zzmcpcprobeseven1' }, apifyClient),
        )) as StructuredResult;

        expect(calls).toEqual([
            { fn: 'get', taskId: 'zzmcpcprobeseven1' },
            { fn: 'get', taskId: '~zzmcpcprobeseven1' },
        ]);
        expect(result.structuredContent).toMatchObject({ taskId: 'realtaskid1234567', name: 'zzmcpcprobeseven1' });
    });

    it('reports a missing task only after both the ID and the name lookup miss', async () => {
        const { apifyClient, calls } = mockTaskApiClient(() => undefined);
        const result = (await (getActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'zzmcpcprobeseven1' }, apifyClient),
        )) as TextToolResult;

        expect(calls).toEqual([
            { fn: 'get', taskId: 'zzmcpcprobeseven1' },
            { fn: 'get', taskId: '~zzmcpcprobeseven1' },
        ]);
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
                    actId: '~actor-id-1',
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

        expect(calls[0].payload).toEqual({ actId: '~actor-id-1', name: 'my-task' });
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
            actId: '~actor-id-1',
            name: 'my-task',
            publicConfig: { inputSchemaFields: ['query'], datasetView: 'overview' },
        });
    });

    it('sends only actId when no name is given, letting the API generate one', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (createActorTask as HelperTool).call(stubToolCallContext({ actorId: 'actor-id-1' }, apifyClient));

        expect(calls[0].payload).toEqual({ actId: '~actor-id-1' });
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
                taskId: '~task-1',
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

        expect(calls).toEqual([{ fn: 'update', taskId: '~task-1', payload: { title: 'Renamed' } }]);
    });

    it('passes an empty description to clear it', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask());
        await (updateActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'task-1', description: '' }, apifyClient),
        );

        expect(calls).toEqual([{ fn: 'update', taskId: '~task-1', payload: { description: '' } }]);
    });

    it('merges run options into the stored ones so the fields not being updated survive', async () => {
        // The API replaces `options` wholesale, so the tool must read the task first and send the
        // merged object — otherwise updating just `build` would wipe timeoutSecs/memoryMbytes.
        const { apifyClient, calls } = mockTaskApiClient(
            mockTask({ options: { build: 'latest', timeoutSecs: 300, memoryMbytes: 1024 } }),
        );
        await (updateActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'task-1', build: 'beta' }, apifyClient),
        );

        expect(calls).toEqual([
            { fn: 'get', taskId: '~task-1' },
            {
                // The pre-read pins the task, so the update goes out under its real ID.
                fn: 'update',
                taskId: 'task-1',
                payload: { options: { build: 'beta', timeoutSecs: 300, memoryMbytes: 1024 } },
            },
        ]);
    });

    it('resolves a 17-character name to its ID before updating', async () => {
        // Without the lookup the update would go out with the name read as an ID and 404 even
        // though the task exists.
        const stored = mockTask({ id: 'realtaskid1234567', name: 'zzmcpcprobeseven1' });
        const { apifyClient, calls } = mockTaskApiClient((taskId: string) =>
            taskId === 'zzmcpcprobeseven1' ? undefined : stored,
        );
        await (updateActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'zzmcpcprobeseven1', title: 'Renamed' }, apifyClient),
        );

        expect(calls).toEqual([
            { fn: 'get', taskId: 'zzmcpcprobeseven1' },
            { fn: 'get', taskId: '~zzmcpcprobeseven1' },
            { fn: 'update', taskId: 'realtaskid1234567', payload: { title: 'Renamed' } },
        ]);
    });

    it('reports a missing task from the options pre-read instead of failing on the update', async () => {
        // Only the options path reads first, so without this the update would run against a task
        // that does not exist and surface the raw API error instead of a not-found message.
        const { apifyClient, calls } = mockTaskApiClient(undefined);
        const result = (await (updateActorTask as HelperTool).call(
            stubToolCallContext({ taskId: 'nope', build: 'beta' }, apifyClient),
        )) as TextToolResult;

        expect(result.content[0].text).toContain('not found');
        expect(calls).toEqual([{ fn: 'get', taskId: '~nope' }]);
    });
});
