import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { appsCallActorWidget } from '../../src/tools/apps/call_actor_widget.js';
import type { HelperTool, InternalToolArgs, ToolEntry } from '../../src/types.js';
import { getActorMcpUrlCached } from '../../src/utils/actor.js';

/**
 * Apps / UI mode: call-actor-widget starts the run and renders an interactive UI element
 * (widget) that tracks progress. Carries widget `_meta` on both the tool definition and
 * the response.
 */
vi.mock('../../src/utils/actor.js', () => ({
    getActorMcpUrlCached: vi.fn(),
}));

vi.mock('../../src/tools/core/actor_tools_factory.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>(
        '../../src/tools/core/actor_tools_factory.js',
    );
    return {
        ...actual,
        getActorsAsTools: vi.fn(),
    };
});

const { getActorsAsTools } = await import('../../src/tools/core/actor_tools_factory.js');

const MOCK_ACTOR_TOOL: ToolEntry = {
    type: 'actor',
    name: 'apify--rag-web-browser',
    actorId: 'actor-id-rag',
    actorFullName: 'apify/rag-web-browser',
    description: 'RAG web browser',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true } as never,
    ajvValidate: (() => true) as never,
} as unknown as ToolEntry;

const MOCK_RUN = {
    id: 'run-widget-1',
    status: 'RUNNING',
    startedAt: new Date('2026-04-20T12:00:00.000Z'),
};

function stubApifyClient(startSpy: (input: unknown, opts: unknown) => Promise<typeof MOCK_RUN>) {
    return {
        actor: (_name: string) => ({
            start: startSpy,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubArgs(args: Record<string, unknown>, apifyClient: InternalToolArgs['apifyClient']): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient,
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('call-actor-widget response', () => {
    beforeEach(() => {
        vi.mocked(getActorMcpUrlCached).mockReset();
        vi.mocked(getActorMcpUrlCached).mockResolvedValue(false);
        vi.mocked(getActorsAsTools).mockReset();
        vi.mocked(getActorsAsTools).mockResolvedValue([MOCK_ACTOR_TOOL] as never);
    });

    it('starts the run and returns runId + widget _meta on the response', async () => {
        const startSpy = vi.fn().mockResolvedValue(MOCK_RUN);
        const apifyClient = stubApifyClient(startSpy);

        const result = await (appsCallActorWidget as HelperTool).call(stubArgs(
            { actor: 'apify/rag-web-browser', input: { query: 'test' } },
            apifyClient,
        ));

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                runId: string;
                actorName: string;
                status: string;
                startedAt: string;
                input: Record<string, unknown>;
            };
            content: { type: string; text: string }[];
            _meta?: { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown }; 'openai/widgetDescription'?: string };
        };

        expect(startSpy).toHaveBeenCalledWith({ query: 'test' }, undefined);

        expect(structuredContent).toEqual({
            runId: 'run-widget-1',
            actorName: 'apify/rag-web-browser',
            status: 'RUNNING',
            startedAt: '2026-04-20T12:00:00.000Z',
            input: { query: 'test' },
        });

        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('A live progress widget has been rendered');
        expect(content[0].text).toContain('Run ID: run-widget-1');

        expect(_meta?.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(_meta?.ui?.visibility).toEqual(['model', 'app']);
        expect(_meta?.ui?.csp).toBeDefined();
        expect(_meta?.['openai/widgetDescription']).toContain('apify/rag-web-browser');
    });

    it('carries widget _meta on the tool definition', () => {
        const tool = appsCallActorWidget as HelperTool;
        const meta = tool._meta as { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown } };
        expect(meta.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(meta.ui?.visibility).toEqual(['model', 'app']);
        expect(meta.ui?.csp).toBeDefined();
    });

    it('declares a strict input schema that silently strips stray keys like async/previewOutput', () => {
        const tool = appsCallActorWidget as HelperTool;

        const schema = tool.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] };
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['actor', 'callOptions', 'input']);
        expect(schema.required?.sort()).toEqual(['actor', 'input']);

        // Runtime: AJV is configured with `removeAdditional: true`, so stray root keys are
        // silently stripped — callers can't smuggle async/previewOutput into the widget tool.
        const input: Record<string, unknown> = {
            actor: 'apify/rag-web-browser',
            input: { query: 'test' },
            async: true,
            previewOutput: true,
        };
        const ok = tool.ajvValidate(input);
        expect(ok).toBe(true);
        expect('async' in input).toBe(false);
        expect('previewOutput' in input).toBe(false);
    });

    it('accepts a minimal actor+input payload', () => {
        const tool = appsCallActorWidget as HelperTool;
        const ok = tool.ajvValidate({ actor: 'apify/rag-web-browser', input: { query: 'test' } });
        expect(ok).toBe(true);
    });

    it('rejects MCP "actor:toolName" syntax and points at call-actor', async () => {
        const startSpy = vi.fn();
        const apifyClient = stubApifyClient(startSpy);

        const result = await (appsCallActorWidget as HelperTool).call(stubArgs(
            { actor: 'apify/actors-mcp-server:fetch-apify-docs', input: { query: 'test' } },
            apifyClient,
        ));

        const { content, isError } = result as { content: { type: string; text: string }[]; isError?: boolean };
        expect(isError).toBe(true);
        expect(startSpy).not.toHaveBeenCalled();
        const joined = content.map((c) => c.text).join(' ');
        expect(joined).toContain('call-actor-widget');
        expect(joined).toContain('call-actor');
        expect(joined).toContain('actorName:toolName');
    });
});
