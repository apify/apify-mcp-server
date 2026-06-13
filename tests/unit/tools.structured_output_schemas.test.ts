import { describe, expect, it } from 'vitest';

import { abortActorRun } from '../../src/tools/common/abort_actor_run.js';
import { getNormalActorsAsTools } from '../../src/tools/core/actor_tools_factory.js';
import {
    abortActorRunOutputSchema,
    actorDetailsOutputSchema,
    actorInfoSchema,
    buildEnrichedDirectActorOutputSchema,
    datasetItemsOutputSchema,
    getActorRunOutputSchema,
} from '../../src/tools/structured_output_schemas.js';
import type { ActorInfo, ActorStore, ActorTool } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';

/** Helper type for navigating to `storages.datasets.default.itemsSchema` in a tool's outputSchema. */
type EnrichedDatasetSchema = {
    properties: {
        storages: {
            properties: {
                datasets: {
                    properties: {
                        default: {
                            properties: {
                                itemsSchema?: { type: string; properties?: Record<string, unknown> };
                            };
                        };
                    };
                };
            };
        };
    };
};

function pickItemsSchema(schema: unknown): { type: string; properties?: Record<string, unknown> } | undefined {
    return (schema as EnrichedDatasetSchema).properties.storages.properties.datasets.properties.default.properties
        .itemsSchema;
}

function createMockActorInfo(actorFullName: string): ActorInfo {
    return {
        webServerMcpPath: null,
        definition: {
            id: 'test-id',
            actorFullName,
            readme: '',
            description: `Test actor ${actorFullName}`,
            defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300, build: 'latest' },
            input: {
                type: 'object',
                title: 'Test Input',
                description: 'Test input schema',
                properties: {
                    url: {
                        type: 'string',
                        title: 'URL',
                        description: 'The URL to process',
                    },
                },
                schemaVersion: 1,
            },
        },
        actor: {
            id: 'test-actor-id',
            name: actorFullName.split('/')[1] || actorFullName,
            username: actorFullName.split('/')[0] || 'test',
        } as ActorInfo['actor'],
    };
}

function createMockActorStore(schemas: Record<string, Record<string, unknown> | null>): ActorStore {
    return {
        getActorOutputSchema: async (actorFullName: string) => {
            if (schemas[actorFullName] === undefined) {
                return null;
            }
            return schemas[actorFullName];
        },
        getActorOutputSchemaAsTypeObject: async (actorFullName: string) => {
            if (schemas[actorFullName] === undefined) {
                return null;
            }
            return schemas[actorFullName];
        },
    };
}

describe('abortActorRunOutputSchema', () => {
    it('is a valid JSON Schema object', () => {
        expect(abortActorRunOutputSchema.type).toBe('object');
        expect(abortActorRunOutputSchema.properties).toBeDefined();
    });

    it('requires runId and status', () => {
        expect(abortActorRunOutputSchema.required).toEqual(expect.arrayContaining(['runId', 'status']));
    });

    it('includes runId, status, startedAt, and finishedAt properties', () => {
        const props = abortActorRunOutputSchema.properties;
        expect(props.runId.type).toBe('string');
        expect(props.status.type).toBe('string');
        expect(props.startedAt.type).toBe('string');
        expect(props.finishedAt.type).toBe('string');
    });

    it('abortActorRun tool wires the outputSchema', () => {
        expect(abortActorRun.outputSchema).toBe(abortActorRunOutputSchema);
    });

    it('validates a minimal abort response', () => {
        const validate = compileSchema(abortActorRunOutputSchema);
        expect(validate({ runId: 'y2h7sK3Wc', status: 'ABORTED' })).toBe(true);
    });

    it('validates a full abort response', () => {
        const validate = compileSchema(abortActorRunOutputSchema);
        expect(
            validate({
                runId: 'y2h7sK3Wc',
                status: 'ABORTED',
                startedAt: '2024-01-01T00:00:00.000Z',
                finishedAt: '2024-01-01T00:01:00.000Z',
            }),
        ).toBe(true);
    });
});

