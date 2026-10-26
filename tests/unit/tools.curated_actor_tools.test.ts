import { readFileSync } from 'node:fs';

import Ajv from 'ajv';
import type { Actor, ActorRun, Build } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { CURATED_ACTOR_CONTRACT_VERSION, CURATED_ACTOR_LIMITS } from '../../src/tools/actors/curated_actor_catalog.js';
import { CURATED_ACTOR_RELEASES, type CuratedActorReleases } from '../../src/tools/actors/curated_actor_releases.js';
import { createCuratedActorTools, CURATED_ACTOR_TOOLS } from '../../src/tools/actors/curated_actor_tools.js';
import { fixZodSchemaRequired } from '../../src/utils/ajv.js';
import {
    expectSchemaConformingStructuredContent,
    mockApifyClient,
    stubToolCallContext,
} from './helpers/tool_context.js';

const INPUTS: Record<string, Record<string, unknown>> = {
    [HELPER_TOOLS.CHATGPT_WEB_SEARCH]: { query: 'Apify documentation' },
    [HELPER_TOOLS.CHATGPT_WEB_FETCH]: { url: 'https://docs.apify.com' },
    [HELPER_TOOLS.CHATGPT_WEBSITE_CONTENT]: { url: 'https://docs.apify.com' },
    [HELPER_TOOLS.CHATGPT_SCREENSHOT]: { url: 'https://docs.apify.com' },
    [HELPER_TOOLS.CHATGPT_SITEMAP]: { url: 'https://docs.apify.com' },
    [HELPER_TOOLS.CHATGPT_GOOGLE_MAPS]: { query: 'coffee shops', location: 'Prague' },
    [HELPER_TOOLS.CHATGPT_AMAZON_PRODUCTS]: { urls: ['https://www.amazon.com/dp/B09X7MPX8L'] },
    [HELPER_TOOLS.CHATGPT_YOUTUBE]: { target: { type: 'query', query: 'Apify tutorial' } },
    [HELPER_TOOLS.CHATGPT_TIKTOK]: { target: { type: 'query', query: 'web scraping' } },
    [HELPER_TOOLS.CHATGPT_INSTAGRAM]: { urls: ['https://www.instagram.com/apifytech/'] },
    [HELPER_TOOLS.CHATGPT_FACEBOOK_POSTS]: { urls: ['https://www.facebook.com/apifytech/'] },
    [HELPER_TOOLS.CHATGPT_BOOKING]: { destination: 'Prague' },
    [HELPER_TOOLS.CHATGPT_TRIPADVISOR]: { destination: 'Prague' },
};

const BUILD_SCHEMAS = JSON.parse(
    readFileSync(new URL('../fixtures/curated_actor_build_schemas.json', import.meta.url), 'utf8'),
) as Record<
    string,
    {
        actorId: string;
        buildId: string;
        buildNumber: string;
        inputSchema: Record<string, unknown>;
    }
>;
const ALTERNATE_INPUTS: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
        HELPER_TOOLS.CHATGPT_YOUTUBE,
        { target: { type: 'urls', urls: ['https://www.youtube.com/@Apify'] } },
        { startUrls: [{ url: 'https://www.youtube.com/@Apify' }] },
    ],
    [
        HELPER_TOOLS.CHATGPT_TIKTOK,
        { target: { type: 'videos', urls: ['https://www.tiktok.com/@apify/video/12345'] } },
        { postURLs: ['https://www.tiktok.com/@apify/video/12345'] },
    ],
    [
        HELPER_TOOLS.CHATGPT_TIKTOK,
        { target: { type: 'profiles', urls: ['https://www.tiktok.com/@apify'] } },
        { profiles: ['https://www.tiktok.com/@apify'] },
    ],
    [
        HELPER_TOOLS.CHATGPT_FACEBOOK_POSTS,
        { ...INPUTS[HELPER_TOOLS.CHATGPT_FACEBOOK_POSTS], dateRange: { from: '2026-10-01', to: '2026-10-25' } },
        { onlyPostsNewerThan: '2026-10-01', onlyPostsOlderThan: '2026-10-25' },
    ],
    [
        HELPER_TOOLS.CHATGPT_BOOKING,
        { destination: 'Prague', stay: { checkIn: '2026-11-01', checkOut: '2026-11-03' } },
        { checkIn: '2026-11-01', checkOut: '2026-11-03' },
    ],
];

