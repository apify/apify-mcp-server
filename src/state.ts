import { ACTOR_CACHE_MAX_SIZE, ACTOR_CACHE_TTL_SECS } from './const.js';
import type { ActorDefinitionPruned } from './types.js';
import { TTLLRUCache } from './utils/ttl-lru.js';

export const actorDefinitionPrunedCache = new TTLLRUCache<ActorDefinitionPruned>(ACTOR_CACHE_MAX_SIZE, ACTOR_CACHE_TTL_SECS);