describe('Structured Output Schemas', () => {
    describe('buildEnrichedDirectActorOutputSchema', () => {
        it('injects itemsSchema with the supplied row properties', () => {
            const itemProperties = { url: { type: 'string' }, price: { type: 'number' } };
            const enriched = buildEnrichedDirectActorOutputSchema(itemProperties);

            const itemsSchema = pickItemsSchema(enriched);
            expect(itemsSchema?.type).toBe('object');
            expect(itemsSchema?.properties).toEqual(itemProperties);
        });

        it('does not mutate the canonical getActorRunOutputSchema', () => {
            buildEnrichedDirectActorOutputSchema({ url: { type: 'string' } });

            expect(pickItemsSchema(getActorRunOutputSchema)).toBeUndefined();
        });

        it('handles nested item properties', () => {
            const itemProperties = {
                user: { type: 'object', properties: { name: { type: 'string' } } },
                tags: { type: 'array', items: { type: 'string' } },
            };
            const enriched = buildEnrichedDirectActorOutputSchema(itemProperties);

            expect(pickItemsSchema(enriched)?.properties).toEqual(itemProperties);
        });
    });

    describe('datasetItemsOutputSchema', () => {
        // Both consumer tools always emit offset/limit/totalItemCount and now summary/nextStep,
        // so `required` must list them (issue #884).
        it('requires the always-emitted pagination, count, and narrative fields', () => {
            expect(datasetItemsOutputSchema.required).toEqual(
                expect.arrayContaining([
                    'datasetId',
                    'items',
                    'itemCount',
                    'totalItemCount',
                    'offset',
                    'limit',
                    'summary',
                    'nextStep',
                ]),
            );
        });
    });

    describe('actorInfoSchema', () => {
        // openai/fetch-actor-details intentionally strips `pricing` from `actorInfo` so the
        // widget's tier-aware pricing under `actorDetails.actorInfo.currentPricingInfo` is
        // the single source of truth. The shared actor-info schema must accept that shape.
        it('validates an actorInfo object without pricing (openai fetch-actor-details shape)', () => {
            const validate = compileSchema(actorInfoSchema);
            const actorInfoWithoutPricing = {
                title: 'Web Scraper',
                url: 'https://apify.com/apify/web-scraper',
                id: 'actor-id',
                fullName: 'apify/web-scraper',
                developer: { username: 'apify', isOfficialApify: true, url: 'https://apify.com/apify' },
                description: 'Scrapes stuff.',
                categories: ['SCRAPING'],
                isDeprecated: false,
            };
            expect(validate(actorInfoWithoutPricing)).toBe(true);
        });

        it('accepts the openai fetch-actor-details structured content shape', () => {
            const validate = compileSchema(actorDetailsOutputSchema);
            const structuredContent = {
                actorInfo: {
                    url: 'https://apify.com/apify/web-scraper',
                    id: 'actor-id',
                    fullName: 'apify/web-scraper',
                    developer: { username: 'apify', isOfficialApify: true, url: 'https://apify.com/apify' },
                    description: 'Scrapes stuff.',
                    categories: ['SCRAPING'],
                    isDeprecated: false,
                },
                inputSchema: { type: 'object', properties: {} },
            };
            expect(validate(structuredContent)).toBe(true);
        });
    });

    describe('getNormalActorsAsTools enrichment', () => {
        it('uses the canonical RunResponse schema when no actorStore is provided', async () => {
            const tools = await getNormalActorsAsTools([createMockActorInfo('apify/test-actor')]);

            expect(tools).toHaveLength(1);
            const tool = tools[0] as ActorTool;
            expect(tool.outputSchema).toBe(getActorRunOutputSchema);
        });

        it('injects waitSecs as an optional integer (0–45) into the input schema', async () => {
            const tools = await getNormalActorsAsTools([createMockActorInfo('apify/test-actor')]);

            const tool = tools[0] as ActorTool;
            const inputProps = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
            const waitSecsField = inputProps.waitSecs as
                | { type?: string; minimum?: number; maximum?: number }
                | undefined;
            expect(waitSecsField?.type).toBe('integer');
            expect(waitSecsField?.minimum).toBe(0);
            expect(waitSecsField?.maximum).toBe(45);
            // waitSecs must stay opt-in — never in `required`.
            const required = (tool.inputSchema as { required?: string[] }).required ?? [];
            expect(required).not.toContain('waitSecs');
        });

        it('enriches outputSchema with itemsSchema when actorStore returns properties', async () => {
            const actorName = 'apify/test-actor';
            const itemProperties = { url: { type: 'string' }, title: { type: 'string' } };
            const store = createMockActorStore({ [actorName]: itemProperties });

            const tools = await getNormalActorsAsTools([createMockActorInfo(actorName)], { actorStore: store });
            const tool = tools[0] as ActorTool;

            expect(pickItemsSchema(tool.outputSchema)?.properties).toEqual(itemProperties);
        });

        it('falls back to the canonical schema when actorStore returns null', async () => {
            const actorName = 'apify/test-actor';
            const store = createMockActorStore({ [actorName]: null });

            const tools = await getNormalActorsAsTools([createMockActorInfo(actorName)], { actorStore: store });
            const tool = tools[0] as ActorTool;

            expect(tool.outputSchema).toBe(getActorRunOutputSchema);
        });

        it('falls back to the canonical schema when actorStore returns an empty object', async () => {
            const actorName = 'apify/test-actor';
            const store = createMockActorStore({ [actorName]: {} });

            const tools = await getNormalActorsAsTools([createMockActorInfo(actorName)], { actorStore: store });
            const tool = tools[0] as ActorTool;

            expect(tool.outputSchema).toBe(getActorRunOutputSchema);
        });

        it('falls back to the canonical schema when actorStore throws', async () => {
            const store: ActorStore = {
                getActorOutputSchema: async () => {
                    throw new Error('Database connection failed');
                },
                getActorOutputSchemaAsTypeObject: async () => {
                    throw new Error('Database connection failed');
                },
            };

            const tools = await getNormalActorsAsTools([createMockActorInfo('apify/test-actor')], {
                actorStore: store,
            });
            const tool = tools[0] as ActorTool;

            expect(tool.outputSchema).toBe(getActorRunOutputSchema);
        });

        it('mixes enriched and canonical schemas across multiple actors', async () => {
            const actor1Name = 'apify/actor-with-schema';
            const actor2Name = 'apify/actor-no-schema';
            const itemProperties = { foo: { type: 'string' } };
            const store = createMockActorStore({
                [actor1Name]: itemProperties,
                [actor2Name]: null,
            });

            const tools = await getNormalActorsAsTools(
                [createMockActorInfo(actor1Name), createMockActorInfo(actor2Name)],
                { actorStore: store },
            );

            const tool1 = tools.find((t) => (t as ActorTool).actorFullName === actor1Name) as ActorTool;
            const tool2 = tools.find((t) => (t as ActorTool).actorFullName === actor2Name) as ActorTool;

            expect(pickItemsSchema(tool1.outputSchema)?.properties).toEqual(itemProperties);
            expect(tool2.outputSchema).toBe(getActorRunOutputSchema);
        });

        it('emits no widget meta on actor tools', async () => {
            const tools = await getNormalActorsAsTools([createMockActorInfo('apify/test-actor')]);

            expect(tools).toHaveLength(1);
            const meta = tools[0]._meta ?? {};
            for (const key of Object.keys(meta)) {
                expect(key).not.toMatch(/^openai\//);
                expect(key).not.toBe('ui');
                expect(key).not.toBe('ui/resourceUri');
            }
        });

        it('emits no widget meta on actor tools', async () => {
            const actorInfo = createMockActorInfo('apify/test-actor');
            const tools = await getNormalActorsAsTools([actorInfo]);

            expect(tools).toHaveLength(1);
            const meta = tools[0]._meta ?? {};
            for (const key of Object.keys(meta)) {
                expect(key).not.toMatch(/^openai\//);
                expect(key).not.toBe('ui');
                expect(key).not.toBe('ui/resourceUri');
            }
        });
    });
});
