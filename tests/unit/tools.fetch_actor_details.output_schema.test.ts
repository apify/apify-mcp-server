import { describe, expect, it } from 'vitest';

import { MAX_DATASET_ITEMS_SCHEMA_BYTES } from '../../src/tools/actors/actor_definition.js';
import { buildFetchActorDetailsResult, fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { mockActor, mockActorBuildClient, mockDefaultBuild } from './helpers/actor_build_client.js';
import {
    expectSchemaConformingStructuredContent,
    mockApifyClient,
    stubToolCallContext,
    textOf,
} from './helpers/tool_context.js';

/** `fields` of a dataset schema as a creator writes it, shaped like `apify/instagram-profile-scraper`'s. */
const PROFILE_FIELDS = {
    type: 'object',
    properties: {
        username: { type: ['string', 'null'], examples: ['humansofny'], description: 'Instagram username' },
        latestPosts: { type: 'array', description: 'Most recent posts', items: { type: 'object' } },
    },
};

async function callFetchActorDetails(output: Record<string, unknown> | undefined, storages: unknown) {
    const { apifyClient } = mockActorBuildClient({
        actor: mockActor({ username: 'apify', name: 'instagram-profile-scraper' }),
        defaultBuild: mockDefaultBuild({ storages } as Parameters<typeof mockDefaultBuild>[0]),
    });
    const client = mockApifyClient({
        ...apifyClient,
        store: () => ({ list: async () => ({ total: 0, count: 0, offset: 0, limit: 10, desc: false, items: [] }) }),
    });
    const context = stubToolCallContext(
        { actor: 'apify/instagram-profile-scraper', ...(output && { output }) },
        client,
    );
    const result = await buildFetchActorDetailsResult(context);
    return {
        result,
        text: (result.content ?? []).map(textOf).join('\n'),
        structuredContent: result.structuredContent as Record<string, unknown>,
    };
}

describe('fetch-actor-details output schema', () => {
    it('returns the declared dataset schema in full, in the text and in structuredContent', async () => {
        const { result, text, structuredContent } = await callFetchActorDetails(
            { outputSchema: true },
            { dataset: { fields: PROFILE_FIELDS } },
        );

        expect(text).toContain('# Output schema');
        expect(text).toContain(JSON.stringify(PROFILE_FIELDS));
        expect(structuredContent.outputSchema).toEqual(PROFILE_FIELDS);
        expectSchemaConformingStructuredContent(result, fetchActorDetails.outputSchema as object);
    });

    it('says the Actor declares no schema and returns an empty one when it declares no dataset fields', async () => {
        const { text, structuredContent } = await callFetchActorDetails(
            { outputSchema: true },
            { dataset: { views: {} } },
        );

        expect(text).toContain('declares no schema');
        expect(structuredContent.outputSchema).toEqual({});
    });

    // A creator can declare a schema of any size, and it is returned in the text and in structuredContent.
    it('returns field names and types only when the declared schema is over the size limit', async () => {
        const longDescription = 'x'.repeat(MAX_DATASET_ITEMS_SCHEMA_BYTES);
        const fields = { type: 'object', properties: { username: { type: 'string', description: longDescription } } };

        const { result, text, structuredContent } = await callFetchActorDetails(
            { outputSchema: true },
            { dataset: { fields } },
        );

        expect(structuredContent.outputSchema).toEqual({
            type: 'object',
            properties: { username: { type: 'string' } },
        });
        expect(text).toContain(`over the ${MAX_DATASET_ITEMS_SCHEMA_BYTES}-byte limit`);
        expect(text).toContain('{"type":"object","properties":{"username":{"type":"string"}}}');
        expect(text).not.toContain(longDescription);
        expectSchemaConformingStructuredContent(result, fetchActorDetails.outputSchema as object);
    });

    it('returns no schema when the field names and types alone are over the size limit', async () => {
        const properties = Object.fromEntries(
            Array.from({ length: MAX_DATASET_ITEMS_SCHEMA_BYTES / 10 }, (_, index) => [
                `field${index}`,
                { type: 'string' },
            ]),
        );

        const { text, structuredContent } = await callFetchActorDetails(
            { outputSchema: true },
            { dataset: { fields: { type: 'object', properties } } },
        );

        expect(structuredContent.outputSchema).toEqual({});
        expect(text).toContain(`over the ${MAX_DATASET_ITEMS_SCHEMA_BYTES}-byte limit`);
        expect(text).not.toContain('field0');
    });

    it('leaves the output schema out unless it is requested', async () => {
        const { text, structuredContent } = await callFetchActorDetails(undefined, {
            dataset: { fields: PROFILE_FIELDS },
        });

        expect(text).not.toContain('# Output schema');
        expect(structuredContent.outputSchema).toBeUndefined();
    });
});
