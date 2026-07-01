import type { ActorRun } from 'apify-client';
import { describe, expect, it } from 'vitest';

import { actorExecutor } from '../../src/tools/actors/actor_executor.js';
import type { ActorExecutionParams } from '../../src/types.js';

/**
 * The executor's three migration-specific responsibilities:
 *  - strip MCP-only `waitSecs` from the input before `actor.start()` (Actor must not see it);
 *  - forward `waitSecs` to `fetchActorRunData` when the LLM opts in;
 *  - default `waitSecs` to 30 when the LLM omits it (same contract as `call-actor`).
 *
 * The downstream `fetchActorRunData` layer is covered exhaustively in
 * `tools.get_actor_run.response.test.ts`; here we only assert what the executor itself does.
 */

const ACTOR_FULL_NAME = 'apify/test-actor';

type Spies = {
    startInput?: unknown;
    waitForFinishOpts?: unknown;
};

function mockRunningRun(): ActorRun {
    return {
        id: 'run-1',
        actId: 'actor-id-1',
        status: 'RUNNING',
        startedAt: new Date('2026-05-01T10:00:00.000Z'),
        defaultDatasetId: 'dataset-xyz',
        defaultKeyValueStoreId: 'kv-xyz',
    } as unknown as ActorRun;
}

function mockSucceededRun(): ActorRun {
    return {
        id: 'run-1',
        actId: 'actor-id-1',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-05-01T10:00:00.000Z'),
        finishedAt: new Date('2026-05-01T10:00:22.000Z'),
        defaultDatasetId: 'dataset-xyz',
        defaultKeyValueStoreId: 'kv-xyz',
        stats: { runTimeSecs: 22 },
    } as unknown as ActorRun;
}

/**
 * The initial `run.get()` returns a non-terminal run so `fetchActorRunData` exercises the
 * `waitForFinish` path (otherwise it short-circuits and we can't observe the forwarded
 * `waitSecs`). After `waitForFinish` is called the stub flips state to SUCCEEDED so the
 * follow-up `run.get()` re-fetch inside `waitForRunWithProgress` lands on the terminal run.
 * `dataset.itemCount > 0` keeps the SUCCEEDED lag-probe from firing.
 */
function buildStub(): { client: ActorExecutionParams['apifyClient']; spies: Spies } {
    const spies: Spies = {};
    const startedRun = mockRunningRun();
    const finishedRun = mockSucceededRun();
    let currentRun: ActorRun = startedRun;
    const client = {
        actor: (_id: string) => ({
            start: async (input: unknown) => {
                spies.startInput = input;
                return startedRun;
            },
            get: async () => ({ id: 'actor-id-1', username: 'apify', name: 'test-actor' }),
        }),
        run: (_id: string) => ({
            get: async () => currentRun,
            waitForFinish: async (opts: unknown) => {
                spies.waitForFinishOpts = opts;
                currentRun = finishedRun;
                return finishedRun;
            },
            abort: async () => undefined,
        }),
        dataset: (_id: string) => ({
            get: async () => ({
                id: 'dataset-xyz',
                itemCount: 5,
                fields: ['url'],
            }),
            listItems: async () => ({ items: [], total: 5 }),
        }),
        keyValueStore: (_id: string) => ({
            listKeys: async () => ({ items: [], count: 0, isTruncated: false }),
        }),
    } as unknown as ActorExecutionParams['apifyClient'];
    return { client, spies };
}

function buildParams(
    input: Record<string, unknown>,
    overrides: Partial<ActorExecutionParams> = {},
): { params: ActorExecutionParams; spies: Spies } {
    const { client, spies } = buildStub();
    return {
        spies,
        params: {
            actorFullName: ACTOR_FULL_NAME,
            input,
            apifyClient: client,
            callOptions: {},
            mcpSessionId: 'test-session',
            ...overrides,
        },
    };
}

