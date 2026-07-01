import { describe, expect, it } from 'vitest';

import { APIFY_CODE_RUNTIME_ACTOR, HelperTools } from '../../src/const.js';
import type { RunResponse } from '../../src/tools/actors/actor_run_response.js';
import { runCode } from '../../src/tools/actors/run_code.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

function mockRun(overrides: Record<string, unknown> = {}) {
    return {
        id: 'code-run-1',
        actId: 'code-runtime-actor-id',
        status: 'READY',
        startedAt: new Date('2026-06-25T10:00:00.000Z'),
        defaultDatasetId: 'ds-1',
        defaultKeyValueStoreId: 'kv-1',
        storageIds: { datasets: { default: 'ds-1' }, keyValueStores: { default: 'kv-1' } },
        ...overrides,
    };
}

function stubClient(opts: {
    run: unknown;
    onStart?: (input: unknown, options: unknown, id: string) => void;
    startThrows?: unknown;
    dataset?: unknown;
}): InternalToolArgs['apifyClient'] {
    const { run, onStart, startThrows, dataset } = opts;
    return {
        actor: (id: string) => ({
            start: async (input: unknown, options: unknown) => {
                onStart?.(input, options, id);
                if (startThrows) throw startThrows;
                return run;
            },
        }),
        run: (_id: string) => ({
            get: async () => run,
            waitForFinish: async () => run,
            abort: async () => undefined,
        }),
        dataset: (_id: string) => ({
            get: async () => dataset ?? null,
            listItems: async () => ({ items: [], total: 0 }),
        }),
        keyValueStore: (_id: string) => ({
            listKeys: async () => ({ items: [], count: 0, isTruncated: false, limit: 50 }),
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

type RunCodeResult = TextToolResult & {
    structuredContent?: RunResponse;
    isError?: boolean;
};

async function callRunCode(
    args: Record<string, unknown>,
    client: InternalToolArgs['apifyClient'],
): Promise<RunCodeResult> {
    return (await (runCode as HelperTool).call(stubToolCallContext(args, client))) as RunCodeResult;
}

describe('run-code', () => {
    it('waitSecs:0 starts apify/code-runtime with { code } and returns the start run response', async () => {
        let captured: { input: unknown; id: string } | undefined;
        const client = stubClient({
            run: mockRun(),
            onStart: (input, _options, id) => {
                captured = { input, id };
            },
        });

        const result = await callRunCode({ code: 'console.log(1)', waitSecs: 0 }, client);

        expect(captured?.id).toBe(APIFY_CODE_RUNTIME_ACTOR);
        expect(captured?.input).toEqual({ code: 'console.log(1)' });
        expect(result.structuredContent?.runId).toBe('code-run-1');
        expect(result.structuredContent?.status).toBe('READY');
        // Storage IDs are surfaced so the caller can later fetch { stdout, stderr }.
        expect(result.structuredContent?.storages.datasets?.default.id).toBe('ds-1');
    });

    it('forwards callOptions to the Actor start call', async () => {
        let capturedOptions: unknown;
        const client = stubClient({
            run: mockRun(),
            onStart: (_input, options) => {
                capturedOptions = options;
            },
        });

        await callRunCode({ code: 'x', waitSecs: 0, callOptions: { memory: 512, timeout: 120 } }, client);

        expect(capturedOptions).toEqual({ memory: 512, timeout: 120 });
    });

    it('waits and returns SUCCEEDED with a get-dataset-items nextStep', async () => {
        const run = mockRun({
            status: 'SUCCEEDED',
            finishedAt: new Date('2026-06-25T10:00:05.000Z'),
            stats: { runTimeSecs: 5 },
        });
        const dataset = { id: 'ds-1', itemCount: 1, fields: ['stdout', 'stderr'] };
        const client = stubClient({ run, dataset });

        const result = await callRunCode({ code: 'x', waitSecs: 30 }, client);

        expect(result.structuredContent?.status).toBe('SUCCEEDED');
        const text = result.content.map((c) => c.text).join('\n');
        expect(text).toContain(HelperTools.DATASET_GET_ITEMS);
        expect(text).toContain('ds-1');
    });

    it('returns an error response when starting the Actor fails', async () => {
        const client = stubClient({
            run: mockRun(),
            startThrows: Object.assign(new Error('boom'), { statusCode: 500 }),
        });

        const result = await callRunCode({ code: 'x', waitSecs: 0 }, client);

        expect(result.isError).toBe(true);
        const text = result.content.map((c) => c.text).join('\n');
        expect(text).toContain(APIFY_CODE_RUNTIME_ACTOR);
    });
});
