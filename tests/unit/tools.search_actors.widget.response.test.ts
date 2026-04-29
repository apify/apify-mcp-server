import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { searchActorsWidgetTool } from '../../src/tools/apps/search_actors_widget.js';
import type { HelperTool } from '../../src/types.js';
import type { formatActorToStructuredCard } from '../../src/utils/actor_card.js';
import { formatActorForWidget } from '../../src/utils/actor_card.js';
import { searchAndFilterActors } from '../../src/utils/actor_search.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { MOCK_STORE_ACTOR, SEARCH_KEYWORDS, stubInternalToolArgs } from './tools.search_actors.fixtures.js';

/**
 * Apps / UI mode: search-actors-widget renders an interactive UI element
 * (widget) with widgetActors in structuredContent and carries widget `_meta`
 * on both the tool definition and the response.
 */
vi.mock('../../src/utils/actor_search.js', () => ({
    searchAndFilterActors: vi.fn(),
}));

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

describe('search-actors-widget response', () => {
    beforeEach(() => {
        vi.mocked(searchAndFilterActors).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(getUserInfoCached).mockResolvedValue({ userId: null, userPlanTier: 'FREE' });
    });

    it('returns widgetActors plus widget _meta and short pointer text', async () => {
        vi.mocked(searchAndFilterActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActorsWidgetTool as HelperTool).call(stubInternalToolArgs({
            keywords: SEARCH_KEYWORDS,
            limit: 5,
            offset: 0,
        }));

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                actors: ReturnType<typeof formatActorToStructuredCard>[];
                widgetActors?: ReturnType<typeof formatActorForWidget>[];
                query: string;
                count: number;
            };
            content: { type: string; text: string }[];
            _meta?: { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown }; 'openai/widgetDescription'?: string };
        };

        expect(structuredContent.query).toBe(SEARCH_KEYWORDS);
        expect(structuredContent.count).toBe(1);
        expect(structuredContent.actors).toHaveLength(1);

        expect(structuredContent.widgetActors).toBeDefined();
        expect(structuredContent.widgetActors!.length).toBe(structuredContent.actors.length);
        expect(structuredContent.widgetActors![0]).toStrictEqual(formatActorForWidget(MOCK_STORE_ACTOR, 'FREE'));

        expect(content).toHaveLength(1);
        const { text } = content[0];
        expect(text).toContain('An interactive widget has been rendered');
        expect(text).toContain('do NOT print or summarize the Actor list');

        expect(_meta?.ui?.resourceUri).toBe(WIDGET_URIS.SEARCH_ACTORS);
        expect(_meta?.ui?.visibility).toEqual(['model', 'app']);
        expect(_meta?.ui?.csp).toBeDefined();
        expect(_meta?.['openai/widgetDescription']).toContain('1 actor');
    });

    it('returns empty widgetActors and omits widget _meta when there are no results', async () => {
        vi.mocked(searchAndFilterActors).mockResolvedValue([]);

        const result = await (searchActorsWidgetTool as HelperTool).call(stubInternalToolArgs({
            keywords: SEARCH_KEYWORDS,
            limit: 5,
            offset: 0,
        }));

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                actors: unknown[];
                query: string;
                count: number;
                widgetActors: unknown[];
            };
            content: { type: string; text: string }[];
            _meta?: unknown;
        };

        expect(structuredContent.actors).toEqual([]);
        expect(structuredContent.count).toBe(0);
        expect(structuredContent.widgetActors).toEqual([]);
        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('No Actors were found');
        expect(_meta).toBeUndefined();
    });

    it('carries widget _meta on the tool definition', () => {
        const tool = searchActorsWidgetTool as HelperTool;
        const meta = tool._meta as { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown } };
        expect(meta.ui?.resourceUri).toBe(WIDGET_URIS.SEARCH_ACTORS);
        expect(meta.ui?.visibility).toEqual(['model', 'app']);
        expect(meta.ui?.csp).toBeDefined();
    });

    it('declares a strict input schema and strips stray keys at validation time', () => {
        const tool = searchActorsWidgetTool as HelperTool;

        // Schema-level: strict shape (no extra properties allowed).
        const schema = tool.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown> };
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['keywords', 'limit', 'offset']);

        // Runtime: AJV is configured with `removeAdditional: true`, so stray keys are silently
        // stripped from the input object in place — the widget contract can't be overridden.
        const input: Record<string, unknown> = { keywords: 'web scraper', extra: 'nope' };
        const ok = tool.ajvValidate(input);
        expect(ok).toBe(true);
        expect('extra' in input).toBe(false);
    });

    it('accepts a valid keywords-only input', () => {
        const tool = searchActorsWidgetTool as HelperTool;
        const ok = tool.ajvValidate({ keywords: 'web scraper' });
        expect(ok).toBe(true);
    });
});
