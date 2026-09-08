import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { parseInputParamsFromUrl } from '../../src/mcp/utils.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import type { ToolDescriptionContext } from '../../src/types.js';
import { ALL_TOOLS_PRESENT, SERVER_MODE } from '../../src/types.js';
import { getServerInstructions } from '../../src/utils/server-instructions/index.js';
import { getToolsForServerMode } from '../../src/utils/tools_loader.js';
import { CLAUDE_CONNECTOR_TOOLS } from '../test_kit/cases/registration.cases.js';

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

    it('omits the apps-mode data-vs-widget section when neither search-actors nor fetch-actor-details is loaded', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.DOCS_SEARCH));
        expect(instructions).not.toContain('Data vs widget Actor tools');
    });

    it('omits the data-vs-widget section for get-actor-run alone — its widget is not auto-paired', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.ACTOR_RUNS_GET));
        expect(instructions).not.toContain('Data vs widget Actor tools');
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });

    it('renders only the data-vs-widget bullets for tools actually loaded, in apps mode', () => {
        const instructions = getServerInstructions(
            SERVER_MODE.APPS,
            only(HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.STORE_SEARCH_WIDGET),
        );
        expect(instructions).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
    });

    // Regression: the bullet must require BOTH tools, not just the base one — pairing could stop
    // being unconditional for these two as well (as it already has for call-actor/get-actor-run).
    it('omits the data-vs-widget bullet when the base tool is loaded but its widget is not', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.STORE_SEARCH));
        expect(instructions).not.toContain('Data vs widget Actor tools');
        expect(instructions).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
    });

    // Widget-only selection is possible (pairing is one-way, base -> widget) — naming the absent
    // base tool would be just as wrong as naming the absent widget.
    it('omits the data-vs-widget bullet when the widget is loaded but its base tool is not', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.STORE_SEARCH_WIDGET));
        expect(instructions).not.toContain('Data vs widget Actor tools');
        expect(instructions).not.toContain(HELPER_TOOLS.STORE_SEARCH);
    });

    it('omits the search-actors-vs-rag-web-browser comparison when search-actors is absent', () => {
        const instructions = getServerInstructions(SERVER_MODE.DEFAULT, only(actorNameToToolName(RAG_WEB_BROWSER)));
        expect(instructions).not.toContain(HELPER_TOOLS.STORE_SEARCH);
    });

    // Apps mode with everything loaded: every hosted apps session, and the one combination other cases don't cover.
    it('keeps every call-actor mention in apps mode when the session has call-actor, and includes both widgets when they are also loaded', () => {
        const instructions = getServerInstructions(SERVER_MODE.APPS, ALL_TOOLS_PRESENT);
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
        expect(instructions).toContain('### Tool dependencies');
        expect(instructions).toContain('Prefer dedicated tools when available');
    });

    describe('call-actor-widget / get-actor-run-widget (not auto-paired — explicit ?tools= only)', () => {
        it('call-actor-widget alone: no bare "Widget workflow" heading (nothing to warn against), but the data-vs-widget bullet renders standalone', () => {
            const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.ACTOR_CALL_WIDGET));
            expect(instructions).not.toContain('Widget workflow');
            expect(instructions).toContain(
                '- `call-actor-widget` renders an interactive UI element (widget) that starts an Actor run and tracks its live progress',
            );
            expect(instructions).not.toContain('`call-actor` runs the Actor'); // absent tool, never named
        });

        it('get-actor-run-widget alone: self-referential duplicate-poll warning renders, names no absent tool', () => {
            const instructions = getServerInstructions(SERVER_MODE.APPS, only(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET));
            expect(instructions).toContain('## Widget workflow');
            expect(instructions).toContain(
                '**After `get-actor-run-widget`, never call `get-actor-run-widget` for the same run.**',
            );
            expect(instructions).not.toContain('`get-actor-run` is a silent data lookup'); // absent tool
            expect(instructions).toContain(
                '- `get-actor-run-widget` renders an interactive UI element (widget) showing live run progress',
            );
        });

        it('call-actor + call-actor-widget together: comparison bullet, and "never call" omits get-actor-run-widget (absent)', () => {
            const instructions = getServerInstructions(
                SERVER_MODE.APPS,
                only(HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.ACTOR_RUNS_GET, HELPER_TOOLS.ACTOR_CALL_WIDGET),
            );
            expect(instructions).toContain(
                '**After `call-actor-widget`, never call `get-actor-run` for the same run.**',
            );
            expect(instructions).not.toContain('get-actor-run-widget'); // not in this session
            expect(instructions).toContain('Polling `get-actor-run` after `call-actor` is fine');
            expect(instructions).toContain(
                '`call-actor` runs the Actor and returns its run status and storage IDs (no UI); `call-actor-widget` renders',
            );
        });

        it('get-actor-run + get-actor-run-widget together: comparison bullet, full duplicate-poll warning', () => {
            const instructions = getServerInstructions(
                SERVER_MODE.APPS,
                only(HELPER_TOOLS.ACTOR_RUNS_GET, HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET),
            );
            expect(instructions).toContain(
                '**After `get-actor-run-widget`, never call `get-actor-run` or `get-actor-run-widget` for the same run.**',
            );
            expect(instructions).toContain(
                '`get-actor-run` is a silent data lookup (run status, dataset IDs, stats) with no UI; `get-actor-run-widget` renders',
            );
        });

        it('both widgets, neither base tool: combined warning, correct plural grammar, both standalone bullets', () => {
            const instructions = getServerInstructions(
                SERVER_MODE.APPS,
                only(HELPER_TOOLS.ACTOR_CALL_WIDGET, HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET),
            );
            expect(instructions).toContain(
                '**After `call-actor-widget` or `get-actor-run-widget`, never call `get-actor-run-widget` for the same run.** Both widgets render live progress and poll themselves',
            );
            expect(instructions).not.toContain('`call-actor` runs the Actor');
            expect(instructions).not.toContain('`get-actor-run` is a silent data lookup');
        });

        it('default mode never mentions either widget, even with everything loaded', () => {
            const instructions = getServerInstructions(SERVER_MODE.DEFAULT, ALL_TOOLS_PRESENT);
            expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
            expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
        });
    });

    describe('"Tool dependencies and disambiguation" section', () => {
        const HEADING = '## Tool dependencies and disambiguation';

        it('omits the heading when every subsection is gated away', () => {
            // Only run/storage helpers, no widgets: nothing under the heading renders, so it must not be emitted either.
            const instructions = getServerInstructions(SERVER_MODE.DEFAULT, only(HELPER_TOOLS.ACTOR_RUNS_GET));
            expect(instructions).not.toContain(HEADING);
        });

        it('separates the two subsections with a blank line', () => {
            expect(getServerInstructions(SERVER_MODE.DEFAULT, ALL_TOOLS_PRESENT)).toContain(
                '\n\n### Tool disambiguation',
            );
        });

        it('keeps a blank line after the heading when only bullets render', () => {
            // Only subsection with no `###` heading and no search/details/call dependency, so it renders alone.
            const instructions = getServerInstructions(
                SERVER_MODE.DEFAULT,
                only(actorNameToToolName(WEB_FETCH), actorNameToToolName(RAG_WEB_BROWSER)),
            );
            expect(instructions).toContain(`${HEADING}\n\n- **${WEB_FETCH} vs ${RAG_WEB_BROWSER}:**`);
        });
    });
});

/** Pins the Claude-connector tool surface (no call-actor); offline, no network or fixture. */
describe('Claude-connector tool surface (no call-actor)', () => {
    const url = `https://mcp.apify.com/?tools=${CLAUDE_CONNECTOR_TOOLS.join(',')}`;

    // Actor-tool selectors (contain '/') need a live fetch to resolve; checks the internal-tool subset only.
    const expectedInternalToolNames = CLAUDE_CONNECTOR_TOOLS.filter((tool) => !tool.includes('/'));

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
