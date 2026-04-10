import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { WIDGET_URIS } from '../../src/resources/widgets.js';
import { openaiSearchActors } from '../../src/tools/openai/search_actors.js';
import type { HelperTool } from '../../src/types.js';
import { formatActorForWidget, formatActorToStructuredCard } from '../../src/utils/actor_card.js';
import { searchAndFilterActors } from '../../src/utils/actor_search.js';
import { MOCK_STORE_ACTOR, SEARCH_KEYWORDS, stubInternalToolArgs } from './tools.search_actors.fixtures.js';

/**
 * OpenAI / UI mode: search-actors adds widgetActors and tool _meta for the Actor Search widget.
 */
vi.mock('../../src/utils/actor_search.js', () => ({
    searchAndFilterActors: vi.fn(),
}));

describe('search-actors with widget (openaiSearchActors)', () => {
    beforeEach(() => {
        vi.mocked(searchAndFilterActors).mockReset();
    });

    it('returns widgetActors, _meta, and OpenAI-specific instructions and text', async () => {
        vi.mocked(searchAndFilterActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (openaiSearchActors as HelperTool).call(stubInternalToolArgs({
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
                instructions?: string;
            };
            content: { type: string; text: string }[];
            _meta?: { ui?: { resourceUri?: string }; 'openai/widgetDescription'?: string };
        };

        expect(structuredContent.query).toBe(SEARCH_KEYWORDS);
        expect(structuredContent.count).toBe(1);
        expect(structuredContent.actors).toHaveLength(1);
        expect(structuredContent.actors[0]).toStrictEqual(formatActorToStructuredCard(MOCK_STORE_ACTOR));

        expect(structuredContent.widgetActors).toBeDefined();
        expect(structuredContent.widgetActors!.length).toBe(structuredContent.actors.length);
        expect(structuredContent.widgetActors![0]).toStrictEqual(formatActorForWidget(MOCK_STORE_ACTOR));

        expect(structuredContent.instructions).toContain(HelperTools.ACTOR_GET_DETAILS_INTERNAL);

        expect(content).toHaveLength(1);
        const { text } = content[0];
        expect(text).toContain('do NOT print or summarize the Actor list');
        expect(text).toContain(HelperTools.ACTOR_GET_DETAILS_INTERNAL);
        expect(text).toContain('Choosing the right details tool:');

        expect(_meta?.ui?.resourceUri).toBe(WIDGET_URIS.SEARCH_ACTORS);
        expect(_meta?.['openai/widgetDescription']).toContain('1 actors');
    });

    it('omits widget _meta when there are no results (same empty payload as default)', async () => {
        vi.mocked(searchAndFilterActors).mockResolvedValue([]);

        const result = await (openaiSearchActors as HelperTool).call(stubInternalToolArgs({
            keywords: SEARCH_KEYWORDS,
            limit: 5,
            offset: 0,
        }));

        const { structuredContent, content, _meta } = result as {
            structuredContent: {
                actors: unknown[];
                query: string;
                count: number;
                instructions: string;
                widgetActors?: unknown;
            };
            content: { type: string; text: string }[];
            _meta?: unknown;
        };

        expect(structuredContent.actors).toEqual([]);
        expect(structuredContent.count).toBe(0);
        expect(structuredContent.widgetActors).toBeUndefined();
        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('No Actors were found');
        expect(_meta).toBeUndefined();
    });
});
