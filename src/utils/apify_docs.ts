/**
 * Utilities for searching Apify documentation using Algolia.
 *
 * Provides a function to query the Apify docs via Algolia's search API and return structured results.
 *
 * @module utils/apify-docs
 */
import { algoliasearch } from 'algoliasearch';

import log from '@apify/log';

import { DOCS_SNIPPET_HIGHLIGHT_TAG, DOCS_SNIPPET_MAX_WORDS, DOCS_SOURCES } from '../const.js';
import { docsVersionCache, searchApifyDocsCache } from '../state.js';
import type { ApifyDocsSearchResult } from '../types.js';

/**
 * Pool of Algolia search clients, keyed by app ID to handle multiple Algolia accounts.
 */
const clientPool: Record<string, ReturnType<typeof algoliasearch>> = {};

function getAlgoliaClient(appId: string, apiKey: string) {
    if (!clientPool[appId]) {
        clientPool[appId] = algoliasearch(appId, apiKey);
    }
    return clientPool[appId];
}

/**
 * Represents a single search hit from Algolia's response.
 */
type AlgoliaResultHit = {
    url_without_anchor?: string;
    anchor?: string;
    content?: string | null;
    type?: string;
    hierarchy?: Record<string, string | null>;
    /** Bounded, match-centered snippet of `content`; produced by `attributesToSnippet`. */
    _snippetResult?: { content?: { value?: string } };
};

/**
 * Represents a single Algolia search result containing hits.
 */
type AlgoliaResult = {
    hits?: AlgoliaResultHit[];
    facets?: Record<string, Record<string, number>>;
};

