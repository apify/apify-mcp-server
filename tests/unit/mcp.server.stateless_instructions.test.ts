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

    it('pins the Claude-connector tool surface: call-actor absent, its own dedicated Actor tools present', () => {
        const url =
            'http://localhost/?tools=search-actors,search-actors-widget,fetch-actor-details,fetch-actor-details-widget,search-apify-docs,fetch-apify-docs,get-actor-run,get-actor-run-widget,get-actor-run-list,get-actor-log,abort-actor-run,get-dataset-list,get-dataset,get-dataset-items,get-key-value-store-list,get-key-value-store,get-key-value-store-record,apify/rag-web-browser,apify/web-fetch';
        const instructions = makeServer().getStatelessServerInstructions(url);
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain(RAG_WEB_BROWSER);
        expect(instructions).toContain(WEB_FETCH);
    });

    it('never mentions report-problem via a requestUrl — not derivable, identity-dependent', () => {
        const instructions = makeServer().getStatelessServerInstructions('http://localhost/?tools=search-actors');
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});
