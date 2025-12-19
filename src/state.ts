import {
    ACTOR_CACHE_MAX_SIZE,
    ACTOR_CACHE_TTL_SECS,
    APIFY_DOCS_CACHE_MAX_SIZE,
    APIFY_DOCS_CACHE_TTL_SECS,
    GET_HTML_SKELETON_CACHE_MAX_SIZE,
    GET_HTML_SKELETON_CACHE_TTL_SECS,
    MCP_SERVER_CACHE_MAX_SIZE,
    MCP_SERVER_CACHE_TTL_SECS,
} from './const.js';
import type { ActorDefinitionWithInfo, ApifyDocsSearchResult } from './types.js';
import { TTLLRUCache } from './utils/ttl-lru.js';

export const actorDefinitionPrunedCache = new TTLLRUCache<ActorDefinitionWithInfo>(ACTOR_CACHE_MAX_SIZE, ACTOR_CACHE_TTL_SECS);
export const searchApifyDocsCache = new TTLLRUCache<ApifyDocsSearchResult[]>(APIFY_DOCS_CACHE_MAX_SIZE, APIFY_DOCS_CACHE_TTL_SECS);
/** Stores processed Markdown content */
export const fetchApifyDocsCache = new TTLLRUCache<string>(APIFY_DOCS_CACHE_MAX_SIZE, APIFY_DOCS_CACHE_TTL_SECS);
/** Stores HTML content per URL so we can paginate the tool output */
export const getHtmlSkeletonCache = new TTLLRUCache<string>(GET_HTML_SKELETON_CACHE_MAX_SIZE, GET_HTML_SKELETON_CACHE_TTL_SECS);
/**
 * Stores MCP server resolution per actor:
 * - false: not an MCP server
 * - string: MCP server URL
 */
export const mcpServerCache = new TTLLRUCache<boolean | string>(MCP_SERVER_CACHE_MAX_SIZE, MCP_SERVER_CACHE_TTL_SECS);