/** Orders dotted numeric versions by their components, so `3.18` sorts after `3.9`. */
function compareVersions(a: string, b: string): number {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const difference = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

/**
 * The highest numeric version in the index's `version` facet, cached per source for a day. `current`
 * is the unreleased next version. Returns `undefined` with a warning when the lookup fails or finds no
 * numeric version; that is not cached, so a later search retries.
 */
async function resolveLatestDocsVersion(
    client: ReturnType<typeof algoliasearch>,
    indexConfig: (typeof DOCS_SOURCES)[number],
): Promise<string | undefined> {
    const cachedVersion = docsVersionCache.get(indexConfig.id);
    if (cachedVersion) return cachedVersion;
    try {
        const response = await client.search({
            requests: [
                {
                    indexName: indexConfig.indexName,
                    query: '',
                    facets: ['version'],
                    hitsPerPage: 0,
                    maxValuesPerFacet: 100,
                },
            ],
        });
        const [result] = response.results as unknown as AlgoliaResult[];
        const releases = Object.keys(result?.facets?.version ?? {}).filter((version) => /^\d+(\.\d+)*$/.test(version));
        const latestVersion = releases.sort(compareVersions).at(-1);
        if (latestVersion) {
            docsVersionCache.set(indexConfig.id, latestVersion);
            return latestVersion;
        }
        log.warning(`[Algolia] No released version found for "${indexConfig.id}"; searching all versions`);
    } catch (error) {
        log.warning(`[Algolia] Version lookup failed for "${indexConfig.id}"; searching all versions`, {
            errMessage: error instanceof Error ? error.message : String(error),
        });
    }
    return undefined;
}

/**
 * Builds an Algolia search request with conditional filters based on documentation source configuration.
 *
 * @param {object} indexConfig - The documentation source configuration from DOCS_SOURCES
 * @param {string} query - The search query string
 * @param {string} version - The released version a versioned source is searched at; no version tag without it
 * @returns {object} Algolia search request object with index name, query, and conditional filters
 */
function prepareAlgoliaRequest(
    indexConfig: (typeof DOCS_SOURCES)[number],
    query: string,
    version: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchRequest: any = {
        indexName: indexConfig.indexName,
        query: query.trim(),
    };

    if ('filters' in indexConfig && indexConfig.filters) {
        searchRequest.filters = indexConfig.filters;
    }

    // Apply type filter if configured (e.g., for Crawlee to filter to lvl1 pages only)
    if ('typeFilter' in indexConfig && indexConfig.typeFilter) {
        const typeFilter = `type:${indexConfig.typeFilter}`;
        if (searchRequest.filters) {
            // Combine with existing filters using AND
            searchRequest.filters = `${searchRequest.filters} AND ${typeFilter}`;
        } else {
            searchRequest.filters = typeFilter;
        }
    }

    if ('facetFilters' in indexConfig && indexConfig.facetFilters) {
        const unversionedTags = 'unversionedTag' in indexConfig ? [indexConfig.unversionedTag] : [];
        searchRequest.facetFilters = version
            ? [...indexConfig.facetFilters, [...unversionedTags, `docusaurus_tag:docs-default-${version}`]]
            : indexConfig.facetFilters;
    }

    // Return a bounded, match-centered snippet of `content` rather than the full indexed attribute
    // (see DOCS_SNIPPET_MAX_WORDS for why). Highlight markup is injected around matches with a
    // strippable sentinel; skip full-content highlighting and the full-content attribute to keep
    // the response small.
    searchRequest.attributesToSnippet = [`content:${DOCS_SNIPPET_MAX_WORDS}`];
    searchRequest.snippetEllipsisText = '…';
    searchRequest.highlightPreTag = DOCS_SNIPPET_HIGHLIGHT_TAG;
    searchRequest.highlightPostTag = DOCS_SNIPPET_HIGHLIGHT_TAG;
    searchRequest.attributesToHighlight = [];
    searchRequest.attributesToRetrieve = ['url_without_anchor', 'anchor'];

    return searchRequest;
}

/**
 * Processes Algolia search response and transforms hits into ApifyDocsSearchResult array.
 *
 * @param {AlgoliaResult[]} results - Raw Algolia search results
 * @returns {ApifyDocsSearchResult[]} Processed search results with URL (may include anchor) and optional content
 */
function processAlgoliaResponse(results: AlgoliaResult[]): ApifyDocsSearchResult[] {
    const searchResults: ApifyDocsSearchResult[] = [];

    for (const result of results) {
        if (!result.hits?.length) {
            continue;
        }

        for (const hit of result.hits) {
            if (!hit.url_without_anchor) {
                continue;
            }

            let url = hit.url_without_anchor;
            if (hit.anchor && hit.anchor.trim()) {
                url += `#${hit.anchor}`;
            }

            // Bounded, match-centered snippet with the injected highlight sentinels stripped
            // (see DOCS_SNIPPET_HIGHLIGHT_TAG). `content` isn't retrieved, so the snippet is the only source.
            const content = hit._snippetResult?.content?.value?.split(DOCS_SNIPPET_HIGHLIGHT_TAG).join('');
            searchResults.push({
                url,
                ...(content ? { content } : {}),
            });
        }
    }

    return searchResults;
}

/**
 * Searches a specific documentation source by ID using Algolia.
 *
 * @param {string} docSource - The documentation source ID ('apify', 'crawlee-js', or 'crawlee-py').
 * @param {string} query - The search query string.
 * @returns {Promise<ApifyDocsSearchResult[]>} Array of search results with URL (may include anchor) and optional content.
 */
export async function searchDocsBySource(docSource: string, query: string): Promise<ApifyDocsSearchResult[]> {
    const indexConfig = DOCS_SOURCES.find((idx) => idx.id === docSource);

    if (!indexConfig) {
        throw new Error(`Unknown documentation source: ${docSource}`);
    }

    const client = getAlgoliaClient(indexConfig.appId, indexConfig.apiKey);

    const version = 'isVersioned' in indexConfig ? await resolveLatestDocsVersion(client, indexConfig) : undefined;
    const searchRequest = prepareAlgoliaRequest(indexConfig, query, version);
    const response = await client.search({
        requests: [searchRequest],
    });

    const results = response.results as unknown as AlgoliaResult[];
    const searchResults = processAlgoliaResponse(results);

    log.info(`[Algolia] Search completed successfully. Found ${searchResults.length} results for "${docSource}"`);
    return searchResults;
}

/**
 * Searches a documentation source with caching.
 *
 * @param {string} docSource - The documentation source ID ('apify', 'crawlee-js', or 'crawlee-py').
 * @param {string} query - The search query string.
 * @returns {Promise<ApifyDocsSearchResult[]>} Array of search results with URL (may include anchor) and optional content.
 */
export async function searchDocsBySourceCached(docSource: string, query: string): Promise<ApifyDocsSearchResult[]> {
    const cacheKey = `${docSource}::${query.trim().toLowerCase()}`;
    const cachedResults = searchApifyDocsCache.get(cacheKey);
    if (cachedResults) {
        log.debug(`[Algolia] Cache hit for key: "${cacheKey}". Returning ${cachedResults.length} cached results`);
        return cachedResults;
    }

    log.debug(`[Algolia] Cache miss for key: "${cacheKey}". Executing search...`);
    const results = await searchDocsBySource(docSource, query);
    searchApifyDocsCache.set(cacheKey, results);
    return results;
}
