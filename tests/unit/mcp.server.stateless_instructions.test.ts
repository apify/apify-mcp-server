import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { SERVER_MODE } from '../../src/types.js';

function makeServer(): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode: SERVER_MODE.DEFAULT,
        telemetry: { enabled: false },
    });
}

describe('ActorsMcpServer.getStatelessServerInstructions()', () => {
    it('without a requestUrl, mentions everything but report-problem — matches the pre-gating default', () => {
        const instructions = makeServer().getStatelessServerInstructions();
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain(RAG_WEB_BROWSER);
        expect(instructions).toContain(WEB_FETCH);
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    it('with a bare URL (no ?tools=/?actors=), resolves the same as no requestUrl — defaults apply', () => {
        const instructions = makeServer().getStatelessServerInstructions('http://localhost/');
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain(RAG_WEB_BROWSER);
        expect(instructions).toContain(WEB_FETCH);
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    // Regression for the gap check-work caught: resolving only call-actor from the URL left
    // rag-web-browser/web-fetch always absent, even when explicitly selected. resolveActorsToLoad
    // (zero-fetch, same as getToolsForServerMode) closes it. The web-fetch-vs-rag-web-browser
    // comparison needs both sides, so select both.
    it('resolves explicitly selected Actor tools from the URL, with no fetch', () => {
        const instructions = makeServer().getStatelessServerInstructions(
            'http://localhost/?tools=search-actors,apify/rag-web-browser,apify/web-fetch',
        );
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain(WEB_FETCH);
        expect(instructions).toContain(RAG_WEB_BROWSER);
    });

    it('omits an Actor tool the URL did not select', () => {
        const instructions = makeServer().getStatelessServerInstructions(
            'http://localhost/?tools=search-actors,apify/web-fetch',
        );
        expect(instructions).not.toContain(RAG_WEB_BROWSER);
    });

    // report-problem is identity-dependent, never derivable from the URL alone; ?tools=dev puts
    // it in the candidate set so this actually exercises the filter, not an always-true check.
    it('never mentions report-problem via a requestUrl, even when explicitly selected', () => {
        const instructions = makeServer().getStatelessServerInstructions('http://localhost/?tools=dev');
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});
