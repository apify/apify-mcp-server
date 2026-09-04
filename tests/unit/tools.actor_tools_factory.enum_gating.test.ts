import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorInfo, SchemaProperties, ToolBase } from '../../src/types.js';
import { getToolPublicFieldOnly } from '../../src/utils/tools.js';

/** ActorInfo whose one input property has an enum too large to fit ACTOR_ENUM_MAX_LENGTH whole. */
function createActorInfoWithOversizedEnum(): ActorInfo {
    const enumValues = Array.from({ length: 250 }, (_, i) => `category-${i}-${'x'.repeat(10)}`);
    return {
        webServerMcpPath: null,
        definition: {
            id: 'test-id',
            actorFullName: 'test/actor-with-big-enum',
            readme: '',
            description: 'Test actor with an oversized enum',
            defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300, build: 'latest' },
            input: {
                type: 'object',
                title: 'Test Input',
                description: 'Test input schema',
                properties: {
                    category: {
                        type: 'string',
                        title: 'Category',
                        description: 'Category filter',
                        enum: enumValues,
                    },
                },
                schemaVersion: 1,
            },
        },
        actor: { id: 'test-actor-id', name: 'actor-with-big-enum', username: 'test' } as ActorInfo['actor'],
    };
}

/** ActorInfo whose enum comfortably fits — no property should be flagged as dropped. */
function createActorInfoWithSmallEnum(): ActorInfo {
    return {
        webServerMcpPath: null,
        definition: {
            id: 'test-id',
            actorFullName: 'test/actor-small-enum',
            readme: '',
            description: 'Test actor with a small enum',
            defaultRunOptions: { memoryMbytes: 1024, timeoutSecs: 300, build: 'latest' },
            input: {
                type: 'object',
                title: 'Test Input',
                description: 'Test input schema',
                properties: {
                    category: { type: 'string', title: 'Category', description: 'Category filter', enum: ['a', 'b'] },
                },
                schemaVersion: 1,
            },
        },
        actor: { id: 'test-actor-id', name: 'actor-small-enum', username: 'test' } as ActorInfo['actor'],
    };
}

describe('getNormalActorsAsTools — dropped-enum buildInputSchema gating', () => {
    it('keeps the base inputSchema generic (no tool name) regardless of session', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const tool = tools[0];
        const { properties } = tool.inputSchema as { properties: Record<string, SchemaProperties> };

        expect(properties.category.enum).toBeUndefined();
        expect(properties.category.description).toContain('More values accepted than shown');
        expect(properties.category.description).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });

    it('buildInputSchema renders the same generic text when fetch-actor-details is absent from the session', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const tool = tools[0];

        expect(tool.buildInputSchema).toBeDefined();
        const rendered = tool.buildInputSchema!({ hasTool: () => false }) as {
            properties: Record<string, SchemaProperties>;
        };
        expect(rendered.properties.category.description).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(rendered.properties.category.description).toContain('More values accepted than shown');
    });

    it('buildInputSchema names fetch-actor-details in the addendum when it is present in the session', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const tool = tools[0];

        const rendered = tool.buildInputSchema!({
            hasTool: (name) => name === HELPER_TOOLS.ACTOR_GET_DETAILS,
        }) as { properties: Record<string, SchemaProperties> };

        expect(rendered.properties.category.description).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(rendered.properties.category.description).toContain('more on this Actor');
    });

    it('leaves other properties (e.g. the injected waitSecs) untouched by the addendum', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const tool = tools[0];

        const rendered = tool.buildInputSchema!({
            hasTool: (name) => name === HELPER_TOOLS.ACTOR_GET_DETAILS,
        }) as { properties: Record<string, SchemaProperties> };

        expect(rendered.properties.waitSecs.description).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });

    it('AJV enforces type on the dropped-enum property but not membership in the original list', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const tool = tools[0];

        expect(tool.ajvValidate({ category: 'not-in-the-original-enum-list' })).toBe(true);
        // AJV coerces scalars (coerceTypes: 'array'), so use an object — never coercible to string.
        expect(tool.ajvValidate({ category: { nested: true } })).toBe(false);
    });

    it('does not attach buildInputSchema when no property had its enum dropped', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithSmallEnum()]);
        const tool = tools[0];

        expect(tool.buildInputSchema).toBeUndefined();
    });

    it('tools/list boundary (getToolPublicFieldOnly) renders the addendum only when fetch-actor-details shares the session', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const tool = tools[0] as ToolBase;

        const withoutDetails = getToolPublicFieldOnly(tool, { presentTools: new Set([tool.name]) });
        const withDetails = getToolPublicFieldOnly(tool, {
            presentTools: new Set([tool.name, HELPER_TOOLS.ACTOR_GET_DETAILS]),
        });

        const propsWithout = (withoutDetails.inputSchema as { properties: Record<string, SchemaProperties> })
            .properties;
        const propsWith = (withDetails.inputSchema as { properties: Record<string, SchemaProperties> }).properties;

        expect(propsWithout.category.description).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(propsWith.category.description).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });
});
