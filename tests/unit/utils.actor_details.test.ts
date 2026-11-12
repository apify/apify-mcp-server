import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { CODE_RUNTIME_ACTOR_NAME } from '../../src/const.js';
import type { ActorStore } from '../../src/types.js';
import { fetchActorDetails, resolveReadmeContent } from '../../src/utils/actor_details.js';
import type * as ActorSearchModule from '../../src/utils/actor_search.js';
import { searchActorsByKeywords } from '../../src/utils/actor_search.js';
import {
    DEFAULT_INPUT,
    mockActorBuildClient,
    mockBuild,
    mockDefaultBuild,
    mockStandbyActor,
    SEARCH_SCHEMA,
    STANDBY_BUILD_ID,
} from './helpers/actor_build_client.js';
import { mockApifyClient } from './helpers/tool_context.js';

vi.mock('../../src/utils/actor_search.js', () => ({
    searchActorsByKeywords: vi.fn().mockResolvedValue([]),
}));

function apifyApiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: message, message } }, status } as AxiosResponse, 1);
}

function stubApifyClient(getActor: () => Promise<unknown>, getBuild = getActor): ApifyClient {
    return mockApifyClient({
        token: 'test-token',
        actor: () => ({
            get: getActor,
            defaultBuild: async () => ({ get: getBuild }),
        }),
    });
}

const OTHER_ACTOR = { username: 'someone', name: 'some-other-actor' };
const [CODE_RUNTIME_USERNAME, CODE_RUNTIME_NAME] = CODE_RUNTIME_ACTOR_NAME.split('/');
const CODE_RUNTIME_ACTOR = { username: CODE_RUNTIME_USERNAME, name: CODE_RUNTIME_NAME };

describe('resolveReadmeContent()', () => {
    it('prefers the summary when present for a regular Actor', () => {
        const result = resolveReadmeContent({
            actorInfo: OTHER_ACTOR,
            readme: '# Full',
            readmeSummary: 'Short summary.',
        });
        expect(result).toEqual({ content: 'Short summary.', heading: '# README summary' });
    });

    it('falls back to the full readme when there is no summary', () => {
        const result = resolveReadmeContent({ actorInfo: OTHER_ACTOR, readme: '# Full' });
        expect(result).toEqual({ content: '# Full', heading: '# README' });
    });

    it('always returns the full readme for apify/code-runtime, even with a summary present', () => {
        const result = resolveReadmeContent({
            actorInfo: CODE_RUNTIME_ACTOR,
            readme: '# Full',
            readmeSummary: 'Short summary.',
        });
        expect(result).toEqual({ content: '# Full', heading: '# README' });
    });

    it('ignores a blank summary the same way for a regular Actor or code-runtime', () => {
        expect(resolveReadmeContent({ actorInfo: OTHER_ACTOR, readme: '# Full', readmeSummary: '   ' })).toEqual({
            content: '# Full',
            heading: '# README',
        });
        expect(resolveReadmeContent({ actorInfo: CODE_RUNTIME_ACTOR, readme: '# Full', readmeSummary: '   ' })).toEqual(
            {
                content: '# Full',
                heading: '# README',
            },
        );
    });
});

