import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { getActorDefinition } from '../../src/tools/actors/actor_definition.js';
import { mockApifyClient } from './helpers/tool_context.js';

function apifyApiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: message, message } }, status } as AxiosResponse, 1);
}

/** `actor().get()` finds the Actor; `defaultBuild()` throws `error`, the call that reaches the catch block. */
function stubDefaultBuildFailure(error: unknown): ApifyClient {
    return mockApifyClient({
        actor: () => ({
            get: async () => ({ id: 'actor-id', username: 'apify', name: 'some-actor' }),
            defaultBuild: async () => Promise.reject(error),
        }),
    });
}

describe('getActorDefinition()', () => {
    it('returns null when the default build fetch fails with 404', async () => {
        const client = stubDefaultBuildFailure(apifyApiError(404, 'Build was not found'));

        expect(await getActorDefinition('apify/some-actor', client)).toBeNull();
    });

    it('returns null when the default build fetch fails with 400', async () => {
        const client = stubDefaultBuildFailure(apifyApiError(400, 'Invalid Actor ID'));

        expect(await getActorDefinition('apify/some-actor', client)).toBeNull();
    });

    it('rethrows a 403 instead of reporting not-found', async () => {
        const client = stubDefaultBuildFailure(apifyApiError(403, 'Insufficient permissions'));

        await expect(getActorDefinition('apify/some-actor', client)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rethrows an error that carries no HTTP status', async () => {
        const error = new Error('socket hang up');
        const client = stubDefaultBuildFailure(error);

        await expect(getActorDefinition('apify/some-actor', client)).rejects.toBe(error);
    });

    it('returns null for a 404 carried on `code` instead of `statusCode`', async () => {
        const client = stubDefaultBuildFailure(Object.assign(new Error('Not found'), { code: 404 }));

        expect(await getActorDefinition('apify/some-actor', client)).toBeNull();
    });
});
