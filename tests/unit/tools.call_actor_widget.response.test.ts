import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { callActorWidget } from '../../src/tools/widgets/call_actor_widget.js';
import type { HelperTool, InternalToolArgs, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { getActorMcpUrlCached } from '../../src/utils/actor.js';
import { stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

/**
 * Apps / UI mode: call-actor-widget starts the run and renders an interactive UI element
 * (widget) that tracks progress. Carries widget `_meta` on both the tool definition and
 * the response.
 */
vi.mock('../../src/utils/actor.js', () => ({
    getActorMcpUrlCached: vi.fn(),
}));

vi.mock('../../src/tools/actors/actor_tools_factory.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/tools/actors/actor_tools_factory.js');
    return {
        ...actual,
        getActorsAsTools: vi.fn(),
    };
});

const { getActorsAsTools } = await import('../../src/tools/actors/actor_tools_factory.js');

const MOCK_ACTOR_TOOL: ToolEntry = {
    type: TOOL_TYPE.ACTOR,
    name: 'apify--rag-web-browser',
    actorId: 'actor-id-rag',
    actorFullName: 'apify/rag-web-browser',
    description: 'RAG web browser',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true } as never,
    ajvValidate: (() => true) as never,
} as unknown as ToolEntry;

const MOCK_RUN = {
    id: 'run-widget-1',
    actId: 'actor-id-rag',
    status: 'RUNNING',
    startedAt: new Date('2026-04-20T12:00:00.000Z'),
    defaultDatasetId: 'dataset-id-1',
    defaultKeyValueStoreId: 'kv-id-1',
};

function stubApifyClient(startSpy: (input: unknown, opts: unknown) => Promise<typeof MOCK_RUN>) {
    return {
        actor: (_name: string) => ({
            start: startSpy,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('call-actor-widget response', () => {
    beforeEach(() => {
        vi.mocked(getActorMcpUrlCached).mockReset();
        vi.mocked(getActorMcpUrlCached).mockResolvedValue(false);
        vi.mocked(getActorsAsTools).mockReset();
        vi.mocked(getActorsAsTools).mockResolvedValue({ tools: [MOCK_ACTOR_TOOL], errors: [] });
    });

    it('starts the run and returns runId + widget _meta on the response', async () => {
        const startSpy = vi.fn().mockResolvedValue(MOCK_RUN);
        const apifyClient = stubApifyClient(startSpy);

        const result = await (callActorWidget as HelperTool).call(
            stubToolCallContext({ actor: 'apify/rag-web-browser', input: { query: 'test' } }, apifyClient),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                runId: string;
                actorId: string;
                actorName: string;
                status: string;
                startedAt: string;
                storages: { datasets?: { default: { id: string } }; keyValueStores?: { default: { id: string } } };
                summary: string;
                nextStep: string;
            };
            content: { type: string; text: string }[];
            _meta?: {
                ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown };
                'openai/widgetDescription'?: string;
            };
        };

        expect(startSpy).toHaveBeenCalledWith({ query: 'test' }, undefined);

        expect(structuredContent.runId).toBe('run-widget-1');
        expect(structuredContent.actorId).toBe('actor-id-rag');
        expect(structuredContent.actorName).toBe('apify/rag-web-browser');
        expect(structuredContent.status).toBe('RUNNING');
        expect(structuredContent.startedAt).toBe('2026-04-20T12:00:00.000Z');
        expect(structuredContent.storages.datasets?.default.id).toBe('dataset-id-1');
        expect(structuredContent.storages.keyValueStores?.default.id).toBe('kv-id-1');
        expect(structuredContent.summary).toContain('RUNNING');
        // Widget nextStep must not instruct LLM to poll — widget self-updates.
        expect(structuredContent.nextStep).toContain('Widget is rendering live progress');
        expect(structuredContent.nextStep).not.toContain('actor-runs-get');

        // content[0] mirrors structuredContent as JSON (MCP spec backwards-compat); content[1] is
        // the LLM-readable narrative with identifiers interpolated.
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toContain('RUNNING');
        // Widget: no poll hint in the LLM-visible narrative either.
        expect(content[1].text).not.toContain('actor-runs-get');

        expect(_meta?.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(_meta?.ui?.visibility).toEqual(['model', 'app']);
        expect(_meta?.ui?.csp).toBeDefined();
        expect(_meta?.['openai/widgetDescription']).toContain('apify/rag-web-browser');
    });

    it('carries widget _meta on the tool definition', () => {
        const tool = callActorWidget as HelperTool;
        const meta = tool._meta as { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown } };
        expect(meta.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(meta.ui?.visibility).toEqual(['model', 'app']);
        expect(meta.ui?.csp).toBeDefined();
    });

    it('declares a strict input schema that silently strips stray keys like async/previewOutput', () => {
        const tool = callActorWidget as HelperTool;

        const schema = tool.inputSchema as {
            additionalProperties?: boolean;
            properties?: Record<string, unknown>;
            required?: string[];
        };
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
        const tool = callActorWidget as HelperTool;
        const ok = tool.ajvValidate({ actor: 'apify/rag-web-browser', input: { query: 'test' } });
        expect(ok).toBe(true);
    });

    it('rejects MCP "actor:toolName" syntax and points at call-actor', async () => {
        const startSpy = vi.fn();
        const apifyClient = stubApifyClient(startSpy);

        const result = await (callActorWidget as HelperTool).call(
            stubToolCallContext(
                { actor: 'apify/actors-mcp-server:fetch-apify-docs', input: { query: 'test' } },
                apifyClient,
            ),
        );

        const { content, isError } = result as TextToolResult;
        expect(isError).toBe(true);
        expect(startSpy).not.toHaveBeenCalled();
        const joined = content.map((c) => c.text).join(' ');
        expect(joined).toContain('call-actor-widget');
        expect(joined).toContain('call-actor');
        expect(joined).toContain('actorName:toolName');
    });
});
