import { beforeAll, describe, expect } from 'vitest';

import { HELPER_TOOLS } from '../../../src/const.js';
import { actorNameToToolName } from '../../../src/tools/actor_tool_naming.js';
import { actorRunOutputSchema } from '../../../src/tools/structured_output_schemas.js';
import { ACTOR_NORMAL_MODE } from '../../const.js';
import {
    type CasesCtx,
    expectNormalModeTestStructuredContent,
    expectUsageCostMeta,
    validateStructuredOutput,
    validateStructuredOutputForTool,
} from './shared.js';

/**
 * Dataset and key-value-store read tools: `get-dataset`, `get-dataset-items`,
 * `get-key-value-store-record`, and `resources/read` for both storage kinds.
 */
export function registerStorageCases(ctx: CasesCtx): void {
    const { itc, createClientFn } = ctx;

    describe('normal-mode-test-actor run reads via storage tools', () => {
        let datasetId: string;
        let defaultKvId: string;
        let runId: string;

        beforeAll(async () => {
            const setupClient = await createClientFn({ tools: ['actors', 'storage'] });
            try {
                const callResult = await setupClient.callTool({
                    name: HELPER_TOOLS.ACTOR_CALL,
                    arguments: {
                        actor: ACTOR_NORMAL_MODE,
                        input: { firstNumber: 1, secondNumber: 2 },
                        waitSecs: 45,
                    },
                });
                const callStructured = callResult as {
                    structuredContent?: {
                        runId?: string;
                        storages?: {
                            datasets?: { default?: { id?: string } };
                            keyValueStores?: { default?: { id?: string } };
                        };
                    };
                };
                const sc = callStructured.structuredContent;
                expect(sc?.runId).toBeDefined();
                expect(sc?.storages?.datasets?.default?.id).toBeDefined();
                expect(sc?.storages?.keyValueStores?.default?.id).toBeDefined();
                datasetId = sc!.storages!.datasets!.default!.id!;
                defaultKvId = sc!.storages!.keyValueStores!.default!.id!;
                runId = sc!.runId!;
            } finally {
                await setupClient.close();
            }
        }, 60_000);

        itc(
            'applies the default `limit` of 20 when omitted on get-dataset-items',
            { tools: ['storage'] },
            async (client) => {
                const result = await client.callTool({
                    name: HELPER_TOOLS.DATASET_GET_ITEMS,
                    arguments: { datasetId },
                });
                expect(result.isError).not.toBe(true);
                const structured = (result as { structuredContent?: { items?: unknown[]; limit?: number } })
                    .structuredContent;
                expect(structured?.limit).toBe(20);
                expect((structured?.items ?? []).length).toBeLessThanOrEqual(20);
            },
        );

        itc(
            "reads INPUT from the run's default KV store via get-actor-run + get-key-value-store-record",
            { tools: ['runs', 'storage'] },
            async (client) => {
                const runResult = await client.callTool({
                    name: HELPER_TOOLS.ACTOR_RUNS_GET,
                    arguments: { runId },
                });
                expect(runResult.isError).not.toBe(true);
                const runText = (runResult.content as { text: string }[])[0].text;
                // content[0] is JSON.stringify(structuredContent), not markdown-embedded JSON.
                const runData = JSON.parse(runText) as {
                    storages?: { keyValueStores?: { default?: { id?: string } } };
                };
                const kvId = runData.storages?.keyValueStores?.default?.id;
                expect(kvId).toBeDefined();

                const kvResult = await client.callTool({
                    name: HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
                    arguments: { keyValueStoreId: kvId!, recordKey: 'INPUT' },
                });
                expect(kvResult.isError).not.toBe(true);
                expect((kvResult.content as { text: string }[])[0].text).toContain('firstNumber');
                // Reading a record is terminal: summary present, no nextStep.
                const kvSc = (kvResult as { structuredContent?: { summary?: string; nextStep?: string } })
                    .structuredContent;
                expect(kvSc?.summary).toContain("Read 'INPUT'");
                expect(kvSc).not.toHaveProperty('nextStep');
            },
        );

        itc('returns dataset metadata via get-dataset', { tools: ['storage'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.DATASET_GET,
                arguments: { datasetId },
            });
            expect(result.isError).not.toBe(true);
            const { text } = (result.content as { text: string }[])[0];
            expect(text).toContain(datasetId);
            expect(text).toContain('firstNumber');
            expect(text).toContain('sum');
            const sc = (result as { structuredContent?: { summary?: string; nextStep?: string } }).structuredContent;
            expect(sc?.summary).toContain('items');
            expect(sc?.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
        });

        itc('infers schema from dataset items via get-dataset-schema', { tools: ['storage'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.DATASET_SCHEMA_GET,
                arguments: { datasetId },
            });
            expect(result.isError).not.toBe(true);
            const { text } = (result.content as { text: string }[])[0];
            expect(text).toContain('properties');
            // `math` is a nested object in the default-dataset item; its presence in the schema
            // proves the inference walks nested shapes, not just top-level fields.
            expect(text).toContain('math');
            const sc = (result as { structuredContent?: { summary?: string; nextStep?: string } }).structuredContent;
            expect(sc?.summary).toContain('Schema inferred');
            expect(sc?.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
        });

        itc('returns key-value store metadata via get-key-value-store', { tools: ['storage'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.KEY_VALUE_STORE_GET,
                arguments: { keyValueStoreId: defaultKvId },
            });
            expect(result.isError).not.toBe(true);
            const { text } = (result.content as { text: string }[])[0];
            expect(text).toContain(defaultKvId);
            const sc = (result as { structuredContent?: { nextStep?: string } }).structuredContent;
            expect(sc?.nextStep).toContain(HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET);
        });

        itc('lists keys in the run KV store via get-key-value-store-keys', { tools: ['storage'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET,
                arguments: { keyValueStoreId: defaultKvId, limit: 10 },
            });
            expect(result.isError).not.toBe(true);
            const { text } = (result.content as { text: string }[])[0];
            expect(text).toContain('INPUT');
            expect(text).toContain('RESULT');
            expect(text).toContain('STATS');
            expect(text).toContain('LOG');
            expect(text).toContain('COVER');
            const sc = (result as { structuredContent?: { summary?: string; nextStep?: string } }).structuredContent;
            expect(sc?.summary).toContain('keys');
            expect(sc?.nextStep).toContain(HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET);
        });

        // Doesn't assert defaultKvId is in the page: on a shared account, concurrent runs can
        // push it past the top-10 recency window between creation and the list call. Existence
        // and readability of the store are already proven by the get-key-value-store test below.
        itc('lists unnamed key-value stores via get-key-value-store-list', { tools: ['storage'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
                arguments: { desc: true, unnamed: true, limit: 10 },
            });
            expect(result.isError).not.toBe(true);
            const sc = (result as { structuredContent?: { total?: number; unnamed?: boolean; items?: unknown[] } })
                .structuredContent;
            expect(sc?.unnamed).toBe(true);
            expect(sc?.total).toBeGreaterThan(0);
            expect(Array.isArray(sc?.items)).toBe(true);
            expect(sc!.items!.length).toBeGreaterThan(0);
            expect(sc!.items!.length).toBeLessThanOrEqual(10);
        });

        // Apify-contract canary for #880: get-dataset-items only sends the top-level prefix
        // (e.g. `flatten=math` for fields `math.factorial.first`). If Apify's `flatten` ever
        // stops recursing through nested levels, this 3-deep field will come back undefined and
        // signal that we need to emit every prefix.
        itc('flattens 3-level nested fields via get-dataset-items', { tools: ['storage'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.DATASET_GET_ITEMS,
                arguments: { datasetId, fields: 'math.factorial.first' },
            });
            expect(result.isError).not.toBe(true);
            const items = (result as { structuredContent?: { items?: Record<string, unknown>[] } }).structuredContent
                ?.items;
            expect(Array.isArray(items)).toBe(true);
            // >=1 (not ==1): the signal is whether the nested field surfaces, not the count.
            expect(items!.length).toBeGreaterThanOrEqual(1);
            // factorial.first = 1! = 1; if flatten recurses, the value appears under the dot-notated key.
            expect(items![0]['math.factorial.first']).toBe(1);
        });

        itc('reads dataset items via resources/read', { tools: ['storage'] }, async (client) => {
            const result = await client.readResource({
                uri: `https://api.apify.com/v2/datasets/${datasetId}/items?limit=5`,
            });
            const contents = result.contents[0] as { mimeType?: string; text?: string };
            // The proxy passes through the API's declared Content-Type, which carries a charset
            // (e.g. `application/json; charset=utf-8`), so match the base type rather than the exact string.
            expect(contents.mimeType).toContain('application/json');
            // The generic proxy returns the raw API body — a bare JSON array of items.
            const items = JSON.parse(contents.text as string) as unknown[];
            expect(Array.isArray(items)).toBe(true);
        });

        itc('reads a KV record via resources/read', { tools: ['storage'] }, async (client) => {
            const result = await client.readResource({
                uri: `https://api.apify.com/v2/key-value-stores/${defaultKvId}/records/INPUT`,
            });
            const contents = result.contents[0] as { text?: string };
            expect(contents.text).toContain('firstNumber');
        });

        itc(
            'rejects resources/read of a nonexistent dataset with a JSON-RPC error',
            { tools: ['storage'] },
            async (client) => {
                await expect(
                    client.readResource({
                        uri: 'https://api.apify.com/v2/datasets/this-dataset-does-not-exist-xyz/items',
                    }),
                ).rejects.toThrow(/Failed to read/i);
            },
        );

        itc(
            'rejects resources/read of a non-Apify URL with a JSON-RPC error',
            { tools: ['storage'] },
            async (client) => {
                await expect(client.readResource({ uri: 'https://example.com/steal-my-token' })).rejects.toThrow(
                    /Failed to read/i,
                );
            },
        );

        itc('advertises API URL templates via resources/templates/list', { tools: ['storage'] }, async (client) => {
            const { resourceTemplates } = await client.listResourceTemplates();
            const datasetItems = resourceTemplates.find((t) => t.name === 'dataset-items');
            expect(datasetItems?.uriTemplate).toContain('/v2/datasets/{datasetId}/items{?limit,offset,');
        });
    });

    itc(
        'rejects get-key-value-store-record when required keyValueStoreId is missing',
        { tools: ['storage'] },
        async (client) => {
            await expect(
                client.callTool({
                    name: HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
                    arguments: { recordKey: 'INPUT' },
                }),
            ).rejects.toThrow(/must have required property 'keyValueStoreId'/);
        },
    );

    itc(
        'calls normal-mode-test-actor, verifies canonical shape and dataset fields, and fetches via get-dataset-items',
        { tools: ['actors', 'storage'] },
        async (client) => {
            const callResult = await client.callTool({
                name: 'call-actor',
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
                    input: { firstNumber: 1, secondNumber: 2 },
                },
            });

            // content[0] mirrors structuredContent as JSON; content[1] is "${summary}\n${nextStep}".
            const content = callResult.content as { text: string; type: string }[];
            expect(content.length).toBe(2);

            const sc = (
                callResult as {
                    structuredContent?: {
                        status?: string;
                        storages?: { datasets?: { default?: { id?: string; fields?: string[] } } };
                        nextStep?: string;
                    };
                }
            ).structuredContent;
            expect(sc?.status).toBe('SUCCEEDED');
            const datasetId = sc?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();

            // Dataset field paths surface in `storages.datasets.default.fields`.
            const fields = sc?.storages?.datasets?.default?.fields ?? [];
            expect(fields).toEqual(expect.arrayContaining(['firstNumber', 'secondNumber', 'sum']));

            // #911/#894: the actor emits `math.fibonacci: [..]`, which Apify reports index-expanded
            // (`math/fibonacci/0`, `/1`, `/2`). The server must collapse those to a single
            // `math.fibonacci` on the wire. `math.fibonacci` present proves collapse fired (not a
            // flat-only no-op); no entry keeps an array index; no duplicates survive collapse.
            expect(fields).toEqual(expect.arrayContaining(['math.fibonacci']));
            expect(fields.some((f) => /\.\d+(\.|$)/.test(f))).toBe(false);
            expect(new Set(fields).size).toBe(fields.length);

            const outputResult = await client.callTool({
                name: HELPER_TOOLS.DATASET_GET_ITEMS,
                arguments: {
                    datasetId: datasetId!,
                    fields: 'firstNumber,sum',
                },
            });

            const items = (outputResult as { structuredContent?: { items?: Record<string, unknown>[] } })
                .structuredContent?.items;
            expect(Array.isArray(items)).toBe(true);
            expect(items!.length).toBeGreaterThan(0);
            expect(items![0]).toHaveProperty('firstNumber', 1);
            expect(items![0]).toHaveProperty('sum', 3);
        },
    );

    itc(
        'calls apify/normal-mode-test-actor tool directly and retrieves sum via get-dataset-items',
        { tools: ['storage'], actors: [ACTOR_NORMAL_MODE] },
        async (client) => {
            const result = await client.callTool({
                name: actorNameToToolName(ACTOR_NORMAL_MODE),
                // Max wait (45s) so the test does not flake on a slow run.
                arguments: { firstNumber: 4, secondNumber: 6, waitSecs: 45 },
            });

            // content[0] mirrors structuredContent as JSON; content[1] is "${summary}\n${nextStep}".
            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2);

            // Direct actor tools return the canonical RunResponse shape — same as call-actor.
            const normalModeToolName = actorNameToToolName(ACTOR_NORMAL_MODE);
            validateStructuredOutput(result, actorRunOutputSchema, normalModeToolName);
            const sc = (
                result as {
                    structuredContent?: {
                        status?: string;
                        storages?: { datasets?: { default?: { id?: string; fields?: string[] } } };
                        nextStep?: string;
                    };
                }
            ).structuredContent;
            expect(sc?.status).toBe('SUCCEEDED');
            const datasetId = sc?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();

            // content[1] is the LLM-readable summary+nextStep; it must reference the datasetId
            // and the follow-up tool name so the LLM can act on the result.
            expect(content[1].text).toContain(datasetId);
            expect(content[1].text).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);

            // Dataset field paths surface in `storages.datasets.default.fields`.
            const fields = sc?.storages?.datasets?.default?.fields ?? [];
            expect(fields).toEqual(expect.arrayContaining(['firstNumber', 'secondNumber', 'sum']));

            const outputResult = await client.callTool({
                name: HELPER_TOOLS.DATASET_GET_ITEMS,
                arguments: { datasetId: datasetId!, fields: 'sum' },
            });

            const items = (outputResult as { structuredContent?: { items?: Record<string, unknown>[] } })
                .structuredContent?.items;
            expect(Array.isArray(items)).toBe(true);
            expect(items!.length).toBeGreaterThan(0);
            expect(items![0]).toHaveProperty('sum', 10);

            validateStructuredOutputForTool(outputResult, HELPER_TOOLS.DATASET_GET_ITEMS, 'default');
        },
    );

    itc(
        'calls apify/normal-mode-test-actor tool directly and retrieves full dataset via get-dataset-items',
        { tools: ['storage'], actors: [ACTOR_NORMAL_MODE] },
        async (client) => {
            const selectedToolName = actorNameToToolName(ACTOR_NORMAL_MODE);
            const input = { firstNumber: 5, secondNumber: 7 };

            const result = await client.callTool({
                name: selectedToolName,
                arguments: input,
            });

            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2);

            // Direct actor tools return the canonical RunResponse shape — same as call-actor.
            validateStructuredOutput(result, actorRunOutputSchema, selectedToolName);
            expectNormalModeTestStructuredContent(result);
            expectUsageCostMeta(result);

            const datasetId = (
                result as {
                    structuredContent?: {
                        storages?: { datasets?: { default?: { id?: string } } };
                    };
                }
            ).structuredContent?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();

            const outputResult = await client.callTool({
                name: HELPER_TOOLS.DATASET_GET_ITEMS,
                arguments: { datasetId: datasetId! },
            });

            const items = (outputResult as { structuredContent?: { items?: Record<string, unknown>[] } })
                .structuredContent?.items;
            expect(Array.isArray(items)).toBe(true);
            expect(items!.length).toBe(1);
            expect(items![0]).toHaveProperty('firstNumber', input.firstNumber);
            expect(items![0]).toHaveProperty('secondNumber', input.secondNumber);
            expect(items![0]).toHaveProperty('sum', input.firstNumber + input.secondNumber);

            validateStructuredOutputForTool(outputResult, HELPER_TOOLS.DATASET_GET_ITEMS, 'default');
        },
    );

    itc(
        'should return structured output for get-dataset-items matching outputSchema',
        { tools: ['actors', 'storage'] },
        async (client) => {
            // First, run an actor to get a datasetId
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
                    input: { firstNumber: 3, secondNumber: 4 },
                },
            });

            const resultWithStructured = callResult as {
                structuredContent?: {
                    storages?: { datasets?: { default?: { id?: string } } };
                };
            };
            const datasetId = resultWithStructured.structuredContent?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();

            // Now test get-dataset-items
            const datasetResult = await client.callTool({
                name: HELPER_TOOLS.DATASET_GET_ITEMS,
                arguments: { datasetId },
            });

            expect(datasetResult.content).toBeDefined();
            // Validate structured output for get-dataset-items
            validateStructuredOutputForTool(datasetResult, HELPER_TOOLS.DATASET_GET_ITEMS, 'default');

            // Validate structured content has items with actual results
            const datasetWithStructured = datasetResult as {
                structuredContent?: {
                    datasetId?: string;
                    items?: { firstNumber?: number; secondNumber?: number; sum?: number }[];
                    itemCount?: number;
                    totalItemCount?: number;
                    offset?: number;
                    limit?: number;
                };
            };
            expect(datasetWithStructured.structuredContent).toBeDefined();
            expect(datasetWithStructured.structuredContent?.items?.length).toBeGreaterThan(0);
            expect(datasetWithStructured.structuredContent?.items?.[0]).toHaveProperty('sum', 7);
            expect(datasetWithStructured.structuredContent?.items?.[0]).toHaveProperty('firstNumber', 3);
            expect(datasetWithStructured.structuredContent?.items?.[0]).toHaveProperty('secondNumber', 4);
        },
    );
}
