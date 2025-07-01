import { defaults } from '../src/const.js';
import { defaultTools } from '../src/tools/index.js';
import { actorNameToToolName } from '../src/tools/utils.js';

export const ACTOR_PYTHON_EXAMPLE = 'apify/python-example';
export const DEFAULT_TOOL_NAMES = defaultTools.map((tool) => tool.tool.name);
export const DEFAULT_ACTOR_NAMES = defaults.actors.map((tool) => actorNameToToolName(tool));
