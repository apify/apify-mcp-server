import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOCS_SNIPPET_HIGHLIGHT_TAG, DOCS_SNIPPET_MAX_WORDS } from '../../src/const.js';
import { searchDocsBySource } from '../../src/utils/apify_docs.js';

const searchMock = vi.fn();

vi.mock('algoliasearch', () => ({
    // Return a client whose `search` is our spy so we can assert the request and stub hits.
    algoliasearch: vi.fn(() => ({ search: searchMock })),
}));

describe('searchDocsBySource()', () => {
    beforeEach(() => {
        searchMock.mockReset();
        searchMock.mockResolvedValue({ results: [{ hits: [] }] });
    });

    describe('Algolia request', () => {
        it('asks Algolia for a bounded, match-centered content snippet', async () => {
            await searchDocsBySource('apify', 'standby actor');

            const request = searchMock.mock.calls[0]?.[0]?.requests?.[0];
            expect(request.attributesToSnippet).toEqual([`content:${DOCS_SNIPPET_MAX_WORDS}`]);
            // Highlight markup must use a strippable sentinel, not Algolia's default <span>.
            expect(request.highlightPreTag).toBe(DOCS_SNIPPET_HIGHLIGHT_TAG);
            expect(request.highlightPostTag).toBe(DOCS_SNIPPET_HIGHLIGHT_TAG);
        });

        it('preserves the source filters alongside the snippet params', async () => {
            await searchDocsBySource('apify', 'standby actor');

            const request = searchMock.mock.calls[0]?.[0]?.requests?.[0];
            expect(request.filters).toBe('version:latest');
            // Only the Crawlee sources resolve a release version first.
            expect(searchMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('Crawlee release version', () => {
        const DAY_MILLIS = 24 * 60 * 60 * 1000;

        beforeEach(() => {
            // A fresh module graph per test, so the version cache in state.ts starts empty.
            vi.resetModules();
        });

        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        async function importDocsSearch() {
            const { default: log } = await import('@apify/log');
            const { searchDocsBySource: search } = await import('../../src/utils/apify_docs.js');
            return { search, warning: vi.spyOn(log, 'warning').mockImplementation(() => undefined) };
        }

        function stubVersionFacet(versions: string[]) {
            searchMock.mockImplementation(async ({ requests }: { requests: { facets?: string[] }[] }) =>
                requests[0].facets
                    ? { results: [{ hits: [], facets: { version: Object.fromEntries(versions.map((v) => [v, 1])) } }] }
                    : { results: [{ hits: [] }] },
            );
        }

        function getFacetQueries() {
            return searchMock.mock.calls.filter(([{ requests }]) => requests[0].facets);
        }

        function getLastSearchRequest() {
            return searchMock.mock.calls.at(-1)?.[0]?.requests?.[0];
        }

        it('filters JavaScript docs to the highest numeric release plus unversioned pages', async () => {
            stubVersionFacet(['current', '3.18', '3.9', '3.17']);
            const { search } = await importDocsSearch();

            await search('crawlee-js', 'proxy');

            expect(getFacetQueries()[0][0].requests[0]).toMatchObject({
                indexName: 'crawlee',
                query: '',
                facets: ['version'],
                hitsPerPage: 0,
            });
            const request = getLastSearchRequest();
            expect(request.facetFilters).toEqual([
                'language:en',
                ['docusaurus_tag:default', 'docusaurus_tag:docs-default-3.18'],
            ]);
            expect(request.filters).toBe('type:lvl1');
            expect(request.attributesToSnippet).toEqual([`content:${DOCS_SNIPPET_MAX_WORDS}`]);
        });

        it('filters Python docs to the highest numeric release', async () => {
            stubVersionFacet(['current', '1.11', '0.6']);
            const { search } = await importDocsSearch();

            await search('crawlee-py', 'request queue');

            expect(getLastSearchRequest().facetFilters).toEqual(['language:en', ['docusaurus_tag:docs-default-1.11']]);
        });

        it('warns and searches without a version tag when the facet lists no numeric release', async () => {
            stubVersionFacet(['current', 'next']);
            const { search, warning } = await importDocsSearch();

            await search('crawlee-js', 'proxy');

            expect(warning).toHaveBeenCalled();
            expect(getLastSearchRequest().facetFilters).toEqual(['language:en']);
            expect(getLastSearchRequest().filters).toBe('type:lvl1');
        });

        it('warns and searches without a version tag when the version lookup fails, then retries', async () => {
            stubVersionFacet(['3.18']);
            searchMock.mockRejectedValueOnce(new Error('Algolia unreachable'));
            const { search, warning } = await importDocsSearch();

            await search('crawlee-js', 'proxy');
            expect(warning).toHaveBeenCalled();
            expect(getLastSearchRequest().facetFilters).toEqual(['language:en']);

            await search('crawlee-js', 'proxy');
            expect(getFacetQueries()).toHaveLength(2);
            expect(getLastSearchRequest().facetFilters).toEqual([
                'language:en',
                ['docusaurus_tag:default', 'docusaurus_tag:docs-default-3.18'],
            ]);
        });

        it('resolves the release once per source for a day, then again', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
            stubVersionFacet(['3.18']);
            const { search } = await importDocsSearch();

            await search('crawlee-js', 'proxy');
            await search('crawlee-js', 'crawler');
            expect(getFacetQueries()).toHaveLength(1);

            await search('crawlee-py', 'request queue');
            expect(getFacetQueries()).toHaveLength(2);

            vi.setSystemTime(new Date('2026-10-30T12:00:00Z').getTime() + DAY_MILLIS + 1);
            await search('crawlee-js', 'proxy');
            expect(getFacetQueries()).toHaveLength(3);
        });
    });

    describe('result processing', () => {
        it('returns the snippet with highlight sentinels stripped, not the full content attribute', async () => {
            const tag = DOCS_SNIPPET_HIGHLIGHT_TAG;
            searchMock.mockResolvedValue({
                results: [
                    {
                        hits: [
                            {
                                url_without_anchor: 'https://docs.apify.com/platform/actors/running/standby',
                                anchor: 'how-do-i-authenticate-my-requests',
                                content: 'FULL 34k-char indexed attribute that must not be returned',
                                _snippetResult: {
                                    content: { value: `authenticate your ${tag}standby${tag} requests…` },
                                },
                            },
                        ],
                    },
                ],
            });

            const results = await searchDocsBySource('apify', 'standby authenticate');

            expect(results).toEqual([
                {
                    url: 'https://docs.apify.com/platform/actors/running/standby#how-do-i-authenticate-my-requests',
                    content: 'authenticate your standby requests…',
                },
            ]);
        });

        it('omits content for hits without a snippet (e.g. crawlee lvl1 records)', async () => {
            searchMock.mockResolvedValue({
                results: [{ hits: [{ url_without_anchor: 'https://crawlee.dev/js/docs/guides/request-storage' }] }],
            });

            const results = await searchDocsBySource('crawlee-js', 'request storage');

            expect(results).toEqual([{ url: 'https://crawlee.dev/js/docs/guides/request-storage' }]);
        });
    });
});
