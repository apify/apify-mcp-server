/*
 This file provides essential internal functions for Apify MCP servers, serving as an internal library.
*/

import { ApifyClient } from './apify_client.js';
import { APIFY_FAVICON_URL, defaults, HELPER_TOOLS, type HelperToolName, SERVER_NAME, SERVER_TITLE } from './const.js';
import { processParamsGetTools } from './mcp/utils.js';
import { resolvePaymentProvider } from './payments/index.js';
import type { PaymentProvider } from './payments/types.js';
import { getServerCard } from './server_card.js';
import { actorNameToToolName } from './tools/actor_tool_naming.js';
import { addActor } from './tools/actors/add_actor.js';
import {
    getActorsAsTools,
    getCategoryTools,
    getDefaultTools,
    getUnauthEnabledToolCategories,
    toolCategoriesEnabledByDefault,
    unauthEnabledTools,
} from './tools/index.js';
import type { ActorStore, ServerCard, ToolCategory } from './types.js';
import { parseCommaSeparatedList, parseQueryParamList, readJsonFile } from './utils/generic.js';
import { redactSkyfirePayId } from './utils/logging.js';
import { getExpectedToolNamesByCategories } from './utils/tool_categories_helpers.js';
import { getToolPublicFieldOnly } from './utils/tools.js';
import { TTLLRUCache } from './utils/ttl_lru.js';

export {
    APIFY_FAVICON_URL,
    ApifyClient,
    getExpectedToolNamesByCategories,
    getServerCard,
    TTLLRUCache,
    actorNameToToolName,
    HELPER_TOOLS,
    type HelperToolName,
    SERVER_NAME,
    SERVER_TITLE,
    defaults,
    getDefaultTools,
    addActor,
    /**
     * @deprecated Use `addActor` instead. Kept for the apify-mcp-server-internal migration; remove once it no longer imports `addTool`.
     */
    addActor as addTool,
    getCategoryTools,
    toolCategoriesEnabledByDefault,
    type ActorStore,
    type ServerCard,
    type ToolCategory,
    processParamsGetTools,
    getActorsAsTools,
    getToolPublicFieldOnly,
    getUnauthEnabledToolCategories,
    unauthEnabledTools,
    readJsonFile,
    parseCommaSeparatedList,
    parseQueryParamList,
    resolvePaymentProvider,
    type PaymentProvider,
    /**
     * @deprecated Use the server's paymentProvider.redactForLogging instead. This will be removed in a future release.
     */
    redactSkyfirePayId,
};

/** @deprecated Use HELPER_TOOLS / HelperToolName. Kept for backward compatibility with apify-mcp-server-internal. */
export const HelperTools = HELPER_TOOLS;
/** @deprecated Use HelperToolName. */
export type HelperTools = HelperToolName;
