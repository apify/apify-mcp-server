import { describe, expect, it, vi } from 'vitest';

import { abortActorRun } from '../../src/tools/runs/abort_actor_run.js';
import { actorRunOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

function mockAbortedRun(overrides: Record<string, unknown> = {}) {
    return {
        id: 'run-1',
        actId: 'actor-id-1',
        status: 'ABORTED',
        statusMessage: 'Aborted by user',
        startedAt: new Date('2026-05-01T10:00:00.000Z'),
        finishedAt: new Date('2026-05-01T10:00:05.000Z'),
        defaultDatasetId: 'dataset-xyz',
        defaultKeyValueStoreId: 'kv-xyz',
        stats: { runTimeSecs: 5, computeUnits: 0.01, memMaxBytes: 268435456 },
        // Billing/internal fields that the old raw-JSON dump leaked.
        userId: 'user-secret',
        buildId: 'build-secret',
        containerUrl: 'https://container.example',
        ...overrides,
    };
}

/** `get` returns the run before the call; `abort` returns `abortedRun`. */
function abortContext(args: Record<string, unknown>, run: unknown, abortedRun: unknown = run) {
    const abort = vi.fn(async () => abortedRun);
    const client = mockApifyClient({
        run: (_id: string) => ({ get: async () => run, abort }),
    });
    return { context: stubToolCallContext(args, client), abort };
}

describe('abort-actor-run', () => {
    it('returns structuredContent with summary, nextStep, and run subset', async () => {
        const { context, abort } = abortContext(
            { runId: 'run-1' },
            mockAbortedRun({ status: 'RUNNING' }),
            mockAbortedRun(),
        );
        const result = await (abortActorRun as HelperTool).call(context);
        const { structuredContent, content } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(abort).toHaveBeenCalledOnce();
        expect(structuredContent.runId).toBe('run-1');
        expect(structuredContent.actorId).toBe('actor-id-1');
        expect(structuredContent.status).toBe('ABORTED');
        expect(structuredContent.storages).toEqual({
            datasets: { default: { id: 'dataset-xyz' } },
            keyValueStores: { default: { id: 'kv-xyz' } },
        });
        expect(structuredContent.summary).toBeDefined();
        expect(structuredContent.nextStep).toBeDefined();

        // Billing/internal fields must NOT leak.
        const dump = JSON.stringify(structuredContent);
        expect(dump).not.toContain('user-secret');
        expect(dump).not.toContain('build-secret');
        expect(dump).not.toContain('container.example');

        // content[0] is the JSON mirror; content[1] is the summary + nextStep narrative.
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toBe(`${structuredContent.summary}\n${structuredContent.nextStep}`);
    });

    it('does not contain "Dataset metadata unavailable" for a SUCCEEDED run', async () => {
        const { context } = abortContext({ runId: 'run-1' }, mockAbortedRun({ status: 'SUCCEEDED' }));
        const result = await (abortActorRun as HelperTool).call(context);
        const { structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent.status).toBe('SUCCEEDED');
        expect(structuredContent.summary as string).not.toContain('Dataset metadata unavailable');
    });

    it.each(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'])(
        'says that nothing was aborted for a %s run and sends no abort',
        async (status) => {
            const { context, abort } = abortContext({ runId: 'run-1' }, mockAbortedRun({ status }));
            const result = await (abortActorRun as HelperTool).call(context);
            const { structuredContent, content } = result as TextToolResult & {
                structuredContent: { summary: string };
            };

            expect(abort).not.toHaveBeenCalled();

            expect(structuredContent.summary).toMatch(
                new RegExp(`^Nothing was aborted: the run had already finished\\. ${status} `),
            );
            expect(content[1].text.startsWith(structuredContent.summary)).toBe(true);
            expect(JSON.parse(content[0].text)).toEqual(structuredContent);
            expectSchemaConformingStructuredContent(result, actorRunOutputSchema);
        },
    );

    it.each(['ABORTING', 'ABORTED'])('keeps the status summary when the abort returns %s', async (status) => {
        const { context, abort } = abortContext(
            { runId: 'run-1' },
            mockAbortedRun({ status: 'RUNNING' }),
            mockAbortedRun({ status }),
        );
        const result = await (abortActorRun as HelperTool).call(context);
        const { structuredContent, content } = result as TextToolResult & {
            structuredContent: { summary: string };
        };

        expect(abort).toHaveBeenCalledOnce();
        expect(structuredContent.summary).toMatch(new RegExp(`^${status} after `));
        expect(content[1].text).not.toContain('Nothing was aborted');
        expectSchemaConformingStructuredContent(result, actorRunOutputSchema);
    });

    it('returns a not-found error for an unknown run and sends no abort', async () => {
        const { context, abort } = abortContext({ runId: 'missing-run' }, undefined);
        const result = await (abortActorRun as HelperTool).call(context);

        expect(abort).not.toHaveBeenCalled();
        expectSoftFailInvalidInput(result as { isError?: boolean });
        expect((result as TextToolResult).content[0].text).toBe("Run with ID 'missing-run' not found.");
    });
});
