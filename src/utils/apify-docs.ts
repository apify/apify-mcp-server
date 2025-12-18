/**
 * Utilities for searching Apify documentation using Algolia.
 *
 * Provides a function to query the Apify docs via Algolia's search API and return structured results.
 *
 * @module utils/apify-docs
 */
import { algoliasearch } from 'algoliasearch';

import log from '@apify/log';

import { DOCS_SOURCES } from '../const.js';
import { searchApifyDocsCache } from '../state.js';
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
};

/**
 * Represents a single Algolia search result containing hits.
 */
type AlgoliaResult = {
    hits?: AlgoliaResultHit[];
};

/**
 * Searches a specific documentation source by ID using Algolia.
 *
 * @param {string} docSource - The documentation source ID ('apify', 'crawlee-js', or 'crawlee-py').
 * @param {string} query - The search query string.
 * @returns {Promise<ApifyDocsSearchResult[]>} Array of search results with URL, optional fragment, and content.
 */
export async function searchDocsBySource(
    docSource: string,
    query: string,
): Promise<ApifyDocsSearchResult[]> {
    const indexConfig = DOCS_SOURCES.find((idx) => idx.id === docSource);

    if (!indexConfig) {
        const error = `Unknown documentation source: ${docSource}`;
        log.error(`[Algolia] ${error}`);
        throw new Error(error);
    }

    const client = getAlgoliaClient(indexConfig.appId, indexConfig.apiKey);

    try {
        // Build request with conditional filtering based on source
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const searchRequest: any = {
            indexName: indexConfig.indexName,
            query: query.trim(),
        };

        // Apply filters based on source configuration
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
            searchRequest.facetFilters = indexConfig.facetFilters;
        }

        const response = await client.search({
            requests: [searchRequest],
        });

        const results = response.results as unknown as AlgoliaResult[];
        const searchResults: ApifyDocsSearchResult[] = [];

        for (const result of results) {
            if (result.hits && result.hits.length > 0) {
                for (const hit of result.hits) {
                    if (!hit.url_without_anchor) {
                        continue;
                    }

                    // Check if this documentation source supports fragments
                    const supportsFragments = indexConfig.supportsFragments ?? true;
                    const hasFragment = hit.anchor && hit.anchor.trim() !== '';

                    // If source doesn't support fragments and there's no fragment, return URL only
                    if (!supportsFragments && !hasFragment) {
                        searchResults.push({
                            url: hit.url_without_anchor,
                        });
                        continue;
                    }

                    // Use content if available, fallback to hierarchy info
                    let hitContent = hit.content;
                    if (!hitContent && hit.hierarchy) {
                        // Build content from hierarchy (useful for lvl1, lvl2 hits etc)
                        hitContent = Object.values(hit.hierarchy)
                            .filter((v) => v !== null)
                            .join(' > ');
                    }

                    if (!hitContent) {
                        continue;
                    }

                    searchResults.push({
                        url: hit.url_without_anchor,
                        ...(hasFragment ? { fragment: hit.anchor } : {}),
                        content: hitContent,
                    });
                }
            }
        }

        log.info(`[Algolia] Search completed successfully. Found ${searchResults.length} results for "${docSource}"`);
        return searchResults;
    } catch (error) {
        log.error(`[Algolia] Search failed for "${docSource}" with query "${query}"`, error as Error);
        throw error;
    }
}

/**
 * Searches a documentation source with caching.
 *
 * @param {string} docSource - The documentation source ID ('apify', 'crawlee-js', or 'crawlee-py').
 * @param {string} query - The search query string.
 * @returns {Promise<ApifyDocsSearchResult[]>} Array of search results with URL, optional fragment, and content.
 */
export async function searchDocsBySourceCached(
    docSource: string,
    query: string,
): Promise<ApifyDocsSearchResult[]> {
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

/**
 * Searches the Apify documentation using Algolia and caches the results.
 * Kept for backward compatibility. Defaults to 'apify' source.
 *
 * @param {string} query - The search query string.
 * @returns {Promise<ApifyDocsSearchResult[]>} Array of search results with URL, optional fragment, and content.
 */
export async function searchApifyDocsCached(query: string): Promise<ApifyDocsSearchResult[]> {
    return searchDocsBySourceCached('apify', query);
}
