import { describe, expect, it } from 'vitest';

import { getNormalActorsAsTools } from '../../src/tools/core/actor-tools-factory.js';
import { buildEnrichedCallActorOutputSchema, callActorOutputSchema } from '../../src/tools/structured-output-schemas.js';
import type { ActorInfo, ActorStore, ActorTool } from '../../src/types.js';

// Helper type for testing schema structure
type EnrichedSchema = {
    type: string;
    properties: {
        items: {
            type: string;
            items: {
                type: string;
                properties?: Record<string, unknown>;
            };
            description?: string;
        };
        [key: string]: unknown;
    };
    required?: string[];
};

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

describe('Structured Output Schemas', () => {
    describe('buildEnrichedCallActorOutputSchema', () => {
        it('should enrich schema with simple properties', () => {
            const itemProperties = { url: { type: 'string' }, price: { type: 'number' } };
            const enrichedSchema = buildEnrichedCallActorOutputSchema(itemProperties) as unknown as EnrichedSchema;

            const { items } = enrichedSchema.properties;
            expect(items.type).toBe('array');
            const itemsSchema = items.items;
            expect(itemsSchema.type).toBe('object');
            expect(itemsSchema.properties).toEqual(itemProperties);
        });

        it('should NOT mutate original callActorOutputSchema', () => {
            const itemProperties = { url: { type: 'string' } };
            buildEnrichedCallActorOutputSchema(itemProperties);

            // Cast to EnrichedSchema to access the nested properties easily
            const originalSchema = callActorOutputSchema as unknown as EnrichedSchema;
            const originalItems = originalSchema.properties.items.items;

            expect(originalItems).toEqual({ type: 'object' });
            expect(originalItems.properties).toBeUndefined();
        });

        it('should handle complex nested properties', () => {
            const itemProperties = {
                user: { type: 'object', properties: { name: { type: 'string' } } },
                tags: { type: 'array', items: { type: 'string' } },
            };
            const enrichedSchema = buildEnrichedCallActorOutputSchema(itemProperties) as unknown as EnrichedSchema;

            const itemsSchema = enrichedSchema.properties.items.items;
            expect(itemsSchema.properties).toEqual(itemProperties);
        });

        it('should handle empty properties object', () => {
            const itemProperties = {};
            const enrichedSchema = buildEnrichedCallActorOutputSchema(itemProperties) as unknown as EnrichedSchema;

            const itemsSchema = enrichedSchema.properties.items.items;
            expect(itemsSchema.properties).toEqual({});
        });
    });

    describe('getNormalActorsAsTools with actorStore', () => {
        it('should return generic schema when no actorStore is provided', async () => {
            const actorInfo = createMockActorInfo('apify/test-actor');
            const tools = await getNormalActorsAsTools([actorInfo]);

            expect(tools).toHaveLength(1);
            const tool = tools[0] as ActorTool;
            expect(tool.outputSchema).toBeDefined();

            const schema = tool.outputSchema as unknown as EnrichedSchema;
            const itemsSchema = schema.properties.items.items;

            expect(itemsSchema).toEqual({ type: 'object' });
            expect(itemsSchema.properties).toBeUndefined();
        });

        it('should enrich schema when actorStore returns properties', async () => {
            const actorName = 'apify/test-actor';
            const actorInfo = createMockActorInfo(actorName);
            const properties = { url: { type: 'string' }, title: { type: 'string' } };
            const store = createMockActorStore({ [actorName]: properties });

            const tools = await getNormalActorsAsTools([actorInfo], { actorStore: store });

            expect(tools).toHaveLength(1);
            const tool = tools[0] as ActorTool;

            const schema = tool.outputSchema as unknown as EnrichedSchema;
            const itemsSchema = schema.properties.items.items;

            expect(itemsSchema.properties).toEqual(properties);
        });

        it('should return generic schema when actorStore returns null', async () => {
            const actorName = 'apify/test-actor';
            const actorInfo = createMockActorInfo(actorName);
            const store = createMockActorStore({ [actorName]: null });

            const tools = await getNormalActorsAsTools([actorInfo], { actorStore: store });

            expect(tools).toHaveLength(1);
            const tool = tools[0] as ActorTool;

            const schema = tool.outputSchema as unknown as EnrichedSchema;
            const itemsSchema = schema.properties.items.items;

            expect(itemsSchema).toEqual({ type: 'object' });
            expect(itemsSchema.properties).toBeUndefined();
        });

        it('should return generic schema when actorStore returns empty object', async () => {
            const actorName = 'apify/test-actor';
            const actorInfo = createMockActorInfo(actorName);
            const store = createMockActorStore({ [actorName]: {} });

            const tools = await getNormalActorsAsTools([actorInfo], { actorStore: store });

            expect(tools).toHaveLength(1);
            const tool = tools[0] as ActorTool;

            const schema = tool.outputSchema as unknown as EnrichedSchema;
            const itemsSchema = schema.properties.items.items;

            expect(itemsSchema).toEqual({ type: 'object' });
            expect(itemsSchema.properties).toBeUndefined();
        });

        it('should gracefully degrade when actorStore throws', async () => {
            const actorName = 'apify/test-actor';
            const actorInfo = createMockActorInfo(actorName);
            const store: ActorStore = {
                getActorOutputSchema: async () => {
                    throw new Error('Database connection failed');
                },
                getActorOutputSchemaAsTypeObject: async () => {
                    throw new Error('Database connection failed');
                },
            };

            const tools = await getNormalActorsAsTools([actorInfo], { actorStore: store });

            expect(tools).toHaveLength(1);
            const tool = tools[0] as ActorTool;

            const schema = tool.outputSchema as unknown as EnrichedSchema;
            const itemsSchema = schema.properties.items.items;

            expect(itemsSchema).toEqual({ type: 'object' });
            expect(itemsSchema.properties).toBeUndefined();
        });

        it('should handle multiple actors with mixed schemas', async () => {
            const actor1Name = 'apify/actor-with-schema';
            const actor2Name = 'apify/actor-no-schema';

            const actor1 = createMockActorInfo(actor1Name);
            const actor2 = createMockActorInfo(actor2Name);

            const properties = { foo: { type: 'string' } };
            const store = createMockActorStore({
                [actor1Name]: properties,
                [actor2Name]: null,
            });

            const tools = await getNormalActorsAsTools([actor1, actor2], { actorStore: store });

            expect(tools).toHaveLength(2);

            const tool1 = tools.find((t) => (t as ActorTool).actorFullName === actor1Name) as ActorTool;
            expect(tool1).toBeDefined();
            const schema1 = tool1.outputSchema as unknown as EnrichedSchema;
            expect(schema1.properties.items.items.properties).toEqual(properties);

            const tool2 = tools.find((t) => (t as ActorTool).actorFullName === actor2Name) as ActorTool;
            expect(tool2).toBeDefined();
            const schema2 = tool2.outputSchema as unknown as EnrichedSchema;
            expect(schema2.properties.items.items).toEqual({ type: 'object' });
            expect(schema2.properties.items.items.properties).toBeUndefined();
        });
    });
});
