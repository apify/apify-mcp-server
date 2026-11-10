import { describe, expect, it } from 'vitest';

import { actorRunOutputSchema } from '../../src/tools/structured_output_schemas.js';
import { callActorTask } from '../../src/tools/tasks/call_actor_task.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { mockTask, mockTaskApiClient, mockTaskRun } from './helpers/task_client.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

type CallResult = TextToolResult & {
    structuredContent?: Record<string, unknown>;
    toolTelemetry?: ToolTelemetrySnapshot;
};

async function callTool(args: Record<string, unknown>, apifyClient: InternalToolArgs['apifyClient']) {
    return (await (callActorTask as HelperTool).call(stubToolCallContext(args, apifyClient))) as CallResult;
}

describe('call-actor-task starts the saved task', () => {
    it('starts the resolved task ID, not the name it was given', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask(), mockTaskRun());
        await callTool({ taskId: 'my-task', waitSecs: 0 }, apifyClient);

        expect(calls.map(({ fn, taskId }) => ({ fn, taskId }))).toEqual([
            { fn: 'get', taskId: '~my-task' },
            { fn: 'start', taskId: 'task-1' },
        ]);
    });

    it('passes input and callOptions through to the API', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask(), mockTaskRun());
        await callTool(
            { taskId: 'task-1', input: { query: 'dogs' }, callOptions: { memory: 1024, build: 'beta' }, waitSecs: 0 },
            apifyClient,
        );

        expect(calls.at(-1)).toEqual({
            fn: 'start',
            taskId: 'task-1',
            payload: { query: 'dogs' },
            options: { memory: 1024, build: 'beta' },
        });
    });

    it('sends no input when none is given, so the task keeps its saved input', async () => {
        const { apifyClient, calls } = mockTaskApiClient(mockTask(), mockTaskRun());
        await callTool({ taskId: 'task-1', waitSecs: 0 }, apifyClient);

        expect(calls.at(-1)).toMatchObject({ fn: 'start', payload: undefined });
    });

    it('reports a missing task and starts nothing', async () => {
        const { apifyClient, calls } = mockTaskApiClient(undefined, mockTaskRun());
        const result = await callTool({ taskId: 'nope', waitSecs: 0 }, apifyClient);

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toContain('nope');
        expect(calls.map(({ fn }) => fn)).not.toContain('start');
    });
});

describe('call-actor-task returns the run', () => {
    it('returns the start response without waiting when waitSecs is 0', async () => {
        const { apifyClient } = mockTaskApiClient(mockTask(), mockTaskRun());
        const result = await callTool({ taskId: 'task-1', waitSecs: 0 }, apifyClient);

        expectSchemaConformingStructuredContent(result, actorRunOutputSchema);
        expect(result.structuredContent).toMatchObject({ runId: 'run-1', status: 'READY' });
    });

    it('waits for the run and returns its current state', async () => {
        const finishedRun = mockTaskRun({ status: 'FAILED', finishedAt: new Date('2026-11-10T10:00:05.000Z') });
        const { apifyClient: taskClient } = mockTaskApiClient(mockTask(), mockTaskRun());
        const apifyClient = mockApifyClient({
            ...(taskClient as unknown as Record<string, unknown>),
            run: () => ({ get: async () => finishedRun }),
            actor: () => ({ get: async () => ({ username: 'apify', name: 'hello-world' }) }),
            dataset: () => ({ get: async () => undefined }),
            keyValueStore: () => ({ listKeys: async () => ({ items: [], isTruncated: false }) }),
        });
        const result = await callTool({ taskId: 'task-1', waitSecs: 5 }, apifyClient);

        expectSchemaConformingStructuredContent(result, actorRunOutputSchema);
        expect(result.structuredContent).toMatchObject({
            runId: 'run-1',
            status: 'FAILED',
            actorName: 'apify/hello-world',
        });
    });
});
