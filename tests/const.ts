import { defaults } from '../src/const.js';
import { toolCategoriesEnabledByDefault } from '../src/tools/index.js';
import { actorNameToToolName } from '../src/tools/utils.js';
import { getExpectedToolNamesByCategories } from '../src/utils/tool_categories_helpers.js';

// TEMP — points at jiri.spilka's deployed copy so #880 storage-tool integration tests
// (math.factorial.first, RESULT/STATS/LOG/COVER) can run before apify/normal-mode-test-actor
// is rebuilt with apify/mcp-server-test-actor#6. Revert to 'apify/normal-mode-test-actor'
// before merging.
export const ACTOR_NORMAL_MODE = 'jiri.spilka/normal-test-actor';
export const ACTOR_EXAMPLE_MCP_SERVER = 'apify/example-mcp-server';
// Function to avoid circular dependency during module initialization
export const getDefaultToolNames = () => getExpectedToolNamesByCategories(toolCategoriesEnabledByDefault);
export const DEFAULT_ACTOR_NAMES = defaults.actors.map((tool) => actorNameToToolName(tool));
