import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APIFY_STORE_URL, HelperTools } from '../../src/const.js';
import { defaultSearchActors } from '../../src/tools/default/search_actors.js';
import type { HelperTool } from '../../src/types.js';
import { formatActorToStructuredCard } from '../../src/utils/actor_card.js';
import { searchAndFilterActors } from '../../src/utils/actor_search.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import { MOCK_STORE_ACTOR, SEARCH_KEYWORDS, stubInternalToolArgs } from './tools.search_actors.fixtures.js';

/**
 * Default server mode: search-actors returns markdown + structured cards for the LLM only
 * (no widgetActors, no tool _meta).
 */
vi.mock('../../src/utils/actor_search.js', () => ({
    searchAndFilterActors: vi.fn(),
}));

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

describe('search-actors without widget (defaultSearchActors)', () => {
    beforeEach(() => {
        vi.mocked(searchAndFilterActors).mockReset();
        vi.mocked(getUserInfoCached).mockReset();
        vi.mocked(getUserInfoCached).mockResolvedValue({ userId: null, userPlanTier: 'FREE' });
    });

    it('returns structured actors and markdown text; no widget payload', async () => {
        vi.mocked(searchAndFilterActors).mockResolvedValue([MOCK_STORE_ACTOR]);

        const result = await (defaultSearchActors as HelperTool).call(stubInternalToolArgs({
            keywords: SEARCH_KEYWORDS,
            limit: 5,
            offset: 0,
        }));

        const { structuredContent, content } = result as {
            structuredContent: {
                actors: ReturnType<typeof formatActorToStructuredCard>[];
                query: string;
                count: number;
                instructions?: string;
                widgetActors?: unknown;
            };
            content: { type: string; text: string }[];
            _meta?: unknown;
        };

        expect(structuredContent.widgetActors).toBeUndefined();
        expect(structuredContent.query).toBe(SEARCH_KEYWORDS);
        expect(structuredContent.count).toBe(1);
        expect(structuredContent.actors).toHaveLength(1);
        expect(structuredContent.actors[0]).toStrictEqual(formatActorToStructuredCard(MOCK_STORE_ACTOR));
        expect(structuredContent.instructions).toContain(HelperTools.ACTOR_GET_DETAILS);

        expect(content).toHaveLength(1);
        expect((result as { _meta?: unknown })._meta).toBeUndefined();

        const { text } = content[0];
        expect(text).toContain('# Search results:');
        expect(text).toContain(SEARCH_KEYWORDS);
        expect(text).toContain('Number of Actors found:** 1');
        expect(text).toContain('# Actors:');
        expect(text).toContain(HelperTools.ACTOR_GET_DETAILS);
        expect(text).toContain(`## [${MOCK_STORE_ACTOR.title}](${APIFY_STORE_URL}/apify/web-scraper)`);
        expect(text).toContain('`apify/web-scraper`');
        expect(text).not.toContain('do NOT print or summarize');
    });

    it('returns empty structured content and retry instructions when no actors match', async () => {
        vi.mocked(searchAndFilterActors).mockResolvedValue([]);

        const result = await (defaultSearchActors as HelperTool).call(stubInternalToolArgs({
            keywords: SEARCH_KEYWORDS,
            limit: 5,
            offset: 0,
        }));

        const { structuredContent, content } = result as {
            structuredContent: {
                actors: unknown[];
                query: string;
                count: number;
                instructions: string;
                widgetActors?: unknown;
            };
            content: { type: string; text: string }[];
        };

        expect(structuredContent.widgetActors).toBeUndefined();
        expect(structuredContent.actors).toEqual([]);
        expect(structuredContent.count).toBe(0);
        expect(structuredContent.query).toBe(SEARCH_KEYWORDS);
        expect(structuredContent.instructions).toContain('broader, more generic keywords');

        expect(content).toHaveLength(1);
        expect(content[0].text).toContain('No Actors were found');
        expect(content[0].text).toContain(SEARCH_KEYWORDS);
    });
});
