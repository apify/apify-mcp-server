import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { getDataset } from '../../src/tools/storage/get_dataset.js';
import type { ActorsMcpServerOptions } from '../../src/types.js';
import { getRequestHandler, withServer } from './helpers/mcp_server.js';

const API_BASE_URL = 'http://api.internal.example:3333';
const API_PUBLIC_BASE_URL = 'https://api.example.test';
const CONSOLE_BASE_URL = 'https://console.example.test';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('ActorsMcpServer platform URL options', () => {
    it.each([
        ['apiBaseUrl', 'APIFY_API_BASE_URL', API_BASE_URL],
        ['apiPublicBaseUrl', 'APIFY_API_PUBLIC_BASE_URL', API_PUBLIC_BASE_URL],
        ['consoleBaseUrl', 'APIFY_CONSOLE_BASE_URL', CONSOLE_BASE_URL],
    ] as const)('%s wins over %s', async (option, envVar, url) => {
        vi.stubEnv(envVar, 'http://localhost:9999');

        await withServer(async (server) => expect(server.platformUrls[option]).toBe(url), { [option]: url });
    });

    it('fall back to the env vars when not set', async () => {
        vi.stubEnv('APIFY_API_BASE_URL', API_BASE_URL);
        vi.stubEnv('APIFY_API_PUBLIC_BASE_URL', API_PUBLIC_BASE_URL);
        vi.stubEnv('APIFY_CONSOLE_BASE_URL', CONSOLE_BASE_URL);

        await withServer(async (server) => {
            expect(server.platformUrls).toEqual({
                apiBaseUrl: API_BASE_URL,
                apiPublicBaseUrl: API_PUBLIC_BASE_URL,
                consoleBaseUrl: CONSOLE_BASE_URL,
            });
        });
    });
});

describe('ActorsMcpServer with platform URL options', () => {
    const options: Partial<ActorsMcpServerOptions> = {
        apiBaseUrl: API_BASE_URL,
        apiPublicBaseUrl: API_PUBLIC_BASE_URL,
        consoleBaseUrl: CONSOLE_BASE_URL,
        // Only Console UI token sessions get Console links.
        token: 'apify_ui_platform-urls-test',
    };

    it('builds the Console link in a tool result on the passed Console origin', async () => {
        vi.spyOn(ApifyClient.prototype, 'user').mockReturnValue({
            get: async () => ({ id: 'USER_ID' }),
        } as unknown as ReturnType<ApifyClient['user']>);
        vi.spyOn(ApifyClient.prototype, 'dataset').mockReturnValue({
            get: async () => ({ id: 'DATASET_ID', name: 'my-dataset', itemCount: 1, fields: ['url'] }),
        } as unknown as ReturnType<ApifyClient['dataset']>);

        await withServer(async (server) => {
            server.upsertTools([getDataset]);
            const result = await getRequestHandler(server, 'tools/call')(
                {
                    method: 'tools/call',
                    params: {
                        name: getDataset.name,
                        arguments: { datasetId: 'DATASET_ID' },
                        _meta: { mcpSessionId: 'platform-urls' },
                    },
                },
                { signal: new AbortController().signal, sendNotification: vi.fn() },
            );

            expect(JSON.stringify(result.content)).toContain(`${CONSOLE_BASE_URL}/storage/datasets/DATASET_ID`);
        }, options);
    });

    it('names the passed client-facing API origin in the server instructions and resource templates', async () => {
        await withServer(async (server) => {
            const { resourceTemplates } = await server.resourceService.listResourceTemplates();

            expect(server.getServerInstructions()).toContain(`${API_PUBLIC_BASE_URL}/v2/`);
            expect(server.getServerInstructions()).not.toContain('https://api.apify.com');
            expect(resourceTemplates[0].uriTemplate).toContain(`${API_PUBLIC_BASE_URL}/v2/`);
        }, options);
    });

    it('sends resource reads to the passed API origin with the URI kept as given', async () => {
        const uri = `${API_PUBLIC_BASE_URL}/v2/datasets/DATASET_ID`;
        await withServer(async (server) => {
            const client = server.resolveApifyClient({})!;
            const request = vi.spyOn(client.httpClient.axios, 'request').mockResolvedValue({
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
                data: (async function* body() {
                    yield Buffer.from('{}');
                })(),
            });

            const result = await server.resourceService.readResource(uri, client);

            expect(request.mock.calls[0][0].url).toBe(`${API_BASE_URL}/v2/datasets/DATASET_ID`);
            expect(result.contents[0].uri).toBe(uri);
        }, options);
    });
});