function validateUpstreamInput(name: string, input: unknown) {
    const snapshot = BUILD_SCHEMAS[name];
    expect(snapshot.buildId).toBe(CURATED_ACTOR_RELEASES[name].buildId);
    expect(snapshot.actorId).toBe(CURATED_ACTOR_RELEASES[name].actorId);
    expect(snapshot.buildNumber).toBe(CURATED_ACTOR_RELEASES[name].buildNumber);
    const validate = new Ajv({ strict: false }).compile(fixZodSchemaRequired(snapshot.inputSchema));
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
}

/** Local test approval only; production release snapshots deliberately have no approval. */
function createApprovedReleases(): CuratedActorReleases {
    return Object.fromEntries(
        Object.entries(CURATED_ACTOR_RELEASES).map(([name, release]) => [
            name,
            {
                ...release,
                review: {
                    contractVersion: CURATED_ACTOR_CONTRACT_VERSION,
                    reviewedBy: 'unit-test-fixture',
                    reviewedAt: '2026-10-26T00:00:00Z',
                    evidence: 'local synthetic API fixture',
                },
            },
        ]),
    );
}

function createApi(
    name: string,
    overrides: {
        actor?: Partial<Actor>;
        build?: Partial<Build>;
        run?: Partial<ActorRun>;
    } = {},
) {
    const release = CURATED_ACTOR_RELEASES[name];
    const actor = {
        id: release.actorId,
        name: 'scraper',
        username: 'apify',
        actorPermissionLevel: 'LIMITED_PERMISSIONS',
        isDeprecated: false,
        ...overrides.actor,
    };
    const build = {
        id: release.buildId,
        actId: release.actorId,
        buildNumber: release.buildNumber,
        status: 'SUCCEEDED',
        ...overrides.build,
    };
    const run = {
        id: 'curated-run',
        actId: release.actorId,
        buildId: release.buildId,
        status: 'SUCCEEDED',
        startedAt: new Date('2026-10-26T00:00:00Z'),
        finishedAt: new Date('2026-10-26T00:00:01Z'),
        defaultDatasetId: 'curated-dataset',
        defaultKeyValueStoreId: 'curated-store',
        stats: { runTimeSecs: 1 },
        ...overrides.run,
    };
    const start = vi.fn().mockResolvedValue(run);
    const getActor = vi.fn().mockResolvedValue(actor);
    const getBuild = vi.fn().mockResolvedValue(build);
    const abort = vi.fn().mockResolvedValue(run);
    const waitForFinish = vi.fn().mockResolvedValue({ ...run, status: 'SUCCEEDED' });
    const actorClient = vi.fn().mockReturnValue({ get: getActor, start });
    const client = mockApifyClient({
        actor: actorClient,
        build: vi.fn().mockReturnValue({ get: getBuild }),
        run: () => ({ get: async () => run, abort, waitForFinish }),
        dataset: () => ({ get: async () => ({ id: 'curated-dataset', itemCount: 1, fields: ['url'] }) }),
        keyValueStore: () => ({ listKeys: async () => ({ items: [], count: 0, isTruncated: false }) }),
    });
    return { client, start, getActor, getBuild, abort, actorClient, waitForFinish };
}

function getApprovedTool(name: string, releases = createApprovedReleases()) {
    return createCuratedActorTools(releases).find((tool) => tool.name === name)!;
}

