import { defaults } from '../src/const.js';
import { toolCategoriesEnabledByDefault } from '../src/tools/index.js';
import { actorNameToToolName } from '../src/tools/utils.js';
import { getExpectedToolNamesByCategories } from '../src/utils/tool-categories-helpers.js';

export const ACTOR_PYTHON_EXAMPLE = 'apify/python-example';
export const ACTOR_MCP_SERVER_ACTOR_NAME = 'apify/actors-mcp-server';
// Function to avoid circular dependency during module initialization
export const getDefaultToolNames = () => getExpectedToolNamesByCategories(toolCategoriesEnabledByDefault);
export const DEFAULT_ACTOR_NAMES = defaults.actors.map((tool) => actorNameToToolName(tool));
