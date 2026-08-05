import { expect } from 'vitest';

import { HELPER_TOOLS } from '../../const.js';
import { actorNameToToolName } from '../../tools/actor_tool_naming.js';
import { actorRunOutputSchema } from '../../tools/structured_output_schemas.js';
import {
    ACTOR_NORMAL_MODE,
    expectNormalModeTestStructuredContent,
    expectUsageCostMeta,
    validateStructuredOutput,
    validateStructuredOutputForTool,
    withClient,
} from '../helpers.js';
import type { Case } from '../types.js';

/**
 * Dataset and key-value-store read tools: `get-dataset-items`, `resources/read`, etc. — the
 * self-contained subset (each case opens its own client/Actor run). A shared-`beforeAll`-seeded
 * group of 13 more storage cases lives in `tests/integration/cases/storage_grouped.cases.ts`
 * (this repo's own suite only) — it can't be flattened into standalone Cases without paying for
 * 13x redundant Actor runs, so it isn't part of the critical-sharing model (yet).
 */
export const storageCases: Case[] = [
    {
        name: 'rejects get-key-value-store-record when required keyValueStoreId is missing',
        critical: false,
        run: withClient({ tools: ['storage'] }, async (client) => {
            await expect(
                client.callTool({ name: HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET, arguments: { recordKey: 'INPUT' } }),
            ).rejects.toThrow(/must have required property 'keyValueStoreId'/);
        }),
    },
    {
        name: 'calls normal-mode-test-actor, verifies canonical shape and dataset fields, and fetches via get-dataset-items',
        critical: false,
        run: withClient({ tools: ['actors', 'storage'] }, async (client) => {
            const callResult = await client.callTool({
                name: 'call-actor',
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 } },
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
                arguments: { datasetId: datasetId!, fields: 'firstNumber,sum' },
            });

            const items = (outputResult as { structuredContent?: { items?: Record<string, unknown>[] } })
                .structuredContent?.items;
            expect(Array.isArray(items)).toBe(true);
            expect(items!.length).toBeGreaterThan(0);
            expect(items![0]).toHaveProperty('firstNumber', 1);
            expect(items![0]).toHaveProperty('sum', 3);
        }),
    },
    {
        name: 'calls apify/normal-mode-test-actor tool directly and retrieves sum via get-dataset-items',
        critical: false,
        run: withClient({ tools: ['storage'], actors: [ACTOR_NORMAL_MODE] }, async (client) => {
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
        }),
    },
    {
        name: 'calls apify/normal-mode-test-actor tool directly and retrieves full dataset via get-dataset-items',
        critical: false,
        run: withClient({ tools: ['storage'], actors: [ACTOR_NORMAL_MODE] }, async (client) => {
            const selectedToolName = actorNameToToolName(ACTOR_NORMAL_MODE);
            const input = { firstNumber: 5, secondNumber: 7 };

            const result = await client.callTool({ name: selectedToolName, arguments: input });

            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2);

            // Direct actor tools return the canonical RunResponse shape — same as call-actor.
            validateStructuredOutput(result, actorRunOutputSchema, selectedToolName);
            expectNormalModeTestStructuredContent(result);
            expectUsageCostMeta(result);

            const datasetId = (
                result as { structuredContent?: { storages?: { datasets?: { default?: { id?: string } } } } }
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
        }),
    },
    {
        name: 'should return structured output for get-dataset-items matching outputSchema',
        critical: false,
        run: withClient({ tools: ['actors', 'storage'] }, async (client) => {
            // First, run an actor to get a datasetId
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 3, secondNumber: 4 } },
            });

            const resultWithStructured = callResult as {
                structuredContent?: { storages?: { datasets?: { default?: { id?: string } } } };
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
        }),
    },
];
