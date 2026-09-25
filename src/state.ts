import type { ApiOperation } from './tools/api/apify_api_spec.js';
import type { ActorDefinitionWithInfo, ApifyDocsSearchResult } from './types.js';
import { TTLLRUCache } from './utils/ttl_lru.js';

const ACTOR_CACHE_MAX_SIZE = 500;
const ACTOR_CACHE_TTL_SECS = 30 * 60; // 30 minutes
const APIFY_DOCS_CACHE_MAX_SIZE = 500;
const APIFY_DOCS_CACHE_TTL_SECS = 60 * 60; // 1 hour

export const actorDefinitionCache = new TTLLRUCache<ActorDefinitionWithInfo>(
    ACTOR_CACHE_MAX_SIZE,
    ACTOR_CACHE_TTL_SECS,
);
export const searchApifyDocsCache = new TTLLRUCache<ApifyDocsSearchResult[]>(
    APIFY_DOCS_CACHE_MAX_SIZE,
    APIFY_DOCS_CACHE_TTL_SECS,
);
/** Stores processed Markdown content */
export const fetchApifyDocsCache = new TTLLRUCache<string>(APIFY_DOCS_CACHE_MAX_SIZE, APIFY_DOCS_CACHE_TTL_SECS);
/** The Apify API operation index built from the published OpenAPI spec; one entry, keyed by the spec URL. */
export const apifyApiOperationsCache = new TTLLRUCache<Map<string, ApiOperation>>(1, APIFY_DOCS_CACHE_TTL_SECS);