describe('fetchActorDetails()', () => {
    const RAW_PICTURE_URL = 'https://bucket.s3.amazonaws.com/picture.png';
    const stubActorWithPicture = () =>
        stubApifyClient(
            async () => ({ id: 'actor-id', pictureUrl: RAW_PICTURE_URL }),
            async () => ({ actorDefinition: { input: { type: 'object', properties: {} } } }),
        );

    it('uses the picture URL proxied by the Actor store and skips the Store search', async () => {
        vi.mocked(searchActorsByKeywords).mockClear();
        const actorStore: ActorStore = {
            getActorOutputSchema: vi.fn(),
            getActorOutputSchemaAsTypeObject: vi.fn(),
            getProxiedPictureUrl: (url) => `https://proxy.example.com/${url}`,
        };

        const result = await fetchActorDetails(stubActorWithPicture(), 'apify/web-scraper', { actorStore });

        expect(result?.actorInfo.pictureUrl).toBe(`https://proxy.example.com/${RAW_PICTURE_URL}`);
        expect(searchActorsByKeywords).not.toHaveBeenCalled();
    });

    it('falls back to the Store search picture URL when the Actor store cannot proxy pictures', async () => {
        vi.mocked(searchActorsByKeywords).mockResolvedValueOnce([
            { id: 'actor-id', pictureUrl: 'https://images.example.com/store-picture.webp' },
        ] as Awaited<ReturnType<typeof searchActorsByKeywords>>);

        const result = await fetchActorDetails(stubActorWithPicture(), 'apify/web-scraper');

        expect(result?.actorInfo.pictureUrl).toBe('https://images.example.com/store-picture.webp');
    });

    it('sends no call tracking with the picture Store search', async () => {
        const actual = await vi.importActual<typeof ActorSearchModule>('../../src/utils/actor_search.js');
        vi.mocked(searchActorsByKeywords).mockImplementationOnce(actual.searchActorsByKeywords);
        const store = { params: {}, list: vi.fn().mockResolvedValue({ items: [] }) };
        const storeSearchTracking = { traceId: 'thread-1', useCase: 'find a scraper' };
        const client = mockApifyClient({ ...stubActorWithPicture(), store: () => store, storeSearchTracking });

        await fetchActorDetails(client, 'apify/web-scraper');

        expect(store.list).toHaveBeenCalled();
        expect(store.params).not.toHaveProperty('_traceId');
        expect(store.params).not.toHaveProperty('_useCase');
    });

    it('returns null on a genuine 404 (Actor does not exist)', async () => {
        const client = stubApifyClient(() => Promise.reject(apifyApiError(404, 'Actor was not found')));

        const result = await fetchActorDetails(client, 'apify/no-such-actor');

        expect(result).toBeNull();
    });

    it('propagates a 401 (invalid/expired token) instead of reporting not-found', async () => {
        const client = stubApifyClient(() => Promise.reject(apifyApiError(401, 'Authentication token is not valid')));

        await expect(fetchActorDetails(client, 'apify/instagram-scraper')).rejects.toMatchObject({ statusCode: 401 });
    });
});

describe('fetchActorDetails() reads the server interface from the standby build', () => {
    // Build resolution is covered in `tools.actor_definition.test.ts`; these cases cover only this reader's wiring.
    const STANDBY_DEFINITION = {
        actorSpecification: 1,
        name: 'mcp-server',
        version: '2.0',
        readme: '# Standby build README',
        input: { type: 'object', properties: { url: { type: 'string' } } },
        webServerMcpPath: '/mcp',
        webServerSchema: SEARCH_SCHEMA,
    };

    it('takes the API schema from the tagged standby build and the input schema and README from the default build', async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: mockBuild(STANDBY_BUILD_ID, STANDBY_DEFINITION) },
        });

        const result = await fetchActorDetails(apifyClient, 'acme/mcp-server');

        expect(result).toMatchObject({
            webServerMcpPath: '/mcp',
            webServerSchema: SEARCH_SCHEMA,
            inputSchema: DEFAULT_INPUT,
            readme: '# Default build README',
        });
    });

    it("serves no API schema, not the default build's, when the standby build is deleted", async () => {
        const { apifyClient } = mockActorBuildClient({
            actor: mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild(),
            builds: { [STANDBY_BUILD_ID]: undefined },
        });

        const result = await fetchActorDetails(apifyClient, 'acme/mcp-server');

        expect(result).toMatchObject({ inputSchema: DEFAULT_INPUT, readme: '# Default build README' });
        expect(result?.webServerSchema).toBeUndefined();
        expect(result?.webServerMcpPath).toBeUndefined();
    });

    it('propagates a 403 from the standby build read instead of reporting not-found', async () => {
        const { apifyClient, buildGet } = mockActorBuildClient({
            actor: mockStandbyActor('beta', { taggedBuilds: { beta: { buildId: STANDBY_BUILD_ID } } }),
            defaultBuild: mockDefaultBuild(),
        });
        buildGet.mockRejectedValue(apifyApiError(403, 'Insufficient permissions'));

        await expect(fetchActorDetails(apifyClient, 'acme/mcp-server')).rejects.toMatchObject({ statusCode: 403 });
    });
});
