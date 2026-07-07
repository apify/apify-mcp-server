import { beforeEach, describe, expect, it, vi } from 'vitest';

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
