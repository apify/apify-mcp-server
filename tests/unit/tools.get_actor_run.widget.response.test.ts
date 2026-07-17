import { describe, expect, it } from 'vitest';

import { WIDGET_URIS } from '../../src/resources/widgets.js';
import type { RunResponse } from '../../src/tools/actors/actor_run_response.js';
import { getActorRunWidget } from '../../src/tools/widgets/get_actor_run_widget.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { stubToolCallContext } from './helpers/tool_context.js';

/**
 * Apps / UI mode: get-actor-run-widget renders an interactive UI element (widget)
 * showing live Actor run progress. Carries widget `_meta` on both the tool definition
 * and the response.
 */

const MOCK_RUN_RUNNING = {
    id: 'run-widget-1',
    actId: 'actor-id-rag',
    status: 'RUNNING',
    startedAt: new Date('2026-04-20T12:00:00.000Z'),
    stats: { runTimeSecs: 5, computeUnits: 0.01, memMaxBytes: 1024 },
    usageTotalUsd: 0.0002,
    usageUsd: { ACTOR_COMPUTE_UNITS: 0.0002 },
};

const MOCK_ACTOR = {
    username: 'apify',
    name: 'rag-web-browser',
};

function stubApifyClient(): InternalToolArgs['apifyClient'] {
    return {
        run: (_id: string) => ({
            get: async () => MOCK_RUN_RUNNING,
        }),
        actor: (_id: string) => ({
            get: async () => MOCK_ACTOR,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-actor-run-widget response', () => {
    it('returns structured content and widget _meta on the response', async () => {
        const result = await (getActorRunWidget as HelperTool).call(
            stubToolCallContext({ runId: 'run-widget-1' }, stubApifyClient()),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: RunResponse;
            content: { type: string; text: string }[];
            _meta?: {
                ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown };
                'openai/widgetDescription'?: string;
                'com.apify/ActorRun'?: { usageTotalUsd?: number; usageUsd?: unknown };
            };
        };

        expect(structuredContent.runId).toBe('run-widget-1');
        expect(structuredContent.actorId).toBe('actor-id-rag');
        expect(structuredContent.status).toBe('RUNNING');
        expect(structuredContent.startedAt).toBe('2026-04-20T12:00:00.000Z');
        expect(structuredContent.summary).toMatch(/^RUNNING for /);
        // Widget nextStep must not instruct LLM to poll — widget self-updates.
        expect(structuredContent.nextStep).toContain('Widget is rendering live progress');
        expect(structuredContent.nextStep).not.toContain('actor-runs-get');
        // content[0] mirrors structuredContent as JSON (MCP spec backwards-compat); content[1] is
        // the short widget-pointer text.
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toContain('A run widget has been rendered');
        expect(content[1].text).toContain('run-widget-1');

        // Response-level widget _meta.
        expect(_meta?.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(_meta?.ui?.visibility).toEqual(['model', 'app']);
        expect(_meta?.ui?.csp).toBeDefined();
        expect(_meta?.['openai/widgetDescription']).toContain('apify/rag-web-browser');
        // Widget _meta also carries run usage metadata (buildUsageMeta), alongside widget-specific meta.
        expect(_meta?.['com.apify/ActorRun']).toEqual({
            usageTotalUsd: 0.0002,
            usageUsd: { ACTOR_COMPUTE_UNITS: 0.0002 },
        });
    });

    it('carries widget _meta on the tool definition', () => {
        const tool = getActorRunWidget as HelperTool;
        const meta = tool._meta as { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown } };
        expect(meta.ui?.resourceUri).toBe(WIDGET_URIS.ACTOR_RUN);
        expect(meta.ui?.visibility).toEqual(['model', 'app']);
        expect(meta.ui?.csp).toBeDefined();
    });

    it('declares a strict input schema accepting runId only', () => {
        const tool = getActorRunWidget as HelperTool;

        const schema = tool.inputSchema as {
            additionalProperties?: boolean;
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties ?? {})).toEqual(['runId']);
        expect(schema.required).toEqual(['runId']);

        // Runtime: AJV is configured with `removeAdditional: true`, so stray keys are silently
        // stripped from the input object in place.
        const input: Record<string, unknown> = { runId: 'run-widget-1', waitSecs: 30 };
        const ok = tool.ajvValidate(input);
        expect(ok).toBe(true);
        expect('waitSecs' in input).toBe(false);
    });

    it('accepts a minimal runId payload', () => {
        const tool = getActorRunWidget as HelperTool;
        const ok = tool.ajvValidate({ runId: 'run-widget-1' });
        expect(ok).toBe(true);
    });
});
