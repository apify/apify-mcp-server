/**
 * Utilities for searching Apify documentation using Algolia.
 *
 * Provides a function to query the Apify docs via Algolia's search API and return structured results.
 *
 * @module utils/apify-docs
 */
import { algoliasearch } from 'algoliasearch';

import { ALGOLIA } from '../const.js';
import { searchApifyDocsCache } from '../state.js';
import type { ApifyDocsSearchResult } from '../types.js';

/**
 * Algolia search client instance, configured with Apify's Algolia credentials.
 */
const client = algoliasearch(ALGOLIA.appId, ALGOLIA.apiKey);

/**
 * Represents a single search hit from Algolia's response.
 */
interface AlgoliaResultHit {
    url_without_anchor?: string;
    anchor?: string;
    content?: string;
}

/**
 * Represents a single Algolia search result containing hits.
 */
interface AlgoliaResult {
    hits?: AlgoliaResultHit[];
}

/**
 * Searches the Apify documentation using Algolia and returns relevant results.
 *
 * @param {string} query - The search query string.
 * @returns {Promise<ApifyDocsSearchResult[]>} Array of search results with URL, optional fragment, and content.
 */
export async function searchApifyDocs(query: string): Promise<ApifyDocsSearchResult[]> {
    const response = await client.search({
        requests: [
            {
                indexName: ALGOLIA.indexName,
                query: query.trim(),
                filters: 'version:latest',
            },
        ],
    });
    // So we can access the results without TypeScript errors
    const results = response.results as unknown as AlgoliaResult[];

    const searchResults: ApifyDocsSearchResult[] = [];
    for (const result of results) {
        if (result.hits && result.hits.length > 0) {
            for (const hit of result.hits) {
                // Check the fields, just in case
                if (!hit.url_without_anchor || !hit.content) {
                    continue; // Skip hits with missing fields
                }
                searchResults.push({
                    url: hit.url_without_anchor,
                    fragment: hit.anchor
                        ? hit.anchor
                        : undefined,
                    content: hit.content,
                });
            }
        }
    }

    return searchResults;
}

/**
 * Searches the Apify documentation using Algolia and caches the results.
 *
 * If the query has been previously searched, it returns cached results.
 * Otherwise, it performs a new search and caches the results for future use.
 *
 * Note: The query is normalized to lowercase for case-insensitive caching.
 *
 * @param {string} query - The search query string.
 * @returns {Promise<ApifyDocsSearchResult[]>} Array of search results with URL, optional fragment, and content.
 */
export async function searchApifyDocsCached(query: string): Promise<ApifyDocsSearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const cachedResults = searchApifyDocsCache.get(normalizedQuery);
    if (cachedResults) {
        return cachedResults;
    }

    const results = await searchApifyDocs(normalizedQuery);
    searchApifyDocsCache.set(normalizedQuery, results);
    return results;
}
