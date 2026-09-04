import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { parseInputParamsFromUrl } from '../../src/mcp/utils.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import type { ToolDescriptionContext } from '../../src/types.js';
import { ALL_TOOLS_PRESENT, SERVER_MODE } from '../../src/types.js';
import { getServerInstructions } from '../../src/utils/server-instructions/index.js';
import { getToolsForServerMode } from '../../src/utils/tools_loader.js';

/** Context reporting every named tool present, everything else absent. */
function only(...present: string[]): ToolDescriptionContext {
    const set = new Set(present);
    return { hasTool: (name) => set.has(name) };
}

describe('getServerInstructions()', () => {
    it('defaults to ALL_TOOLS_PRESENT — no regression for the common case (every tool loaded)', () => {
        expect(getServerInstructions(SERVER_MODE.DEFAULT)).toBe(
            getServerInstructions(SERVER_MODE.DEFAULT, ALL_TOOLS_PRESENT),
        );
    });

    it('mentions report-problem with a gentle, non-mandatory nudge when feedback is available', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, ALL_TOOLS_PRESENT);
        expect(instructions).toContain(HELPER_TOOLS.PROBLEM_REPORT);
        expect(instructions).toContain('you can report it');
        // No hard directive — the directory review rejects MUST-style solicitation.
        expect(instructions).not.toContain('MUST');
        expect(instructions).not.toContain('Reporting problems and feedback');
    });

    it('describes a capped wait as returning the current run status', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, ALL_TOOLS_PRESENT);
        expect(instructions).toContain('returns its current status and storage IDs');
        expect(instructions).not.toContain('returns its final status and storage IDs');
    });

    it('mentions call-actor, apify/rag-web-browser and apify/web-fetch when all are loaded', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, ALL_TOOLS_PRESENT);
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain(RAG_WEB_BROWSER);
        expect(instructions).toContain(WEB_FETCH);
    });

    it('omits every call-actor mention when call-actor is absent from the session', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, only(HELPER_TOOLS.STORE_SEARCH));
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain(HELPER_TOOLS.STORE_SEARCH); // no dead end
    });

    it('omits the apps-mode widget-disambiguation call-actor line when call-actor is absent', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.STORE_SEARCH));
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_CALL);
    });

    it('omits report-problem when it is absent from the session', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, only(HELPER_TOOLS.ACTOR_CALL));
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL); // no dead end
    });

    it('omits apify/rag-web-browser and apify/web-fetch mentions when both are absent', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, only(HELPER_TOOLS.ACTOR_CALL));
        expect(instructions).not.toContain(RAG_WEB_BROWSER);
        expect(instructions).not.toContain(WEB_FETCH);
        expect(instructions).toContain('Prefer dedicated tools when available'); // no dead end
    });

    // Regression: hasTool must match the registered tool name, not the Actor full name used for display text.
    it('keeps the rag-web-browser/web-fetch comparisons when their real tool names are present', () => {
        const instructions = getServerInstructions(
            SERVER_MODE.DEFAULT,
            only(HELPER_TOOLS.ACTOR_CALL, actorNameToToolName(RAG_WEB_BROWSER), actorNameToToolName(WEB_FETCH)),
        );
        expect(instructions).toContain(RAG_WEB_BROWSER);
        expect(instructions).toContain(WEB_FETCH);
    });

    it('omits the search-vs-details disambiguation when only one side is loaded, but still names it', () => {
        const searchOnly = getServerInstructions(SERVER_MODE.DEFAULT, only(HELPER_TOOLS.STORE_SEARCH));
        expect(searchOnly).toContain(HELPER_TOOLS.STORE_SEARCH);
        expect(searchOnly).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);

        const detailsOnly = getServerInstructions(SERVER_MODE.DEFAULT, only(HELPER_TOOLS.ACTOR_GET_DETAILS));
        expect(detailsOnly).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(detailsOnly).not.toContain(HELPER_TOOLS.STORE_SEARCH);
    });

    it('omits the search-vs-details disambiguation entirely when neither is loaded', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, only(HELPER_TOOLS.ACTOR_CALL));
        expect(instructions).not.toContain(HELPER_TOOLS.STORE_SEARCH);
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });

    it('omits both apps-mode Actor-run sections when get-actor-run is absent', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.DOCS_SEARCH));
        expect(instructions).not.toContain('Widget workflow');
        expect(instructions).not.toContain('Data vs widget Actor tools');
    });

    it('renders the apps-mode widget-workflow block when get-actor-run is loaded', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.ACTOR_RUNS_GET));
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });

    it('renders only the data-vs-widget bullets for tools actually loaded, in apps mode', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.STORE_SEARCH));
        expect(instructions).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });

    it('omits the search-actors-vs-rag-web-browser comparison when search-actors is absent', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, only(actorNameToToolName(RAG_WEB_BROWSER)));
        expect(instructions).not.toContain(HELPER_TOOLS.STORE_SEARCH);
    });
});

/** Pins the Claude-connector tool surface (no call-actor). Offline — no network, no fixture. */
describe('Claude-connector tool surface (no call-actor)', () => {
    const url =
        'https://mcp.apify.com/?tools=search-actors,search-actors-widget,fetch-actor-details,fetch-actor-details-widget,search-apify-docs,fetch-apify-docs,get-actor-run,get-actor-run-widget,get-actor-run-list,get-actor-log,abort-actor-run,get-dataset-list,get-dataset,get-dataset-items,get-key-value-store-list,get-key-value-store,get-key-value-store-record,apify/rag-web-browser,apify/web-fetch';

    // Actor-tool selectors need a live fetch to resolve; checks the internal-tool subset only.
    const expectedInternalToolNames = [
        HELPER_TOOLS.STORE_SEARCH,
        HELPER_TOOLS.STORE_SEARCH_WIDGET,
        HELPER_TOOLS.ACTOR_GET_DETAILS,
        HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET,
        HELPER_TOOLS.DOCS_SEARCH,
        HELPER_TOOLS.DOCS_FETCH,
        HELPER_TOOLS.ACTOR_RUNS_GET,
        HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET,
        HELPER_TOOLS.ACTOR_RUN_LIST_GET,
        HELPER_TOOLS.ACTOR_RUNS_LOG,
        HELPER_TOOLS.ACTOR_RUNS_ABORT,
        HELPER_TOOLS.DATASET_LIST_GET,
        HELPER_TOOLS.DATASET_GET,
        HELPER_TOOLS.DATASET_GET_ITEMS,
        HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
        HELPER_TOOLS.KEY_VALUE_STORE_GET,
        HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
    ];

    it('resolves to exactly the expected internal tools, no call-actor, and instructions mention it nowhere', () => {
        const resolved = new Set(
            getToolsForServerMode(parseInputParamsFromUrl(url), [], SERVER_MODE.APPS).map((tool) => tool.name),
        );
        expect(resolved).toEqual(new Set(expectedInternalToolNames));
        expect(resolved.has(HELPER_TOOLS.ACTOR_CALL)).toBe(false);

        const instructions = getServerInstructions(SERVER_MODE.APPS, { hasTool: (name) => resolved.has(name) });
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_CALL);
    });
});
