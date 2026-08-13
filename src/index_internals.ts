/*
 This file provides essential internal functions for Apify MCP servers, serving as an internal library.
*/

import { ApifyClient } from './apify_client.js';
import {
    defaults,
    HELPER_TOOLS,
    MAX_LIMIT_WITH_INPUT_SCHEMA,
    SERVER_MODE_AUTO_DETECTION_ENABLED,
    type HelperToolName,
} from './const.js';
import { processParamsGetTools } from './mcp/utils.js';
import { SKYFIRE_ENABLED_TOOLS } from './payments/const.js';
import { resolvePaymentProvider } from './payments/index.js';
import type { PaymentProvider } from './payments/types.js';
import { RESOURCE_MIME_TYPE } from './resources/widgets.js';
import { getServerCard } from './server_card.js';
import { actorNameToToolName } from './tools/actor_tool_naming.js';
import { CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG } from './tools/actors/call_actor.js';
import {
    getCategoryTools,
    getDefaultTools,
    getUnauthEnabledToolCategories,
    toolCategoriesEnabledByDefault,
    unauthEnabledTools,
} from './tools/index.js';
import { actorRunOutputSchema } from './tools/structured_output_schemas.js';
import type { ActorStore, SERVER_MODE, TelemetryEnv, ToolCategory, ToolEntry } from './types.js';
import { parseQueryParamList } from './utils/generic.js';
import { APIFY_ACTOR_RUN_META_KEY } from './utils/mcp.js';
import { getExpectedToolNamesByCategories } from './utils/tool_categories_helpers.js';
import { getToolPublicFieldOnly } from './utils/tools.js';
import { AUTO_INJECTED_TOOLS } from './utils/tools_loader.js';
import { TTLLRUCache } from './utils/ttl_lru.js';

export {
    ApifyClient,
    getExpectedToolNamesByCategories,
    getServerCard,
    TTLLRUCache,
    actorNameToToolName,
    defaults,
    getDefaultTools,
    getCategoryTools,
    type ActorStore,
    type ToolCategory,
    processParamsGetTools,
    getToolPublicFieldOnly,
    getUnauthEnabledToolCategories,
    unauthEnabledTools,
    parseQueryParamList,
    resolvePaymentProvider,
    type PaymentProvider,
    HELPER_TOOLS,
    MAX_LIMIT_WITH_INPUT_SCHEMA,
    SERVER_MODE_AUTO_DETECTION_ENABLED,
    SKYFIRE_ENABLED_TOOLS,
    RESOURCE_MIME_TYPE,
    CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG,
    toolCategoriesEnabledByDefault,
    actorRunOutputSchema,
    type SERVER_MODE,
    type TelemetryEnv,
    type ToolEntry,
    APIFY_ACTOR_RUN_META_KEY,
    AUTO_INJECTED_TOOLS,
};

/** @deprecated Use HELPER_TOOLS / HelperToolName. Kept for backward compatibility with apify-mcp-server-internal. */
export const HelperTools = HELPER_TOOLS;
/** @deprecated Use HelperToolName. */
export type HelperTools = HelperToolName;
