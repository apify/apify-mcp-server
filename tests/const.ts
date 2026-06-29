import { defaults } from '../src/const.js';
import { actorNameToToolName } from '../src/tools/actor_tool_naming.js';
import { toolCategoriesEnabledByDefault } from '../src/tools/index.js';
import { getExpectedToolNamesByCategories } from '../src/utils/tool_categories_helpers.js';

export const ACTOR_NORMAL_MODE = 'apify/normal-mode-test-actor';
export const ACTOR_EXAMPLE_MCP_SERVER = 'apify/example-mcp-server';
// Function to avoid circular dependency during module initialization
export const getDefaultToolNames = () => getExpectedToolNamesByCategories(toolCategoriesEnabledByDefault);
export const DEFAULT_ACTOR_NAMES = defaults.actors.map((tool) => actorNameToToolName(tool));
