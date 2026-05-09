import { describe, expect, it } from 'vitest';

import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { getActorRunWidgetTool } from '../../src/tools/apps/get_actor_run_widget.js';
import type { CanonicalRunResponse } from '../../src/tools/core/get_actor_run_common.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

/**
 * Apps / UI mode: get-actor-run-widget renders an interactive UI element (widget)
 * showing live Actor run progress. Carries widget `_meta` on both the tool definition
 * and the response. Returns the v4 canonical run-response shape.
 */

const MOCK_RUN_RUNNING = {
    id: 'run-widget-1',
    actId: 'actor-id-rag',
    status: 'RUNNING',
    startedAt: new Date('2026-04-20T12:00:00.000Z'),
    stats: { runTimeSecs: 5, computeUnits: 0.01, memMaxBytes: 1024 },
};

const MOCK_ACTOR = {
    username: 'apify',
    name: 'rag-web-browser',
};

function stubApifyClient(run: unknown): InternalToolArgs['apifyClient'] {
    return {
        run: (_id: string) => ({
            get: async () => run,
            // Honored only when waitSecs > 0; tests below pass waitSecs: 0 to short-circuit.
            waitForFinish: async () => run,
        }),
        actor: (_id: string) => ({
            get: async () => MOCK_ACTOR,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubArgs(args: Record<string, unknown>, run: unknown = MOCK_RUN_RUNNING): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: stubApifyClient(run),
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-actor-run-widget response', () => {
    it('returns canonical v4 structured content and widget _meta on the response', async () => {
        const result = await (getActorRunWidgetTool as HelperTool).call(
            stubArgs({ runId: 'run-widget-1', waitSecs: 0 }),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: CanonicalRunResponse;
            content: { type: string; text: string }[];
            _meta?: { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown }; 'openai/widgetDescription'?: string };
        };

        expect(structuredContent.responseVersion).toBe('v4');
        expect(structuredContent.runId).toBe('run-widget-1');
        expect(structuredContent.actorId).toBe('actor-id-rag');
        expect(structuredContent.actorName).toBe('apify/rag-web-browser');
        expect(structuredContent.status).toBe('RUNNING');
        expect(structuredContent.startedAt).toBe('2026-04-20T12:00:00.000Z');
        expect(structuredContent.summary).toMatch(/^RUNNING for /);
        expect(structuredContent.nextStep).toContain('run-widget-1');
        // Widget text remains a short pointer, not a JSON dump.
        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('A run widget has been rendered');
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

    it('declares a strict input schema accepting runId and optional waitSecs', () => {
        const tool = getActorRunWidgetTool as HelperTool;

        const schema = tool.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] };
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['runId', 'waitSecs']);
        // Widget args have a Zod `.default(0)` on `waitSecs`, so JSON Schema lists it as required.
        // AJV (with `useDefaults: true`) injects the default before required-check, so callers
        // can still omit it — see "accepts a minimal runId payload" below.
        expect(schema.required).toEqual(['runId', 'waitSecs']);

        // Runtime: AJV is configured with `removeAdditional: true`, so stray keys are silently
        // stripped from the input object in place.
        const input: Record<string, unknown> = { runId: 'run-widget-1', output: true };
        const ok = tool.ajvValidate(input);
        expect(ok).toBe(true);
        expect('output' in input).toBe(false);
    });

    it('rejects waitSecs above the cap', () => {
        const tool = getActorRunWidgetTool as HelperTool;
        const ok = tool.ajvValidate({ runId: 'run-widget-1', waitSecs: 46 });
        expect(ok).toBe(false);
    });

    it('accepts a minimal runId payload', () => {
        const tool = getActorRunWidgetTool as HelperTool;
        const ok = tool.ajvValidate({ runId: 'run-widget-1' });
        expect(ok).toBe(true);
    });
});
