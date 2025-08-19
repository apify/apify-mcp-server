import { defaults } from '../src/const.js';
import { toolCategoriesEnabledByDefault } from '../src/tools/index.js';
import { actorNameToToolName } from '../src/tools/utils.js';
import { getExpectedToolNamesByCategories } from '../src/utils/tools.js';

export const ACTOR_PYTHON_EXAMPLE = 'apify/python-example';
export const ACTOR_MCP_SERVER_ACTOR_NAME = 'apify/actors-mcp-server';
export const DEFAULT_TOOL_NAMES = getExpectedToolNamesByCategories(toolCategoriesEnabledByDefault);
export const DEFAULT_ACTOR_NAMES = defaults.actors.map((tool) => actorNameToToolName(tool));
