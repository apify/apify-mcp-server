import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { searchActors } from '../../src/tools/actors/search_actors.js';
import { SERVER_MODE } from '../../src/types.js';

function makeServer(serverMode: SERVER_MODE = SERVER_MODE.DEFAULT, clientParam?: string): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode,
        telemetry: { enabled: false },
        clientParam,
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

    // Regression: resolving only call-actor left rag-web-browser/web-fetch absent even when selected;
    // resolveActorsToLoad (zero-fetch) fixes it. Selects both since their comparison needs both sides.
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

    it('names no widget for get-actor-run when an Actor tool auto-injects it — its widget was never selected', () => {
        const instructions = makeServer(SERVER_MODE.APPS).getStatelessServerInstructions(
            'http://localhost/?ui=apps&tools=apify/rag-web-browser',
        );
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });

    it('names the Claude custom connector in the run limitation when clientParam is claude', () => {
        const instructions = makeServer(SERVER_MODE.DEFAULT, 'claude').getStatelessServerInstructions(
            'http://localhost/?tools=search-actors',
        );
        expect(instructions).toContain('add it to Claude as a custom connector.');
    });

    // ?tools=dev seeds report-problem into the candidate set so this exercises the filter, not an always-true check.
    it('never mentions report-problem via a requestUrl, even when explicitly selected', () => {
        const instructions = makeServer().getStatelessServerInstructions('http://localhost/?tools=dev');
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});

describe('ActorsMcpServer.getServerInstructions()', () => {
    it('names the Claude custom connector in the run limitation when clientParam is claude', () => {
        const server = makeServer(SERVER_MODE.DEFAULT, 'claude');
        server.upsertTools([searchActors]);
        expect(server.getServerInstructions()).toContain('add it to Claude as a custom connector.');
    });
});