describe('curated release approval and execution', () => {
    it.each(CURATED_ACTOR_TOOLS)('keeps $name disabled until its exact release is approved', async (tool) => {
        const api = createApi(tool.name);
        const result = await tool.call(stubToolCallContext(INPUTS[tool.name], api.client));
        expect(result.isError).toBe(true);
        expect(api.getActor).not.toHaveBeenCalled();
        expect(api.start).not.toHaveBeenCalled();
    });

    it.each(Object.keys(INPUTS))('runs %s by fixed ID and build with server-owned limits', async (name) => {
        const tool = getApprovedTool(name);
        const api = createApi(name);
        expect(tool.ajvValidate(INPUTS[name])).toBe(true);
        const result = await tool.call(stubToolCallContext(INPUTS[name], api.client));
        expectSchemaConformingStructuredContent(result, tool.outputSchema!);
        expect(api.actorClient).toHaveBeenCalledWith(CURATED_ACTOR_RELEASES[name].actorId);
        validateUpstreamInput(name, api.start.mock.calls[0][0]);
        expect(api.start).toHaveBeenCalledWith(expect.not.objectContaining({ waitSecs: expect.anything() }), {
            build: CURATED_ACTOR_RELEASES[name].buildNumber,
            memory: CURATED_ACTOR_LIMITS.memoryMbytes,
            timeout: CURATED_ACTOR_LIMITS.timeoutSecs,
            maxTotalChargeUsd: CURATED_ACTOR_LIMITS.maxTotalChargeUsd,
            maxItems: CURATED_ACTOR_LIMITS.maxPaidItems,
            forcePermissionLevel: 'LIMITED_PERMISSIONS',
            restartOnError: false,
        });
    });

    it.each(ALTERNATE_INPUTS)('maps the alternate target or dates for %s', async (name, args, mapped) => {
        const tool = getApprovedTool(name);
        const api = createApi(name);
        expect(tool.ajvValidate(args)).toBe(true);
        expect((await tool.call(stubToolCallContext(args, api.client))).isError).not.toBe(true);
        expect(api.start.mock.calls[0][0]).toMatchObject(mapped);
        validateUpstreamInput(name, api.start.mock.calls[0][0]);
    });

    it.each([0, 3, 45])('honors waitSecs=%i in task mode', async (waitSecs) => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEB_SEARCH);
        const api = createApi(tool.name, { run: { status: 'RUNNING' } });
        const context = stubToolCallContext({ ...INPUTS[tool.name], waitSecs }, api.client);
        context.taskMode = true;
        expect((await tool.call(context)).isError).not.toBe(true);
        if (waitSecs === 0) expect(api.waitForFinish).not.toHaveBeenCalled();
        else expect(api.waitForFinish).toHaveBeenCalledWith({ waitSecs });
    });

    it('refuses maintenance evidence belonging to a different Actor', async () => {
        const name = HELPER_TOOLS.CHATGPT_WEB_SEARCH;
        const releases = createApprovedReleases();
        const tool = getApprovedTool(name, {
            ...releases,
            [name]: { ...releases[name], maintenanceEvidence: 'https://apify.com/apify/web-fetch' },
        });
        const api = createApi(name);
        expect((await tool.call(stubToolCallContext(INPUTS[name], api.client))).isError).toBe(true);
        expect(api.getActor).not.toHaveBeenCalled();
        expect(api.start).not.toHaveBeenCalled();
    });

    it.each([
        { actor: { actorPermissionLevel: 'FULL_PERMISSIONS' } },
        { actor: { isDeprecated: true } },
        { build: { actId: 'differentActor123' } },
        { build: { buildNumber: '0.0.999' } },
        { build: { id: 'differentBuild123' } },
        { build: { status: 'FAILED' } },
    ] as const)('refuses a preflight mismatch: %j', async (overrides) => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEB_SEARCH);
        const api = createApi(tool.name, overrides);
        const result = await tool.call(stubToolCallContext(INPUTS[tool.name], api.client));
        expect(result.isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it('refuses a missing build', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEB_SEARCH);
        const api = createApi(tool.name);
        api.getBuild.mockResolvedValue(undefined);
        expect((await tool.call(stubToolCallContext(INPUTS[tool.name], api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it('rejects mutable build tags even in an approval fixture', async () => {
        const releases = createApprovedReleases();
        const name = HELPER_TOOLS.CHATGPT_WEB_SEARCH;
        const tool = getApprovedTool(name, { ...releases, [name]: { ...releases[name], buildNumber: 'latest' } });
        const api = createApi(name);
        expect((await tool.call(stubToolCallContext(INPUTS[name], api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it('does not accept an approval for another Actor', async () => {
        const releases = createApprovedReleases();
        const name = HELPER_TOOLS.CHATGPT_WEB_SEARCH;
        const tool = getApprovedTool(name, { ...releases, [name]: releases[HELPER_TOOLS.CHATGPT_WEB_FETCH] });
        const api = createApi(name);
        expect((await tool.call(stubToolCallContext(INPUTS[name], api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it('aborts a run returned with an unexpected build', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEB_SEARCH);
        const api = createApi(tool.name, { run: { buildId: 'unexpected-build' } });
        expect((await tool.call(stubToolCallContext(INPUTS[tool.name], api.client))).isError).toBe(true);
        expect(api.abort).toHaveBeenCalledOnce();
    });

    it('does not start after cancellation during preflight', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEB_SEARCH);
        const api = createApi(tool.name);
        const context = stubToolCallContext(INPUTS[tool.name], api.client);
        const controller = new AbortController();
        context.signal = controller.signal;
        api.getBuild.mockImplementation(async () => {
            controller.abort();
            return undefined;
        });
        expect(await tool.call(context)).toEqual({});
        expect(api.start).not.toHaveBeenCalled();
    });

    it('does not suggest retrieval tools absent from the session', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEB_SEARCH);
        const api = createApi(tool.name);
        const result = await tool.call(
            stubToolCallContext(INPUTS[tool.name], api.client, { loadedToolNames: [tool.name] }),
        );
        expect(JSON.stringify(result)).not.toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
        expectSchemaConformingStructuredContent(result, tool.outputSchema!);
    });
});

describe('curated input boundaries', () => {
    it('rejects mixed target modes and extra keys inside a target', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_YOUTUBE);
        const api = createApi(tool.name);
        const args = { target: { type: 'query', query: 'Apify', urls: ['https://youtube.com/@Apify'], headers: {} } };
        expect(tool.ajvValidate(args)).toBe(false);
        expect((await tool.call(stubToolCallContext(args, api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it.each([
        { checkIn: '2026-11-03', checkOut: '2026-11-01' },
        { checkIn: '2026-11-01', checkOut: '2026-12-15' },
        { checkIn: '2026-02-30', checkOut: '2026-03-01' },
    ])('rejects an invalid or unbounded accommodation stay %j', async (stay) => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_BOOKING);
        const api = createApi(tool.name);
        expect((await tool.call(stubToolCallContext({ destination: 'Prague', stay }, api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it('rejects a reversed Facebook date range', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_FACEBOOK_POSTS);
        const api = createApi(tool.name);
        const args = { ...INPUTS[tool.name], dateRange: { from: '2026-10-25', to: '2026-10-01' } };
        expect((await tool.call(stubToolCallContext(args, api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });
    it.each(CURATED_ACTOR_TOOLS)('rejects extra keys in $name without silently stripping them', async ({ name }) => {
        const tool = getApprovedTool(name);
        const api = createApi(name);
        const args = { ...INPUTS[name], actorId: 'unreviewed-actor', build: 'latest', input: { token: 'test-secret' } };
        const original = structuredClone(args);
        expect(tool.ajvValidate(args)).toBe(false);
        expect(args).toEqual(original);
        expect((await tool.call(stubToolCallContext(args, api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
        expect(tool.redactArgs!(args)).toEqual({});
    });

    it.each([
        [HELPER_TOOLS.CHATGPT_WEB_FETCH, { headers: { Authorization: 'test-secret' } }],
        [HELPER_TOOLS.CHATGPT_WEBSITE_CONTENT, { pageFunction: 'async () => fetch("https://example.com")' }],
        [HELPER_TOOLS.CHATGPT_WEBSITE_CONTENT, { initialCookies: [{ name: 'session', value: 'test-secret' }] }],
        [HELPER_TOOLS.CHATGPT_GOOGLE_MAPS, { maximumLeadsEnrichmentRecords: 1 }],
        [HELPER_TOOLS.CHATGPT_TIKTOK, { videoKvStoreIdOrName: 'existing-store' }],
        [HELPER_TOOLS.CHATGPT_YOUTUBE, { transcriptionAndSubtitle: 'ALWAYS_TRANSCRIBE' }],
        [HELPER_TOOLS.CHATGPT_INSTAGRAM, { resultsType: 'stories' }],
        [HELPER_TOOLS.CHATGPT_SITEMAP, { checkPageStatus: true }],
        [HELPER_TOOLS.CHATGPT_AMAZON_PRODUCTS, { useCaptchaSolver: true }],
    ])('rejects excluded capability in %s: %j', async (name, extra) => {
        const tool = getApprovedTool(name as string);
        const api = createApi(name as string);
        const args = { ...INPUTS[name as string], ...(extra as object) };
        expect(tool.ajvValidate(args)).toBe(false);
        expect((await tool.call(stubToolCallContext(args, api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it.each([0, 21, '10'])('rejects an invalid result limit %s', async (maxResults) => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_GOOGLE_MAPS);
        const api = createApi(tool.name);
        const args = { ...INPUTS[tool.name], maxResults };
        expect(tool.ajvValidate(args)).toBe(false);
        expect((await tool.call(stubToolCallContext(args, api.client))).isError).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it.each([
        'file:///etc/passwd',
        'https://secret@example.com',
        'http://127.0.0.1',
        'http://localhost',
        'http://[::1]',
        'https://docs.apify.com:8443',
    ])('rejects unsafe fetch URL %s', async (url) => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEB_FETCH);
        const api = createApi(tool.name);
        expect((await tool.call(stubToolCallContext({ url }, api.client))).isError).toBe(true);
        expect(api.getActor).not.toHaveBeenCalled();
    });

    it('rejects a third-party domain impersonating a supported platform', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_INSTAGRAM);
        const api = createApi(tool.name);
        expect(
            (await tool.call(stubToolCallContext({ urls: ['https://instagram.com.evil.example/profile'] }, api.client)))
                .isError,
        ).toBe(true);
        expect(api.start).not.toHaveBeenCalled();
    });

    it.each([
        ['http://www.instagram.com/apifytech/'],
        ['https://m.instagram.com/apifytech/'],
        ['https://instagram.com/'],
        ['https://www.instagram.com/apifytech/', 'https://www.instagram.com/apifytech/'],
    ])('rejects Instagram URLs outside the pinned Actor schema: %j', async (...urls) => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_INSTAGRAM);
        const api = createApi(tool.name);
        expect((await tool.call(stubToolCallContext({ urls }, api.client))).isError).toBe(true);
        expect(api.getActor).not.toHaveBeenCalled();
        expect(api.start).not.toHaveBeenCalled();
    });

    it('constructs the crawler restrictions explicitly instead of inheriting changing defaults', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_WEBSITE_CONTENT);
        const api = createApi(tool.name);
        await tool.call(stubToolCallContext({ url: 'https://docs.apify.com', maxPages: 3, maxDepth: 0 }, api.client));
        expect(api.start.mock.calls[0][0]).toMatchObject({
            startUrls: [{ url: 'https://docs.apify.com' }],
            maxCrawlPages: 3,
            maxResults: 3,
            maxCrawlDepth: 0,
            respectRobotsTxtFile: true,
            pageFunction: '',
            initialCookies: [],
            customHttpHeaders: {},
            clickElementsCssSelector: '',
            saveFiles: false,
            summarize: false,
            crawlerType: 'cheerio',
        });
    });

    it('constructs social exclusions without a writable storage target', async () => {
        const tool = getApprovedTool(HELPER_TOOLS.CHATGPT_TIKTOK);
        const api = createApi(tool.name);
        await tool.call(stubToolCallContext(INPUTS[tool.name], api.client));
        expect(api.start.mock.calls[0][0]).toMatchObject({
            searchSection: '/video',
            maxFollowersPerProfile: 0,
            commentsPerPost: 0,
            shouldDownloadVideos: false,
            aiVideoSummary: false,
            downloadSubtitlesOptions: 'NEVER_DOWNLOAD_SUBTITLES',
        });
        expect(api.start.mock.calls[0][0]).not.toHaveProperty('videoKvStoreIdOrName');
    });
});
