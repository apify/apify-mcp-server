import { describe, expect, it } from 'vitest';

import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { getActorRunWidgetTool } from '../../src/tools/apps/get_actor_run_widget.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

/**
 * Apps / UI mode: get-actor-run-widget renders an interactive UI element (widget)
 * showing live Actor run progress. Carries widget `_meta` on both the tool definition
 * and the response. Input is strict: only `runId` is accepted.
 */

const MOCK_RUN = {
    id: 'run-widget-1',
    actId: 'actor-id-rag',
    status: 'RUNNING',
    startedAt: new Date('2026-04-20T12:00:00.000Z'),
    stats: {},
};

const MOCK_ACTOR = {
    username: 'apify',
    name: 'rag-web-browser',
};

function stubApifyClient(): InternalToolArgs['apifyClient'] {
    return {
        run: (_id: string) => ({
            get: async () => MOCK_RUN,
        }),
        actor: (_id: string) => ({
            get: async () => MOCK_ACTOR,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubArgs(args: Record<string, unknown>): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: stubApifyClient(),
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-actor-run-widget response', () => {
    it('returns structured run status and widget _meta on the response', async () => {
        const result = await (getActorRunWidgetTool as HelperTool).call(
            stubArgs({ runId: 'run-widget-1' }),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                runId: string;
                actorName?: string;
                status: string;
                startedAt: string;
            };
            content: { type: string; text: string }[];
            _meta?: { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown }; 'openai/widgetDescription'?: string };
        };

        expect(structuredContent.runId).toBe('run-widget-1');
        expect(structuredContent.actorName).toBe('apify/rag-web-browser');
        expect(structuredContent.status).toBe('RUNNING');
        expect(structuredContent.startedAt).toBe('2026-04-20T12:00:00.000Z');

        // Short pointer text, not a JSON dump.
        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('A progress widget has been rendered');
        expect(content[0].text).toContain('run-widget-1');

        // Response-level widget _meta.
        expect(_meta?.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(_meta?.ui?.visibility).toEqual(['model', 'app']);
        expect(_meta?.ui?.csp).toBeDefined();
        expect(_meta?.['openai/widgetDescription']).toContain('apify/rag-web-browser');
    });

    it('carries widget _meta on the tool definition', () => {
        const tool = getActorRunWidgetTool as HelperTool;
        const meta = tool._meta as { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown } };
        expect(meta.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(meta.ui?.visibility).toEqual(['model', 'app']);
        expect(meta.ui?.csp).toBeDefined();
    });

    it('declares a strict input schema accepting only runId', () => {
        const tool = getActorRunWidgetTool as HelperTool;

        const schema = tool.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] };
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties ?? {})).toEqual(['runId']);
        expect(schema.required).toEqual(['runId']);

        // Runtime: AJV is configured with `removeAdditional: true`, so stray keys are silently
        // stripped from the input object in place.
        const input: Record<string, unknown> = { runId: 'run-widget-1', output: true };
        const ok = tool.ajvValidate(input);
        expect(ok).toBe(true);
        expect('output' in input).toBe(false);
    });

    it('accepts a minimal runId payload', () => {
        const tool = getActorRunWidgetTool as HelperTool;
        const ok = tool.ajvValidate({ runId: 'run-widget-1' });
        expect(ok).toBe(true);
    });
});
