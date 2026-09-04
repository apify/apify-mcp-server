import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { SKYFIRE_PAY_ID_KEY } from '../../src/payments/const.js';
import { SkyfirePaymentProvider } from '../../src/payments/skyfire.js';
import { getNormalActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorInfo, SchemaProperties } from '../../src/types.js';
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

// Regression: pay-id must survive whichever inputSchema render reaches the client, not just the static one.
describe('SkyfirePaymentProvider.decorateToolSchema — composes with buildInputSchema', () => {
    it('injects skyfire-pay-id into both the ungated and the fetch-actor-details-gated render', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const decorated = new SkyfirePaymentProvider().decorateToolSchema(tools[0]);

        expect(decorated.buildInputSchema).toBeDefined();

        const withoutDetails = decorated.buildInputSchema!({ hasTool: () => false }) as {
            properties: Record<string, SchemaProperties>;
        };
        const withDetails = decorated.buildInputSchema!({
            hasTool: (name) => name === HELPER_TOOLS.ACTOR_GET_DETAILS,
        }) as { properties: Record<string, SchemaProperties> };

        expect(withoutDetails.properties[SKYFIRE_PAY_ID_KEY]).toBeDefined();
        expect(withDetails.properties[SKYFIRE_PAY_ID_KEY]).toBeDefined();
        // The addendum still applies alongside the injected payment field.
        expect(withDetails.properties.category.description).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });

    it('survives the full tools/list boundary (getToolPublicFieldOnly) for both session sets', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const decorated = new SkyfirePaymentProvider().decorateToolSchema(tools[0]);

        const listedWithout = getToolPublicFieldOnly(decorated, { presentTools: new Set([decorated.name]) });
        const listedWith = getToolPublicFieldOnly(decorated, {
            presentTools: new Set([decorated.name, HELPER_TOOLS.ACTOR_GET_DETAILS]),
        });

        const propsWithout = (listedWithout.inputSchema as { properties: Record<string, unknown> }).properties;
        const propsWith = (listedWith.inputSchema as { properties: Record<string, unknown> }).properties;

        expect(propsWithout[SKYFIRE_PAY_ID_KEY]).toBeDefined();
        expect(propsWith[SKYFIRE_PAY_ID_KEY]).toBeDefined();
    });

    it('does not mutate the shared base inputSchema across repeated buildInputSchema calls', async () => {
        const tools = await getNormalActorsAsTools([createActorInfoWithOversizedEnum()]);
        const decorated = new SkyfirePaymentProvider().decorateToolSchema(tools[0]);

        decorated.buildInputSchema!({ hasTool: () => false });
        decorated.buildInputSchema!({ hasTool: () => false });

        const { properties } = decorated.inputSchema as { properties: Record<string, SchemaProperties> };
        // The dropped-enum note must appear exactly once, not accumulate across renders.
        const occurrences = properties.category.description.split('More values accepted than shown').length - 1;
        expect(occurrences).toBe(1);
    });
});
