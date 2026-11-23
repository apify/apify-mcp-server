import { describe, expect, it } from 'vitest';

import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import {
    actorDetailsOutputSchema,
    actorInfoSchema,
    buildEnrichedDirectActorOutputSchema,
    datasetItemsOutputSchema,
    actorRunOutputSchema,
} from '../../src/tools/structured_output_schemas.js';
import type { ActorInfo, ActorTool } from '../../src/types.js';
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

function createMockActorInfo(actorFullName: string, datasetItemProperties?: Record<string, unknown>): ActorInfo {
    return {
        webServerMcpPath: null,
        definition: {
            ...(datasetItemProperties && { datasetItemProperties }),
            id: 'test-id',
            actorFullName,
            readme: '',
            description: `Test actor ${actorFullName}`,
            defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300, build: 'latest' },
            hasWebServerSchema: false,
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

describe('Structured Output Schemas', () => {
    describe('buildEnrichedDirectActorOutputSchema', () => {
        it('injects itemsSchema with the supplied row properties', () => {
            const itemProperties = {
                url: { type: 'string' },
                user: { type: 'object', properties: { name: { type: 'string' } } },
                tags: { type: 'array', items: { type: 'string' } },
            };
            const enriched = buildEnrichedDirectActorOutputSchema(itemProperties);

            const itemsSchema = pickItemsSchema(enriched);
            expect(itemsSchema?.type).toBe('object');
            expect(itemsSchema?.properties).toEqual(itemProperties);
        });

        it('does not mutate the canonical actorRunOutputSchema', () => {
            buildEnrichedDirectActorOutputSchema({ url: { type: 'string' } });

            expect(pickItemsSchema(actorRunOutputSchema)).toBeUndefined();
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

    describe('actorRunOutputSchema', () => {
        // buildStorageEntries (actor_run_response.ts) omits the whole map unless `default` is
        // present, so every emitted `storages.datasets`/`storages.keyValueStores` has it (issue #1121).
        it('requires the default alias on both storage maps', () => {
            const { storages } = actorRunOutputSchema.properties;
            expect(storages.properties.datasets.required).toEqual(['default']);
            expect(storages.properties.keyValueStores.required).toEqual(['default']);
        });
    });

    describe('actorInfoSchema', () => {
        it('declares pictureUrl as an optional string', () => {
            expect(actorInfoSchema.properties.pictureUrl?.type).toBe('string');
            expect(actorInfoSchema.required).not.toContain('pictureUrl');
        });

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

    describe('getNormalActorsAsTools output schema', () => {
        it('uses the canonical RunResponse schema for an Actor that declares no dataset fields', async () => {
            const tools = await getNormalActorsAsTools([createMockActorInfo('apify/test-actor')]);

            expect(tools).toHaveLength(1);
            const tool = tools[0] as ActorTool;
            expect(tool.outputSchema).toBe(actorRunOutputSchema);
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

        it('advertises the dataset fields the Actor declares as itemsSchema', async () => {
            const itemProperties = { url: { type: 'string' }, title: { type: 'string' } };

            const tools = await getNormalActorsAsTools([createMockActorInfo('apify/test-actor', itemProperties)]);

            expect(pickItemsSchema((tools[0] as ActorTool).outputSchema)?.properties).toEqual(itemProperties);
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
    });
});
