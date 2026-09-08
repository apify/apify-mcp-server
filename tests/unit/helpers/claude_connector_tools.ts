import { HELPER_TOOLS } from '../../../src/const.js';

// Claude-connector `?tools=` allowlist (ai-team#214/#229). No call-actor. Actor entries use their
// slash name here; served tool names differ from selector to selector for those two.
// Shared by tests/unit (buildless, src-only imports) and tests/test_kit (built-package imports) —
// keep this file's own imports src-only so unit tests never pull in the built package.
export const CLAUDE_CONNECTOR_TOOLS = [
    HELPER_TOOLS.STORE_SEARCH,
    HELPER_TOOLS.STORE_SEARCH_WIDGET,
    HELPER_TOOLS.ACTOR_GET_DETAILS,
    HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET,
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
    'apify/rag-web-browser',
    'apify/web-fetch',
    HELPER_TOOLS.PROBLEM_REPORT,
];
