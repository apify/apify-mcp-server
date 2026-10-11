import { HELPER_TOOLS } from '../../../src/const.js';

// Apify AI `?tools=` selection: `MCP_TOOLS` in apify/apify-ai-agent src/mastra/token-toolsets.ts. It names
// categories, so a tool added to one of them would reach Apify AI untested; APIFY_AI_INTERNAL_TOOL_NAMES
// pins what it serves. Duplicated in tests/test_kit/cases/registration.cases.ts — test_kit is its own
// `tsc -b` project and cannot import from here.
export const APIFY_AI_TOOLS = [
    'actors',
    'docs',
    'runs',
    'storage',
    'tasks',
    'schedules',
    'apify/rag-web-browser',
    'apify/web-fetch',
    HELPER_TOOLS.PROBLEM_REPORT,
];

// The internal tools APIFY_AI_TOOLS serves. The two Actor selectors add one tool each on top.
export const APIFY_AI_INTERNAL_TOOL_NAMES = [
    HELPER_TOOLS.STORE_SEARCH,
    HELPER_TOOLS.ACTOR_GET_DETAILS,
    HELPER_TOOLS.ACTOR_CALL,
    HELPER_TOOLS.DOCS_SEARCH,
    HELPER_TOOLS.DOCS_FETCH,
    HELPER_TOOLS.ACTOR_RUNS_GET,
    HELPER_TOOLS.ACTOR_RUN_LIST_GET,
    HELPER_TOOLS.ACTOR_RUNS_LOG,
    HELPER_TOOLS.ACTOR_RUNS_ABORT,
    HELPER_TOOLS.DATASET_GET,
    HELPER_TOOLS.DATASET_GET_ITEMS,
    HELPER_TOOLS.DATASET_SCHEMA_GET,
    HELPER_TOOLS.DATASET_LIST_GET,
    HELPER_TOOLS.KEY_VALUE_STORE_GET,
    HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET,
    HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
    HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
    HELPER_TOOLS.ACTOR_TASK_CREATE,
    HELPER_TOOLS.ACTOR_TASK_GET,
    HELPER_TOOLS.ACTOR_TASK_UPDATE,
    HELPER_TOOLS.ACTOR_TASK_PUBLISH,
    HELPER_TOOLS.ACTOR_TASK_UNPUBLISH,
    HELPER_TOOLS.SCHEDULE_CREATE,
    HELPER_TOOLS.SCHEDULE_GET,
    HELPER_TOOLS.SCHEDULE_UPDATE,
    HELPER_TOOLS.SCHEDULE_DELETE,
    HELPER_TOOLS.PROBLEM_REPORT,
];