describe('actorExecutor', () => {
    describe('waitSecs handling', () => {
        it('strips waitSecs from the input passed to actor.start()', async () => {
            const { params, spies } = buildParams({ query: 'foo', waitSecs: 5 });

            await actorExecutor.executeActorTool(params);

            expect(spies.startInput).toEqual({ query: 'foo' });
            expect((spies.startInput as Record<string, unknown>)?.waitSecs).toBeUndefined();
        });

        it('forwards waitSecs to waitForFinish when the LLM opts in', async () => {
            const { params, spies } = buildParams({ query: 'foo', waitSecs: 5 });

            await actorExecutor.executeActorTool(params);

            expect(spies.waitForFinishOpts).toEqual({ waitSecs: 5 });
        });

        it('defaults waitSecs to 30 when the LLM omits it', async () => {
            const { params, spies } = buildParams({ query: 'foo' });

            await actorExecutor.executeActorTool(params);

            expect(spies.waitForFinishOpts).toEqual({ waitSecs: 30 });
            expect(spies.startInput).toEqual({ query: 'foo' });
        });

        it('ignores waitSecs in task mode and waits until terminal', async () => {
            const { params, spies } = buildParams({ query: 'foo', waitSecs: 5 }, { taskMode: true });

            await actorExecutor.executeActorTool(params);

            expect(spies.waitForFinishOpts).toEqual({ waitSecs: undefined });
            expect(spies.startInput).toEqual({ query: 'foo' });
        });
    });

    describe('success path', () => {
        it('returns the canonical RunResponse shape (no inline items, dataset id under storages)', async () => {
            const { params } = buildParams({ query: 'foo' });

            const result = await actorExecutor.executeActorTool(params);

            const { structuredContent } = result as { structuredContent?: Record<string, unknown> };
            expect(structuredContent).toBeDefined();
            expect(structuredContent?.runId).toBe('run-1');
            expect(structuredContent?.status).toBe('SUCCEEDED');
            expect(structuredContent?.summary).toBeDefined();
            expect(structuredContent?.nextStep).toBeDefined();
            const storages = structuredContent?.storages as { datasets?: { default?: { id?: string } } } | undefined;
            expect(storages?.datasets?.default?.id).toBe('dataset-xyz');
            // No legacy fields from the pre-migration shape.
            expect((structuredContent as Record<string, unknown>).items).toBeUndefined();
            expect((structuredContent as Record<string, unknown>).datasetId).toBeUndefined();
            expect((structuredContent as Record<string, unknown>).instructions).toBeUndefined();
        });
    });

    describe('itemsSchema injection', () => {
        it('injects datasetItemsSchema into storages.datasets.default.itemsSchema when provided', async () => {
            const itemProperties = { url: { type: 'string' }, price: { type: 'number' } };
            const { params } = buildParams({ query: 'foo' }, { datasetItemsSchema: itemProperties });

            const result = await actorExecutor.executeActorTool(params);

            const { structuredContent } = result as { structuredContent?: Record<string, unknown> };
            const storages = structuredContent?.storages as
                | {
                      datasets?: {
                          default?: { itemsSchema?: { type?: string; properties?: Record<string, unknown> } };
                      };
                  }
                | undefined;
            expect(storages?.datasets?.default?.itemsSchema?.type).toBe('object');
            expect(storages?.datasets?.default?.itemsSchema?.properties).toEqual(itemProperties);
        });

        it('omits itemsSchema when datasetItemsSchema is not provided', async () => {
            const { params } = buildParams({ query: 'foo' });

            const result = await actorExecutor.executeActorTool(params);

            const { structuredContent } = result as { structuredContent?: Record<string, unknown> };
            const storages = structuredContent?.storages as
                | {
                      datasets?: { default?: { itemsSchema?: unknown } };
                  }
                | undefined;
            expect(storages?.datasets?.default?.itemsSchema).toBeUndefined();
        });
    });

    describe('aborts', () => {
        it('returns null and skips actor.start() when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();
            const { params, spies } = buildParams({ query: 'foo' }, { abortSignal: controller.signal });

            const result = await actorExecutor.executeActorTool(params);

            expect(result).toBeNull();
            expect(spies.startInput).toBeUndefined();
        });
    });
});
