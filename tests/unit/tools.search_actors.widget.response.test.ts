import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { SEARCH_RESULTS_RUN_GUIDANCE } from '../../src/tools/actors/actor_run_availability.js';
import { searchActorsWidget } from '../../src/tools/widgets/search_actors_widget.js';
import type { ActorStoreList, HelperTool } from '../../src/types.js';
import type { formatActorToStructuredCard } from '../../src/utils/actor_card.js';
import { formatActorForWidget } from '../../src/utils/actor_card.js';
import { searchAgentSafeActors } from '../../src/utils/actor_search.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { mockUserInfo } from './helpers/tool_context.js';
import { MOCK_STORE_ACTOR, SEARCH_KEYWORDS, stubInternalToolArgs } from './tools.search_actors.fixtures.js';

/**
 * Apps / UI mode: search-actors-widget renders an interactive UI element
 * (widget) with widgetActors in structuredContent and carries widget `_meta`
 * on both the tool definition and the response.
 */
vi.mock('../../src/utils/actor_search.js', () => ({
    searchAgentSafeActors: vi.fn(),
}));

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

describe('search-actors-widget response', () => {
    beforeEach(() => {
        vi.mocked(searchAgentSafeActors).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));
    });

    it('returns widgetActors plus widget _meta and short pointer text', async () => {
        vi.mocked(searchAgentSafeActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (searchActorsWidget as HelperTool).call(
            stubInternalToolArgs({
                keywords: SEARCH_KEYWORDS,
                limit: 5,
                offset: 0,
            }),
        );

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                actors: ReturnType<typeof formatActorToStructuredCard>[];
                widgetActors?: ReturnType<typeof formatActorForWidget>[];
                query: string;
                count: number;
            };
            content: { type: string; text: string }[];
            _meta?: {
                ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown };
                'openai/widgetDescription'?: string;
            };
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
        vi.mocked(searchAgentSafeActors).mockResolvedValue([]);

        const result = await (searchActorsWidget as HelperTool).call(
            stubInternalToolArgs({
                keywords: SEARCH_KEYWORDS,
                limit: 5,
                offset: 0,
            }),
        );

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

    describe('run guidance for Actors the session cannot run', () => {
        const SECOND_ACTOR = {
            ...MOCK_STORE_ACTOR,
            id: 'actor-id-2',
            name: 'web-scraper-2',
            title: 'Web Scraper 2',
        } as ActorStoreList;
        const THIRD_ACTOR = {
            ...MOCK_STORE_ACTOR,
            id: 'actor-id-3',
            name: 'web-scraper-3',
            title: 'Web Scraper 3',
        } as ActorStoreList;

        async function callWithLoadedTools(loadedToolNames: string[], actors: ActorStoreList[] = [MOCK_STORE_ACTOR]) {
            vi.mocked(searchAgentSafeActors).mockResolvedValue(actors);
            const result = await (searchActorsWidget as HelperTool).call({
                ...stubInternalToolArgs({ keywords: SEARCH_KEYWORDS, limit: 5, offset: 0 }),
                loadedToolNames,
            });
            return result as {
                structuredContent: Record<string, unknown>;
                content: { type: string; text: string }[];
            };
        }

        it('omits the guidance when call-actor is loaded', async () => {
            const { content } = await callWithLoadedTools([HELPER_TOOLS.ACTOR_CALL]);

            expect(content).toHaveLength(1);
            expect(content[0].text).not.toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });

        it('omits the guidance when only call-actor-widget is loaded', async () => {
            const { content } = await callWithLoadedTools([HELPER_TOOLS.ACTOR_CALL_WIDGET]);

            expect(content[0].text).not.toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });

        it('omits the guidance when every result has its own dedicated tool', async () => {
            const { content } = await callWithLoadedTools(
                [actorNameToToolName('apify/web-scraper'), actorNameToToolName('apify/web-scraper-2')],
                [MOCK_STORE_ACTOR, SECOND_ACTOR],
            );

            expect(content[0].text).not.toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });

        it('appends the guidance to the single text item when no result can be run', async () => {
            const { content, structuredContent } = await callWithLoadedTools([]);

            expect(content).toHaveLength(1);
            expect(content[0].text).toContain(SEARCH_RESULTS_RUN_GUIDANCE);
            // Widget structured content stays on its declared schema — text-only guidance.
            expect(structuredContent.instructions).toBeUndefined();
        });

        it('appends the guidance when only some results can be run', async () => {
            const { content } = await callWithLoadedTools(
                [actorNameToToolName('apify/web-scraper')],
                [MOCK_STORE_ACTOR, SECOND_ACTOR],
            );

            expect(content[0].text).toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });

        // The widget handler runs its own per-result runnability check, so it gets the same
        // per-Actor pin as the base tool: one three-result fixture, the middle result's dedicated
        // tool absent then present. `call-actor-widget` cannot appear in the guidance-present case —
        // it makes every Actor of the session runnable, so no per-Actor miss can survive alongside it.
        it('appends the guidance when only the middle result has no dedicated tool', async () => {
            const { content } = await callWithLoadedTools(
                [actorNameToToolName('apify/web-scraper'), actorNameToToolName('apify/web-scraper-3')],
                [MOCK_STORE_ACTOR, SECOND_ACTOR, THIRD_ACTOR],
            );

            expect(content).toHaveLength(1);
            expect(content[0].text).toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });

        it('omits the guidance once the middle result has its dedicated tool loaded too', async () => {
            const { content } = await callWithLoadedTools(
                [
                    actorNameToToolName('apify/web-scraper'),
                    actorNameToToolName('apify/web-scraper-3'),
                    actorNameToToolName('apify/web-scraper-2'),
                ],
                [MOCK_STORE_ACTOR, SECOND_ACTOR, THIRD_ACTOR],
            );

            expect(content).toHaveLength(1);
            expect(content[0].text).not.toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });

        it('omits the guidance when call-actor-widget covers the results without a dedicated tool', async () => {
            const { content } = await callWithLoadedTools(
                [HELPER_TOOLS.ACTOR_CALL_WIDGET, actorNameToToolName('apify/web-scraper')],
                [MOCK_STORE_ACTOR, SECOND_ACTOR, THIRD_ACTOR],
            );

            expect(content[0].text).not.toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });

        it('omits the guidance when no Actors are found', async () => {
            const { content } = await callWithLoadedTools([], []);

            expect(content[0].text).not.toContain(SEARCH_RESULTS_RUN_GUIDANCE);
        });
    });

    it('carries widget _meta on the tool definition', () => {
        const tool = searchActorsWidget as HelperTool;
        const meta = tool._meta as { ui?: { resourceUri?: string; visibility?: readonly string[]; csp?: unknown } };
        expect(meta.ui?.resourceUri).toBe(WIDGET_URIS.SEARCH_ACTORS);
        expect(meta.ui?.visibility).toEqual(['model', 'app']);
        expect(meta.ui?.csp).toBeDefined();
    });

    it('declares a strict input schema and strips stray keys at validation time', () => {
        const tool = searchActorsWidget as HelperTool;

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
        const tool = searchActorsWidget as HelperTool;
        const ok = tool.ajvValidate({ keywords: 'web scraper' });
        expect(ok).toBe(true);
    });
});
