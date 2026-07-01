import { describe, expect, it } from 'vitest';

import { abortActorRun } from '../../src/tools/runs/abort_actor_run.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

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

function stubClient(run: unknown): InternalToolArgs['apifyClient'] {
    return {
        run: (_id: string) => ({ abort: async () => run }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function abortContext(args: Record<string, unknown>, run: unknown): InternalToolArgs {
    return stubToolCallContext(args, stubClient(run));
}

describe('abort-actor-run', () => {
    it('returns structuredContent with summary, nextStep, and run subset', async () => {
        const run = mockAbortedRun();
        const result = await (abortActorRun as HelperTool).call(abortContext({ runId: 'run-1' }, run));
        const { structuredContent, content } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

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
});
