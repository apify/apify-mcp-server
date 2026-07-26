import type { ValidateFunction } from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import { InternalError } from '../../src/mcp/errors.js';
import { resolvePaymentProvider } from '../../src/payments/index.js';
import { prompts } from '../../src/prompts/index.js';
import type * as ApiResourcesModule from '../../src/resources/api_resources.js';
import type { ActorsMcpServerOptions, PromptBase } from '../../src/types.js';
import { getRequestHandler, withServer, withStatelessServer } from './helpers/mcp_server.js';

// The 429/5xx branch of the API proxy is the only source of InternalError on the read path; stubbing
// the proxy is how the error mapping is reached without a network call.
vi.mock('../../src/resources/api_resources.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ApiResourcesModule>();
    return { ...actual, readApiResource: vi.fn() };
});

const { readApiResource } = await import('../../src/resources/api_resources.js');
const readApiResourceMock = vi.mocked(readApiResource);

/** The same request served by the sessionful path, for parity comparison. */
async function callViaLegacy(
    method: string,
    params: Record<string, unknown> = {},
    options?: Partial<ActorsMcpServerOptions>,
): Promise<unknown> {
    return await withServer(async (server) => await getRequestHandler(server, method)({ method, params }, {}), options);
}

/** Wire-normalize a sessionful result so it compares against one that crossed a JSON boundary. */
function asWire(result: unknown): unknown {
    return JSON.parse(JSON.stringify(result));
}

/**
 * Registers a prompt in the live registry for the duration of `run`. The registry ships empty
 * (`src/prompts/index.ts`), so without this both paths return `[]` and a parity comparison of
 * `prompts/list` — and any `prompts/get` success case — would prove nothing.
 */
async function withTestPrompt<T>(run: () => Promise<T>): Promise<T> {
    prompts.push({
        name: 'greet',
        description: 'Greets a person',
        ajvValidate: Object.assign(() => true, { errors: null }) as unknown as ValidateFunction,
        render: (args: Record<string, string>) => `Hello ${args.who ?? 'world'}`,
    } as PromptBase);
    try {
        return await run();
    } finally {
        prompts.length = 0;
    }
}

describe('createStatelessServer() prompts and resources', () => {
    describe('prompts', () => {
        it('lists the same prompts as the sessionful path', async () => {
            await withTestPrompt(async () => {
                const legacy = await callViaLegacy('prompts/list');

                await withStatelessServer(async ({ call }) => {
                    const response = await call('prompts/list');

                    expect(response.result?.prompts).toEqual(asWire((legacy as { prompts: unknown }).prompts));
                    expect(response.result?.prompts).toEqual([{ name: 'greet', description: 'Greets a person' }]);
                });
            });
        });

        it('renders a known prompt with the same payload as the sessionful path', async () => {
            await withTestPrompt(async () => {
                const params = { name: 'greet', arguments: { who: 'Ada' } };
                const legacy = await callViaLegacy('prompts/get', params);

                await withStatelessServer(async ({ call }) => {
                    const response = await call('prompts/get', params);

                    expect(response.result).toMatchObject(asWire(legacy) as Record<string, unknown>);
                    expect(response.result?.messages).toEqual([
                        { role: 'user', content: { type: 'text', text: 'Hello Ada' } },
                    ]);
                });
            });
        });

        it('maps an unknown prompt name to invalid params, as the sessionful path does', async () => {
            await expect(callViaLegacy('prompts/get', { name: 'no-such-prompt' })).rejects.toMatchObject({
                code: -32602,
            });

            await withStatelessServer(async ({ call }) => {
                const response = await call('prompts/get', { name: 'no-such-prompt' });

                expect(response.error?.code).toBe(-32602);
                expect(response.error?.message).toContain('no-such-prompt');
            });
        });
    });

    describe('resources', () => {
        it('lists the same resources as the sessionful path', async () => {
            // A usage-guide-carrying payment provider is what makes the list non-empty outside apps
            // mode; without one both paths return `[]` and the comparison would prove nothing.
            const options = { paymentProvider: await resolvePaymentProvider('skyfire') };
            const legacy = await callViaLegacy('resources/list', {}, options);

            await withStatelessServer(async ({ call }) => {
                const response = await call('resources/list');

                const resources = (response.result?.resources ?? []) as { uri: string }[];
                expect(response.result?.resources).toEqual((legacy as { resources: unknown }).resources);
                expect(resources.map((resource) => resource.uri)).toEqual(['file://readme.md']);
            }, options);
        });

        it('lists the same resource templates as the sessionful path', async () => {
            const legacy = await callViaLegacy('resources/templates/list');

            await withStatelessServer(async ({ call }) => {
                const response = await call('resources/templates/list');
                expect(response.result?.resourceTemplates).toEqual(
                    (legacy as { resourceTemplates: unknown }).resourceTemplates,
                );
            });
        });

        it('reads an API resource through the proxy, with the same payload as the sessionful path', async () => {
            const uri = 'https://api.apify.com/v2/datasets/d1/items';
            readApiResourceMock.mockResolvedValue({ contents: [{ uri, text: '[]' }] } as never);
            const legacy = (await callViaLegacy('resources/read', { uri })) as { contents: unknown };

            await withStatelessServer(async ({ call }) => {
                const response = await call('resources/read', { uri });

                expect(response.result?.contents).toEqual(legacy.contents);
                expect(response.result?.contents).toEqual([{ uri, text: '[]' }]);
            });
        });

        it('maps an unreadable URI to invalid params', async () => {
            await withStatelessServer(async ({ call }) => {
                const response = await call('resources/read', { uri: 'file://nope.md' });

                expect(response.error?.code).toBe(-32602);
                expect(response.error?.data).toEqual({ uri: 'file://nope.md' });
            });
        });

        it('reads with no Apify client when the request carries no token', async () => {
            // Deliberate: a payment-only session (x402/Skyfire, no Apify token) gets no client, so
            // the proxy refuses the read. Same rule as the sessionful `resolveApifyClient`.
            const uri = 'https://api.apify.com/v2/datasets/d1/items';
            readApiResourceMock.mockResolvedValue({ contents: [] } as never);

            await withStatelessServer(
                async ({ call }) => {
                    await call('resources/read', { uri });

                    expect(readApiResourceMock).toHaveBeenCalledWith(uri, undefined);
                },
                { token: undefined, allowUnauthMode: true },
            );
        });

        it('passes a non-domain read failure through as a protocol error', async () => {
            // Neither InvalidParams nor InternalError: the mapper leaves it untouched and the SDK
            // turns it into a JSON-RPC error, rather than it becoming a bogus success payload.
            readApiResourceMock.mockRejectedValue(new Error('the proxy exploded'));

            await withStatelessServer(async ({ call }) => {
                const response = await call('resources/read', {
                    uri: 'https://api.apify.com/v2/datasets/d1/items',
                });

                expect(response.result).toBeUndefined();
                expect(response.error?.message).toContain('the proxy exploded');
            });
        });

        it('maps an upstream fault to an internal error', async () => {
            readApiResourceMock.mockRejectedValue(new InternalError('upstream is unhappy'));

            await withStatelessServer(async ({ call }) => {
                const response = await call('resources/read', {
                    uri: 'https://api.apify.com/v2/datasets/d1/items',
                });

                expect(response.error?.code).toBe(-32603);
                expect(response.error?.message).toBe('upstream is unhappy');
            });
        });
    });
});
