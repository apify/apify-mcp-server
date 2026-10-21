import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { SERVER_MODE } from '../../src/types.js';

function makeServer(serverMode: SERVER_MODE = SERVER_MODE.DEFAULT): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode,
        telemetry: { enabled: false },
    });
}

describe('ActorsMcpServer.getStatelessServerInstructions()', () => {
    it('describes available tools without report-problem when no request URL is supplied', () => {
        const instructions = makeServer().getStatelessServerInstructions();
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    it('uses the default tools for a bare URL', () => {
        const instructions = makeServer().getStatelessServerInstructions('http://localhost/');
        expect(instructions).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    it('describes a dedicated-Actor session without naming individual web tools', () => {
        const instructions = makeServer().getStatelessServerInstructions(
            'http://localhost/?tools=search-actors,apify/rag-web-browser,apify/web-fetch',
        );
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(instructions).toContain('This session can run only Actors exposed as dedicated tools');
        expect(instructions).not.toContain(WEB_FETCH);
        expect(instructions).not.toContain(RAG_WEB_BROWSER);
    });

    it('names no widget for get-actor-run when an Actor tool auto-injects it — its widget was never selected', () => {
        const instructions = makeServer(SERVER_MODE.APPS).getStatelessServerInstructions(
            'http://localhost/?ui=apps&tools=apify/rag-web-browser',
        );
        expect(instructions).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    });

    // ?tools=dev seeds report-problem into the candidate set so this exercises the filter, not an always-true check.
    it('never mentions report-problem via a requestUrl, even when explicitly selected', () => {
        const instructions = makeServer().getStatelessServerInstructions('http://localhost/?tools=dev');
        expect(instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});
