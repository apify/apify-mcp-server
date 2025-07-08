import { ACTOR_CACHE_MAX_SIZE, ACTOR_CACHE_TTL_SECS, APIFY_DOCS_CACHE_MAX_SIZE, APIFY_DOCS_CACHE_TTL_SECS } from './const.js';
import type { ActorDefinitionPruned, ApifyDocsSearchResult } from './types.js';
import { TTLLRUCache } from './utils/ttl-lru.js';

export const actorDefinitionPrunedCache = new TTLLRUCache<ActorDefinitionPruned>(ACTOR_CACHE_MAX_SIZE, ACTOR_CACHE_TTL_SECS);
export const searchApifyDocsCache = new TTLLRUCache<ApifyDocsSearchResult[]>(APIFY_DOCS_CACHE_MAX_SIZE, APIFY_DOCS_CACHE_TTL_SECS);
/** Stores processed Markdown content */
export const fetchApifyDocsCache = new TTLLRUCache<string>(APIFY_DOCS_CACHE_MAX_SIZE, APIFY_DOCS_CACHE_TTL_SECS);
