import { describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { validateActorInputRemotely } from '../../src/utils/validate_actor_input.js';

function stubClient(request: (...args: unknown[]) => Promise<unknown>): ApifyClient {
    return { httpClient: { axios: { request } } } as unknown as ApifyClient;
}

describe('validateActorInputRemotely()', () => {
    it('resolves and sends the input/build to the platform when the input is valid', async () => {
        const request = vi.fn().mockResolvedValue({ status: 200, data: { valid: true } });
        const client = stubClient(request);

        await expect(
            validateActorInputRemotely({
                apifyClient: client,
                actorId: 'actor-1',
                input: { query: 'x' },
                build: 'beta',
            }),
        ).resolves.toBeUndefined();

        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: expect.stringContaining('/v2/actors/actor-1/validate-input'),
                method: 'POST',
                data: { query: 'x' },
                params: { build: 'beta' },
            }),
        );
    });

    it('throws ActorInputValidationError with the platform message on a clean 400', async () => {
        const request = vi.fn().mockResolvedValue({
            status: 400,
            data: {
                error: { type: 'invalid-input', message: 'categoryFilterWords: must be one of the allowed values' },
            },
        });
        const client = stubClient(request);

        await expect(
            validateActorInputRemotely({ apifyClient: client, actorId: 'actor-1', input: {} }),
        ).rejects.toThrow('categoryFilterWords: must be one of the allowed values');
    });

    it('falls back to a generic message when the 400 body carries none', async () => {
        const request = vi.fn().mockResolvedValue({ status: 400, data: {} });
        const client = stubClient(request);

        await expect(
            validateActorInputRemotely({ apifyClient: client, actorId: 'actor-1', input: {} }),
        ).rejects.toThrow('Input does not match the Actor input schema.');
    });

    it('fails open (never throws ActorInputValidationError) on a network error, an unavailable client, or an unexpected status', async () => {
        const cases = [
            stubClient(vi.fn().mockRejectedValue(new Error('socket hang up'))),
            {} as unknown as ApifyClient, // missing httpClient — matches incomplete stubs elsewhere in the test suite
            stubClient(vi.fn().mockResolvedValue({ status: 500, data: {} })),
        ];

        for (const client of cases) {
            await expect(
                validateActorInputRemotely({ apifyClient: client, actorId: 'actor-1', input: {} }),
            ).resolves.toBeUndefined();
        }
    });
});
